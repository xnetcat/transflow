import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import crypto from "crypto";
import type { TransflowConfig, UserContext } from "../core/types";
import {
  extractUserContext,
  generateUserPath,
  validateUserAccess,
  validateContentType,
  validateFileSize,
  AuthenticationError,
  AuthorizationError,
} from "./auth";

export interface ApiRequest {
  method?: string;
  body?: Record<string, unknown>;
  headers?: Record<string, string | string[] | undefined>;
  cookies?: Record<string, string>;
}

export interface ApiResponse {
  status: (code: number) => ApiResponse;
  json: (body: unknown) => void;
  setHeader: (name: string, value: string) => void;
}

export function createUploadHandler(cfg: TransflowConfig) {
  const s3 = new S3Client({ region: cfg.region });
  return async function handler(req: ApiRequest, res: ApiResponse) {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    // Extract and validate user context
    let userContext: UserContext | null = null;
    try {
      userContext = await extractUserContext(req, cfg);
    } catch (error) {
      if (error instanceof AuthenticationError) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }
      throw error;
    }
    const isBatch = Array.isArray((req.body as any)?.files);
    const filename = isBatch ? undefined : String(req.body?.filename ?? "");
    const contentType = !isBatch
      ? typeof req.body?.contentType === "string"
        ? (req.body?.contentType as string)
        : "application/octet-stream"
      : undefined;
    const templateId =
      typeof req.body?.template === "string"
        ? (req.body?.template as string)
        : typeof req.body?.templateId === "string"
        ? (req.body?.templateId as string)
        : "";
    const fields =
      req.body?.fields && typeof req.body.fields === "object"
        ? (req.body.fields as Record<string, unknown>)
        : undefined;
    const fileSize =
      typeof req.body?.fileSize === "number" ? req.body.fileSize : undefined;
    const fileHash =
      typeof (req.body as any)?.fileHash === "string"
        ? ((req.body as any).fileHash as string)
        : undefined;

    // Validate required fields
    if (!isBatch && !filename) {
      res.status(400).json({ error: "filename required" });
      return;
    }

    // Enforce MD5 hash requirement for deterministic assembly_id
    if (!isBatch && !fileHash) {
      res
        .status(400)
        .json({ error: "fileHash required for single file upload" });
      return;
    }

    // Validate content type if restrictions are configured
    if (
      contentType &&
      !validateContentType(contentType, cfg.s3.allowedContentTypes)
    ) {
      res.status(400).json({
        error: "File type not allowed",
        allowedTypes: cfg.s3.allowedContentTypes,
      });
      return;
    }

    // Validate file size if specified
    if (fileSize && !validateFileSize(fileSize, cfg.s3.maxFileSize)) {
      res.status(400).json({
        error: "File too large",
        maxSize: cfg.s3.maxFileSize,
      });
      return;
    }
    const uploadId = crypto.randomUUID();
    const branchHeader = req.headers?.["x-transflow-branch"];
    const branch =
      (typeof branchHeader === "string"
        ? branchHeader
        : Array.isArray(branchHeader)
        ? branchHeader[0]
        : undefined) ||
      process.env.TRANSFLOW_BRANCH ||
      "main";

    // Generate secure paths based on user isolation settings
    let baseKey: string;
    if (cfg.s3.userIsolation && userContext) {
      baseKey = generateUserPath(userContext.userId, branch, uploadId);
    } else {
      baseKey = `uploads/${branch}/${uploadId}`;
    }

    // Compute assembly_id = sha256(md5(file)+templateId+userId)
    function computeAssemblyId(singleHash?: string, hashes?: string[]) {
      const userId = userContext?.userId || "anonymous";
      const input = singleHash
        ? `${singleHash}:${templateId}:${userId}`
        : `${(hashes || []).sort().join(",")}:${templateId}:${userId}`;
      return crypto.createHash("sha256").update(input).digest("hex");
    }

    // Bucket is selected by template/frontend contract; if using shared config, prefer cfg.s3.uploadBucket
    const bucket =
      cfg.s3.uploadBucket ||
      (cfg.s3.mode === "bucket" ? `${cfg.project}-${branch}` : "");
    if (!isBatch) {
      const key = `${baseKey}/${filename}`;

      // Validate user access to this path
      if (
        cfg.s3.userIsolation &&
        userContext &&
        !validateUserAccess(userContext.userId, key, "write")
      ) {
        res.status(403).json({ error: "Access denied to this path" });
        return;
      }

      const assemblyId = computeAssemblyId(fileHash);

      const metadata: Record<string, string> = {
        templateid: templateId,
        uploadid: uploadId,
        assemblyid: assemblyId,
        "content-type": contentType || "application/octet-stream",
        ...(fields
          ? { fields: Buffer.from(JSON.stringify(fields)).toString("base64") }
          : {}),
      };

      // Add user context to metadata for Lambda processing
      if (userContext) {
        metadata.userid = userContext.userId;
        if (userContext.permissions && userContext.permissions.length > 0) {
          metadata.permissions = JSON.stringify(userContext.permissions);
        }
      }

      const put = new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        ContentType: contentType,
        Metadata: metadata,
      });

      // Add security conditions to pre-signed URL
      const conditions: Record<string, any> = {
        "Content-Type": contentType,
      };

      if (cfg.s3.maxFileSize) {
        conditions["content-length-range"] = [0, cfg.s3.maxFileSize];
      }

      const presignedUrl = await getSignedUrl(s3, put, {
        expiresIn: 3600,
        // Note: Advanced conditions require S3 POST policy, not PUT presigned URLs
        // For maximum security, consider switching to POST policy with conditions
      });

      res.status(200).json({
        uploadId,
        assembly_id: assemblyId,
        presignedUrl,
        key,
        bucket,
        user: userContext ? { userId: userContext.userId } : undefined,
      });
      return;
    }

    // Batch mode: issue multiple pre-signed URLs for provided files
    const files = (req.body as any).files as Array<{
      filename: string;
      contentType?: string;
      fileSize?: number;
      dir?: string; // optional subdir within uploadId
      md5hash?: string;
    }>;
    if (!Array.isArray(files) || files.length === 0) {
      res.status(400).json({ error: "files array required" });
      return;
    }

    const results: Array<{
      filename: string;
      key: string;
      presignedUrl: string;
      bucket: string;
    }> = [];

    const md5s: string[] = [];

    // Validate that all batch files have md5hash for deterministic assembly_id
    for (const f of files) {
      if (!f.md5hash) {
        res.status(400).json({
          error: `md5hash required for all files in batch upload. Missing for: ${f.filename}`,
        });
        return;
      }
    }

    // Collect all hashes first for deterministic assembly_id
    for (const f of files) {
      if (f.md5hash) md5s.push(f.md5hash);
    }

    // Compute assembly_id once for the entire batch
    const batchAssemblyId = computeAssemblyId(undefined, md5s);

    for (const f of files) {
      const safeName = String(f.filename || "");
      if (!safeName) continue;

      const ct = typeof f.contentType === "string" ? f.contentType : undefined;
      const fSize = typeof f.fileSize === "number" ? f.fileSize : undefined;

      // Validate content type for each file
      if (ct && !validateContentType(ct, cfg.s3.allowedContentTypes)) {
        res.status(400).json({
          error: `File type not allowed for ${safeName}`,
          allowedTypes: cfg.s3.allowedContentTypes,
        });
        return;
      }

      // Validate file size for each file
      if (fSize && !validateFileSize(fSize, cfg.s3.maxFileSize)) {
        res.status(400).json({
          error: `File too large: ${safeName}`,
          maxSize: cfg.s3.maxFileSize,
        });
        return;
      }

      const dir = f.dir ? String(f.dir).replace(/^\/+|\/+$/g, "") + "/" : "";
      const key = `${baseKey}/${dir}${safeName}`;

      // Validate user access to this path
      if (
        cfg.s3.userIsolation &&
        userContext &&
        !validateUserAccess(userContext.userId, key, "write")
      ) {
        res
          .status(403)
          .json({ error: `Access denied to path for ${safeName}` });
        return;
      }

      const metadata: Record<string, string> = {
        templateid: templateId,
        uploadid: uploadId,
        assemblyid: batchAssemblyId,
        ...(fields
          ? { fields: Buffer.from(JSON.stringify(fields)).toString("base64") }
          : {}),
      };

      // Add user context to metadata
      if (userContext) {
        metadata.userid = userContext.userId;
        if (userContext.permissions && userContext.permissions.length > 0) {
          metadata.permissions = JSON.stringify(userContext.permissions);
        }
      }

      const put = new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        ContentType: ct,
        Metadata: metadata,
      });
      const presignedUrl = await getSignedUrl(s3, put, { expiresIn: 3600 });
      results.push({ filename: safeName, key, presignedUrl, bucket });
    }

    res.status(200).json({
      uploadId,
      assembly_id: batchAssemblyId,
      baseKey,
      bucket,
      files: results,
      user: userContext ? { userId: userContext.userId } : undefined,
    });
  };
}

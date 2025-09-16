import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import crypto from "crypto";
import type { TransflowConfig } from "../core/types";
import { sanitizeBranch, computeTmpBucketName } from "../core/config";
import { validateContentType, validateFileSize } from "./auth";

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
  const ddb = cfg.dynamoDb?.tableName
    ? DynamoDBDocumentClient.from(new DynamoDBClient({ region: cfg.region }))
    : null;

  return async function handler(req: ApiRequest, res: ApiResponse) {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    // Generate unguessable assembly_id upfront (crypto-random)
    const assemblyId = crypto.randomBytes(32).toString("hex");
    const uploadId = crypto.randomUUID();

    // Derive branch from environment only; default to "main" if unset
    const rawBranch = process.env.TRANSFLOW_BRANCH || "main";
    const branch = sanitizeBranch(rawBranch);

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

    // Validate required fields
    if (!isBatch && !filename) {
      res.status(400).json({ error: "filename required" });
      return;
    }

    if (!templateId) {
      res.status(400).json({ error: "template required" });
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

    // Use assembly_id in the S3 key structure for easy lookup
    const baseKey = `uploads/${branch}/${assemblyId}`;

    // Always upload to tmp bucket
    const bucket = computeTmpBucketName(cfg.project, cfg.region);

    if (!isBatch) {
      const key = `${baseKey}/${filename}`;

      const put = new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        ContentType: contentType,
        Metadata: {
          "assembly-id": assemblyId,
          "upload-id": uploadId,
          "template-id": templateId,
          branch: branch,
          filename: filename,
        },
      });

      const presignedUrl = await getSignedUrl(s3, put, {
        expiresIn: 3600,
      });

      // Create initial DynamoDB record for this assembly
      if (ddb && cfg.dynamoDb?.tableName) {
        const nowIso = new Date().toISOString();

        await ddb.send(
          new PutCommand({
            TableName: cfg.dynamoDb.tableName,
            Item: {
              assembly_id: assemblyId,
              message: "Upload pending",
              project: cfg.project,
              branch,
              template_id: templateId,
              uploads: [
                {
                  id: uploadId,
                  name: filename,
                  basename: filename.replace(/\.[^.]+$/, ""),
                  ext: filename.split(".").pop() || "",
                  size: fileSize || 0,
                  mime: contentType,
                  field: "file",
                },
              ],
              results: {},
              bytes_expected: fileSize || 0,
              created_at: nowIso,
              updated_at: nowIso,
            },
          })
        );
      }

      res.status(200).json({
        assembly_id: assemblyId,
        upload_id: uploadId,
        presigned_url: presignedUrl,
      });
      return;
    }

    // Batch mode: issue multiple pre-signed URLs for provided files
    const files = (req.body as any).files as Array<{
      filename: string;
      contentType?: string;
      fileSize?: number;
      dir?: string; // optional subdir within uploadId
    }>;
    if (!Array.isArray(files) || files.length === 0) {
      res.status(400).json({ error: "files array required" });
      return;
    }

    const results: Array<{
      filename: string;
      presigned_url: string;
    }> = [];

    const uploadRecords: Array<{
      id: string;
      name: string;
      basename: string;
      ext: string;
      size: number;
      mime?: string;
      field: string;
    }> = [];

    let totalBytes = 0;

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

      const put = new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        ContentType: ct,
        Metadata: {
          "assembly-id": assemblyId,
          "upload-id": uploadId,
          "template-id": templateId,
          branch: branch,
          filename: safeName,
        },
      });

      const presignedUrl = await getSignedUrl(s3, put, { expiresIn: 3600 });
      results.push({
        filename: safeName,
        presigned_url: presignedUrl,
      });

      const fileUploadId = crypto.randomUUID();
      uploadRecords.push({
        id: fileUploadId,
        name: safeName,
        basename: safeName.replace(/\.[^.]+$/, ""),
        ext: safeName.split(".").pop() || "",
        size: fSize || 0,
        mime: ct,
        field: "files",
      });

      totalBytes += fSize || 0;
    }

    // Create initial DynamoDB record for batch upload
    if (ddb && cfg.dynamoDb?.tableName) {
      const nowIso = new Date().toISOString();

      await ddb.send(
        new PutCommand({
          TableName: cfg.dynamoDb.tableName,
          Item: {
            assembly_id: assemblyId,
            message: "Upload pending",
            project: cfg.project,
            branch,
            template_id: templateId,
            uploads: uploadRecords,
            results: {},
            bytes_expected: totalBytes,
            created_at: nowIso,
            updated_at: nowIso,
          },
        })
      );
    }

    res.status(200).json({
      assembly_id: assemblyId,
      upload_id: uploadId,
      files: results,
    });
  };
}

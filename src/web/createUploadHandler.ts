import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import crypto from "crypto";
import type { TransflowConfig } from "../core/types";

export interface ApiRequest {
  method?: string;
  body?: Record<string, unknown>;
  headers?: Record<string, string | string[] | undefined>;
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
    const isBatch = Array.isArray((req.body as any)?.files);
    const filename = isBatch
      ? undefined
      : String(req.body?.filename ?? "");
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
    if (!isBatch && !filename) {
      res.status(400).json({ error: "filename required" });
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
    const baseKey = `uploads/${branch}/${uploadId}`;
    const bucket =
      cfg.s3.mode === "prefix"
        ? (cfg.s3.uploadBucket as string)
        : `${cfg.project}-${branch}`;
    if (!isBatch) {
      const key = `${baseKey}/${filename}`;
      const put = new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        ContentType: contentType,
        Metadata: {
          templateid: templateId,
          uploadid: uploadId,
          "content-type": contentType,
          ...(fields
            ? { fields: Buffer.from(JSON.stringify(fields)).toString("base64") }
            : {}),
        },
      });
      const presignedUrl = await getSignedUrl(s3, put, { expiresIn: 3600 });
      res.status(200).json({
        uploadId,
        presignedUrl,
        channel: `upload:${uploadId}`,
        key,
        bucket,
      });
      return;
    }

    // Batch mode: issue multiple pre-signed URLs for provided files
    const files = (req.body as any).files as Array<{
      filename: string;
      contentType?: string;
      dir?: string; // optional subdir within uploadId
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
    for (const f of files) {
      const safeName = String(f.filename || "");
      if (!safeName) continue;
      const ct = typeof f.contentType === "string" ? f.contentType : undefined;
      const dir = f.dir ? String(f.dir).replace(/^\/+|\/+$/g, "") + "/" : "";
      const key = `${baseKey}/${dir}${safeName}`;
      const put = new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        ContentType: ct,
        Metadata: {
          templateid: templateId,
          uploadid: uploadId,
          ...(fields
            ? { fields: Buffer.from(JSON.stringify(fields)).toString("base64") }
            : {}),
        },
      });
      const presignedUrl = await getSignedUrl(s3, put, { expiresIn: 3600 });
      results.push({ filename: safeName, key, presignedUrl, bucket });
    }
    res.status(200).json({
      uploadId,
      channel: `upload:${uploadId}`,
      baseKey,
      bucket,
      files: results,
    });
  };
}

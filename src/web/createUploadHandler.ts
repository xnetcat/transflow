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
    const filename = String(req.body?.filename ?? "");
    const contentType =
      typeof req.body?.contentType === "string"
        ? (req.body?.contentType as string)
        : "application/octet-stream";
    const templateId =
      typeof req.body?.templateId === "string"
        ? (req.body?.templateId as string)
        : "";
    if (!filename) {
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
    const key = `uploads/${branch}/${uploadId}/${filename}`;
    const bucket =
      cfg.s3.mode === "prefix"
        ? (cfg.s3.uploadBucket as string)
        : `${cfg.project}-${branch}`;
    const put = new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      ContentType: contentType,
      Metadata: { templateid: templateId, uploadid: uploadId },
    });
    const presignedUrl = await getSignedUrl(s3, put, { expiresIn: 3600 });
    res.status(200).json({
      uploadId,
      presignedUrl,
      channel: `upload:${uploadId}`,
      key,
      bucket,
    });
  };
}

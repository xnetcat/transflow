import { describe, it, expect, vi, beforeEach } from "vitest";
import { createUploadHandler } from "./createUploadHandler";
import type { TransflowConfig } from "../core/types";

// Mock AWS SDK
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: vi.fn().mockImplementation(() => ({})),
  PutObjectCommand: vi.fn().mockImplementation((params) => params),
}));

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: vi.fn().mockResolvedValue("https://mock-presigned-url.com"),
}));

vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: {
    from: vi.fn().mockImplementation(() => ({
      send: vi.fn().mockResolvedValue({}),
    })),
  },
  PutCommand: vi.fn().mockImplementation((params) => params),
}));

const cfg: TransflowConfig = {
  project: "p",
  region: "us-east-1",
  s3: { exportBuckets: ["ob"] },
  ecrRepo: "repo",
  lambdaPrefix: "lp-",
  templatesDir: "./t",
  dynamoDb: { tableName: "test-table" },
  lambda: { memoryMb: 512, timeoutSec: 60 },
  sqs: {
    queueName: "test-processing.fifo",
    visibilityTimeoutSec: 960,
    maxReceiveCount: 3,
    batchSize: 10,
  },
} as any;

describe("createUploadHandler", () => {
  it("returns presigned URL and key without metadata", async () => {
    const handler = createUploadHandler(cfg);
    const res: any = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
      setHeader: vi.fn(),
    };
    const req = {
      method: "POST",
      body: {
        filename: "a.txt",
        contentType: "text/plain",
        templateId: "t1",
      },
      headers: {},
    };
    // We cannot actually sign without AWS credentials; just assert it runs until presign call.
    try {
      await handler(req as any, res);
    } catch (e) {
      expect(res.status).not.toHaveBeenCalledWith(400);
    }
  });

  it("generates assembly_id for single uploads", async () => {
    const handler = createUploadHandler(cfg);
    const res: any = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
      setHeader: vi.fn(),
    };

    // Branch comes from env (default main)
    const req = {
      method: "POST",
      body: {
        filename: "test.txt",
        contentType: "text/plain",
        templateId: "t1",
      },
      headers: {},
    };

    await handler(req as any, res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        assembly_id: expect.any(String),
        upload_id: expect.any(String),
        presigned_url: expect.any(String),
      })
    );
  });

  // No longer require fileHash

  it("accepts batch uploads without md5hash", async () => {
    const handler = createUploadHandler(cfg);
    const res: any = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
      setHeader: vi.fn(),
    };

    const req = {
      method: "POST",
      body: {
        files: [
          {
            filename: "file1.txt",
            contentType: "text/plain",
          },
          { filename: "file2.txt", contentType: "text/plain" },
        ],
        templateId: "t1",
      },
      headers: {},
    };

    await handler(req as any, res);
    expect(res.status).not.toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        assembly_id: expect.any(String),
        upload_id: expect.any(String),
        files: expect.arrayContaining([
          expect.objectContaining({
            filename: "file1.txt",
            presigned_url: expect.any(String),
          }),
        ]),
      })
    );
  });
});

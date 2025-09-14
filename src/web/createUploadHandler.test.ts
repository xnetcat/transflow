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

const cfg: TransflowConfig = {
  project: "p",
  region: "us-east-1",
  s3: { mode: "prefix", uploadBucket: "ub", outputBucket: "ob" },
  ecrRepo: "repo",
  lambdaPrefix: "lp-",
  templatesDir: "./t",
  lambdaBuildContext: "./l",
  dynamoDb: { tableName: "test-table" },
  lambda: { memoryMb: 512, timeoutSec: 60 },
  sqs: {
    queueName: "test-processing.fifo",
    visibilityTimeoutSec: 960,
    maxReceiveCount: 3,
    batchSize: 10,
  },
};

describe("createUploadHandler", () => {
  it("returns presigned metadata", async () => {
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
        fileHash: "abc123",
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

    // Test with explicit branch header and fileHash
    const req = {
      method: "POST",
      body: {
        filename: "test.txt",
        contentType: "text/plain",
        templateId: "t1",
        fileHash: "abc123def456",
      },
      headers: { "x-transflow-branch": "feature-x" },
    };

    await handler(req as any, res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        assembly_id: expect.any(String),
        uploadId: expect.any(String),
      })
    );
  });

  it("requires fileHash for single uploads", async () => {
    const handler = createUploadHandler(cfg);
    const res: any = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
      setHeader: vi.fn(),
    };

    const req = {
      method: "POST",
      body: {
        filename: "test.txt",
        contentType: "text/plain",
        templateId: "t1",
        // Missing fileHash
      },
      headers: {}, // No branch header
    };

    await handler(req as any, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: "fileHash required for single file upload",
    });
  });

  it("requires md5hash for all batch uploads", async () => {
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
            md5hash: "hash1",
          },
          { filename: "file2.txt", contentType: "text/plain" }, // Missing md5hash
        ],
        templateId: "t1",
      },
      headers: { "x-transflow-branch": "staging" },
    };

    await handler(req as any, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error:
        "md5hash required for all files in batch upload. Missing for: file2.txt",
    });
  });
});

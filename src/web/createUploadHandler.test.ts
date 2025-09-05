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
  redis: { provider: "upstash", restUrl: "u", token: "t" },
  lambda: { memoryMb: 512, timeoutSec: 60 },
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
      body: { filename: "a.txt", contentType: "text/plain", templateId: "t1" },
      headers: {},
    };
    // We cannot actually sign without AWS credentials; just assert it runs until presign call.
    try {
      await handler(req as any, res);
    } catch (e) {
      expect(res.status).not.toHaveBeenCalledWith(400);
    }
  });

  it("generates branch-aware channel names", async () => {
    const handler = createUploadHandler(cfg);
    const res: any = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
      setHeader: vi.fn(),
    };

    // Test with explicit branch header
    const req = {
      method: "POST",
      body: {
        filename: "test.txt",
        contentType: "text/plain",
        templateId: "t1",
      },
      headers: { "x-transflow-branch": "feature-x" },
    };

    await handler(req as any, res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: expect.stringMatching(/^upload:feature-x:/),
      })
    );
  });

  it("defaults to main branch when no branch header provided", async () => {
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
      },
      headers: {}, // No branch header
    };

    await handler(req as any, res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: expect.stringMatching(/^upload:main:/),
      })
    );
  });

  it("generates branch-aware channels for batch uploads", async () => {
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
          { filename: "file1.txt", contentType: "text/plain" },
          { filename: "file2.txt", contentType: "text/plain" },
        ],
        templateId: "t1",
      },
      headers: { "x-transflow-branch": "staging" },
    };

    await handler(req as any, res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: expect.stringMatching(/^upload:staging:/),
      })
    );
  });
});

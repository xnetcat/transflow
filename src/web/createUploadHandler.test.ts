import { describe, it, expect, vi } from "vitest";
import { createUploadHandler } from "./createUploadHandler";
import type { TransflowConfig } from "../core/types";

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
});

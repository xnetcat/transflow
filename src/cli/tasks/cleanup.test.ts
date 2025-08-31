import { describe, it, expect, vi } from "vitest";

vi.mock("@aws-sdk/client-ecr", () => ({
  ECRClient: vi
    .fn()
    .mockImplementation(() => ({ send: vi.fn(async () => ({})) })),
  DescribeImagesCommand: class {},
  BatchDeleteImageCommand: class {},
}));

vi.mock("@aws-sdk/client-lambda", () => ({
  LambdaClient: vi
    .fn()
    .mockImplementation(() => ({ send: vi.fn(async () => ({})) })),
  DeleteFunctionCommand: class {},
}));

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: vi
    .fn()
    .mockImplementation(() => ({ send: vi.fn(async () => ({})) })),
  PutBucketNotificationConfigurationCommand: class {},
  ListObjectsV2Command: class {},
  DeleteObjectsCommand: class {},
}));

const cfg = {
  project: "p",
  region: "us-east-1",
  s3: { mode: "prefix", uploadBucket: "ub", outputBucket: "ob" },
  ecrRepo: "repo",
  lambdaPrefix: "lp-",
  templatesDir: "./t",
  lambdaBuildContext: ".",
  redis: { provider: "upstash", restUrl: "u", token: "t" },
  lambda: {
    memoryMb: 512,
    timeoutSec: 60,
    roleArn: "arn:aws:iam::123:role/role",
  },
} as const;

describe("cleanup", () => {
  it("runs cleanup without throwing", async () => {
    const { cleanup } = await import("./cleanup");
    await expect(
      cleanup({
        cfg: cfg as any,
        branch: "b",
        nonInteractive: true,
        deleteStorage: false,
        deleteEcrImages: false,
      })
    ).resolves.toBeUndefined();
  });
});

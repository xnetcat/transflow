import { describe, it, expect, vi } from "vitest";

vi.mock("@aws-sdk/client-ecr", () => ({
  ECRClient: vi
    .fn()
    .mockImplementation(() => ({ send: vi.fn(async () => ({})) })),
  CreateRepositoryCommand: class {},
  DescribeRepositoriesCommand: class {},
}));

vi.mock("@aws-sdk/client-lambda", () => ({
  LambdaClient: vi
    .fn()
    .mockImplementation(() => ({ send: vi.fn(async () => ({})) })),
  CreateFunctionCommand: class {},
  UpdateFunctionCodeCommand: class {},
  UpdateFunctionConfigurationCommand: class {},
  GetFunctionCommand: class {},
  AddPermissionCommand: class {},
}));

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: vi
    .fn()
    .mockImplementation(() => ({ send: vi.fn(async () => ({})) })),
  CreateBucketCommand: class {},
  PutBucketNotificationConfigurationCommand: class {},
  GetBucketNotificationConfigurationCommand: class {},
  HeadBucketCommand: class {},
}));

vi.mock("execa", () => ({
  execa: vi.fn(async () => ({ stdout: "123456789012" })),
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

describe("deploy", () => {
  it("runs deploy flow without throwing", async () => {
    const { deploy } = await import("./deploy");
    await expect(
      deploy({
        cfg: cfg as any,
        branch: "b",
        sha: "abc",
        tag: "b-abc",
        nonInteractive: true,
      })
    ).resolves.toBeTruthy();
  });
});

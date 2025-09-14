import { describe, it, expect, vi } from "vitest";

vi.mock("@aws-sdk/client-ecr", () => ({
  ECRClient: vi
    .fn()
    .mockImplementation(() => ({ send: vi.fn(async () => ({})) })),
  CreateRepositoryCommand: class {},
  DescribeRepositoriesCommand: class {},
}));

vi.mock("@aws-sdk/client-lambda", () => ({
  LambdaClient: vi.fn().mockImplementation(() => ({
    send: vi.fn(async (command) => {
      // Mock Lambda function exists check to return "not found" initially
      if (command.constructor.name === "GetFunctionCommand") {
        throw new Error("Function not found");
      }
      return {};
    }),
  })),
  CreateFunctionCommand: class {},
  UpdateFunctionCodeCommand: class {},
  UpdateFunctionConfigurationCommand: class {},
  GetFunctionCommand: class {},
  AddPermissionCommand: class {},
  PutFunctionConcurrencyCommand: class {},
  CreateEventSourceMappingCommand: class {},
  ListEventSourceMappingsCommand: class {},
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

vi.mock("@aws-sdk/client-sqs", () => ({
  SQSClient: vi.fn().mockImplementation(() => ({
    send: vi.fn(async (command) => {
      // Mock different responses for different commands
      if (command.constructor.name === "CreateQueueCommand") {
        return {
          QueueUrl:
            "https://sqs.us-east-1.amazonaws.com/123456789012/test-queue.fifo",
        };
      }
      if (command.constructor.name === "GetQueueAttributesCommand") {
        return { Attributes: {} };
      }
      if (command.constructor.name === "SetQueueAttributesCommand") {
        return {};
      }
      return {};
    }),
  })),
  CreateQueueCommand: class {},
  GetQueueAttributesCommand: class {},
  SetQueueAttributesCommand: class {},
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
  dynamoDb: { tableName: "test-table" },
  lambda: {
    memoryMb: 512,
    timeoutSec: 60,
    roleArn: "arn:aws:iam::123:role/role",
  },
  sqs: {
    queueName: "test-processing.fifo",
    visibilityTimeoutSec: 960,
    maxReceiveCount: 3,
    batchSize: 10,
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

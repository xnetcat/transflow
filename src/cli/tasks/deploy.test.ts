import { describe, it, expect, vi } from "vitest";

vi.mock("@aws-sdk/client-ecr", () => ({
  ECRClient: vi.fn().mockImplementation(() => ({
    send: vi.fn(async (command: any) => {
      const name = command.constructor.name;
      if (name === "GetAuthorizationTokenCommand") {
        return {
          authorizationData: [
            {
              authorizationToken: Buffer.from("AWS:dummy-password").toString(
                "base64"
              ),
              proxyEndpoint: "https://123456789012.dkr.ecr.us-east-1.amazonaws.com",
            },
          ],
        } as any;
      }
      return {} as any;
    }),
  })),
  CreateRepositoryCommand: class {},
  DescribeRepositoriesCommand: class {},
  GetAuthorizationTokenCommand: class {},
  PutLifecyclePolicyCommand: class {},
}));

vi.mock("@aws-sdk/client-lambda", () => {
  const created = new Set<string>();
  return {
    LambdaClient: vi.fn().mockImplementation(() => ({
      send: vi.fn(async (command: any) => {
        const name = command.constructor.name;
        if (name === "GetFunctionCommand") {
          const fn = command.input?.FunctionName as string | undefined;
          if (!fn || !created.has(fn)) throw new Error("Function not found");
          return { Configuration: { LastUpdateStatus: "Successful" } } as any;
        }
        if (name === "CreateFunctionCommand") {
          const fn = command.input?.FunctionName as string | undefined;
          if (fn) created.add(fn);
          return {} as any;
        }
        if (name === "ListEventSourceMappingsCommand") {
          return { EventSourceMappings: [] } as any;
        }
        return {} as any;
      }),
    })),
    CreateFunctionCommand: class {
      input: any;
      constructor(input: any) {
        this.input = input;
      }
    },
    UpdateFunctionCodeCommand: class {
      input: any;
      constructor(input: any) {
        this.input = input;
      }
    },
    UpdateFunctionConfigurationCommand: class {
      input: any;
      constructor(input: any) {
        this.input = input;
      }
    },
    GetFunctionCommand: class {
      input: any;
      constructor(input: any) {
        this.input = input;
      }
    },
    AddPermissionCommand: class {
      input: any;
      constructor(input: any) {
        this.input = input;
      }
    },
    PutFunctionConcurrencyCommand: class {
      input: any;
      constructor(input: any) {
        this.input = input;
      }
    },
    CreateEventSourceMappingCommand: class {
      input: any;
      constructor(input: any) {
        this.input = input;
      }
    },
    ListEventSourceMappingsCommand: class {
      input: any;
      constructor(input: any) {
        this.input = input;
      }
    },
  };
});

vi.mock("@aws-sdk/client-iam", () => ({
  IAMClient: vi
    .fn()
    .mockImplementation(() => ({ send: vi.fn(async () => ({})) })),
  GetRoleCommand: class {},
  CreateRoleCommand: class {},
  AttachRolePolicyCommand: class {},
  PutRolePolicyCommand: class {},
}));

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: vi
    .fn()
    .mockImplementation(() => ({ send: vi.fn(async () => ({})) })),
  CreateBucketCommand: class {
    input: any;
    constructor(input: any) {
      this.input = input;
    }
  },
  PutBucketNotificationConfigurationCommand: class {
    input: any;
    constructor(input: any) {
      this.input = input;
    }
  },
  GetBucketNotificationConfigurationCommand: class {
    input: any;
    constructor(input: any) {
      this.input = input;
    }
  },
  HeadBucketCommand: class {
    input: any;
    constructor(input: any) {
      this.input = input;
    }
  },
  PutBucketCorsCommand: class {
    input: any;
    constructor(input: any) {
      this.input = input;
    }
  },
  PutBucketLifecycleConfigurationCommand: class {
    input: any;
    constructor(input: any) {
      this.input = input;
    }
  },
}));

vi.mock("@aws-sdk/client-sqs", () => ({
  SQSClient: vi.fn().mockImplementation(() => ({
    send: vi.fn(async (command: any) => {
      const name = command.constructor.name;
      if (name === "CreateQueueCommand") {
        return {
          QueueUrl:
            "https://sqs.us-east-1.amazonaws.com/123456789012/test-queue.fifo",
        } as any;
      }
      return {} as any;
    }),
  })),
  CreateQueueCommand: class {
    input: any;
    constructor(input: any) {
      this.input = input;
    }
  },
  GetQueueAttributesCommand: class {
    input: any;
    constructor(input: any) {
      this.input = input;
    }
  },
  SetQueueAttributesCommand: class {
    input: any;
    constructor(input: any) {
      this.input = input;
    }
  },
}));

vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: vi.fn().mockImplementation(() => ({
    send: vi.fn(async (command: any) => {
      const name = command.constructor.name;
      if (name === "DescribeTableCommand") {
        return { Table: { TableStatus: "ACTIVE" } } as any;
      }
      if (name === "DescribeTimeToLiveCommand") {
        return {
          TimeToLiveDescription: { TimeToLiveStatus: "ENABLED" },
        } as any;
      }
      return {} as any;
    }),
  })),
  CreateTableCommand: class {
    input: any;
    constructor(input: any) {
      this.input = input;
    }
  },
  DescribeTableCommand: class {
    input: any;
    constructor(input: any) {
      this.input = input;
    }
  },
  UpdateTimeToLiveCommand: class {
    input: any;
    constructor(input: any) {
      this.input = input;
    }
  },
  DescribeTimeToLiveCommand: class {
    input: any;
    constructor(input: any) {
      this.input = input;
    }
  },
}));

vi.mock("execa", () => ({
  execa: vi.fn(async (cmd: string) => {
    if (cmd === "aws") return { stdout: "123456789012" } as any;
    if (cmd === "docker") return { stdout: "" } as any;
    return { stdout: "" } as any;
  }),
}));

const cfg = {
  project: "p",
  region: "us-east-1",
  s3: { exportBuckets: ["ob"] },
  ecrRepo: "repo",
  lambdaPrefix: "lp-",
  templatesDir: "./t",
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

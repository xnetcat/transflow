import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "fs";
import path from "path";

// Mock all AWS SDK clients
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: vi.fn().mockImplementation(() => ({
    send: vi.fn().mockImplementation((command) => {
      if (command.constructor.name === "HeadObjectCommand") {
        return Promise.resolve({
          Metadata: {
            uploadid: "test-upload-123",
            templateid: "test-template",
            assemblyid: "test-assembly-123",
          },
          ContentType: "audio/mpeg",
          ContentLength: 1024,
        });
      }
      if (command.constructor.name === "GetObjectCommand") {
        return Promise.resolve({
          Body: {
            pipe: vi.fn().mockImplementation((writeStream) => {
              // Simulate successful download by emitting finish event
              setTimeout(() => writeStream.emit("finish"), 10);
              return writeStream;
            }),
          },
        });
      }
      if (command.constructor.name === "PutObjectCommand") {
        return Promise.resolve({});
      }
      if (command.constructor.name === "DeleteObjectCommand") {
        return Promise.resolve({});
      }
      return Promise.resolve({});
    }),
  })),
  GetObjectCommand: vi.fn().mockImplementation((params) => ({
    ...params,
    constructor: { name: "GetObjectCommand" },
  })),
  PutObjectCommand: vi.fn().mockImplementation((params) => ({
    ...params,
    constructor: { name: "PutObjectCommand" },
  })),
  HeadObjectCommand: vi.fn().mockImplementation((params) => ({
    ...params,
    constructor: { name: "HeadObjectCommand" },
  })),
  DeleteObjectCommand: vi.fn().mockImplementation((params) => ({
    ...params,
    constructor: { name: "DeleteObjectCommand" },
  })),
}));

vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("@aws-sdk/client-sqs", () => ({
  SQSClient: vi.fn().mockImplementation(() => ({
    send: vi.fn().mockResolvedValue({
      QueueUrl:
        "https://sqs.us-east-1.amazonaws.com/123456789012/test-queue.fifo",
      MessageId: "test-message-id",
    }),
  })),
  SendMessageCommand: vi.fn().mockImplementation((params) => params),
  GetQueueUrlCommand: vi.fn().mockImplementation((params) => params),
}));

vi.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: {
    from: vi.fn().mockReturnValue({
      send: vi.fn().mockResolvedValue({}),
    }),
  },
  PutCommand: vi.fn().mockImplementation((params) => params),
  UpdateCommand: vi.fn().mockImplementation((params) => params),
  GetCommand: vi.fn().mockImplementation((params) => params),
}));

// Mock fetch for webhooks
global.fetch = vi.fn().mockResolvedValue({
  ok: true,
  status: 200,
  statusText: "OK",
} as Response);

// Mock child_process.spawn
vi.mock("child_process", () => ({
  spawn: vi.fn().mockImplementation(() => ({
    stdout: {
      on: vi.fn().mockImplementation((event, cb) => {
        if (event === "data") {
          setTimeout(() => cb(Buffer.from("test output")), 10);
        }
      }),
    },
    stderr: {
      on: vi.fn().mockImplementation((event, cb) => {
        if (event === "data") {
          setTimeout(() => cb(Buffer.from("")), 10);
        }
      }),
    },
    on: vi.fn().mockImplementation((event, cb) => {
      if (event === "close") {
        setTimeout(() => cb(0), 20);
      }
    }),
  })),
}));

// Mock filesystem operations
vi.mock("fs", async () => {
  const actual = (await vi.importActual("fs")) as any;
  return {
    ...actual,
    mkdtempSync: vi.fn().mockReturnValue("/tmp/transflow-test"),
    createWriteStream: vi.fn().mockImplementation(() => ({
      on: vi.fn().mockImplementation((event, cb) => {
        if (event === "finish") {
          setTimeout(cb, 5);
        }
      }),
    })),
    readFileSync: vi.fn().mockReturnValue(Buffer.from("test file content")),
  };
});

// Mock template loading
vi.mock("path", async () => {
  const actual = (await vi.importActual("path")) as any;
  return {
    ...actual,
    join: vi.fn().mockImplementation((...args) => args.join("/")),
    basename: vi.fn().mockImplementation((p) => p.split("/").pop()),
  };
});

// Mock require for template loading
const mockTemplate = {
  default: {
    id: "test-template",
    webhookUrl: "https://example.com/webhook",
    webhookSecret: "test-secret",
    steps: [
      {
        name: "test-step",
        run: vi.fn().mockResolvedValue(undefined),
      },
    ],
  },
};

// Mock the dynamic require in the handler
vi.mock("path", async () => {
  const actual = (await vi.importActual("path")) as any;
  return {
    ...actual,
    join: vi.fn().mockImplementation((...args) => {
      if (args.includes("templates.index.cjs")) {
        return "mocked-templates-path";
      }
      return args.join("/");
    }),
    basename: vi.fn().mockImplementation((p) => p.split("/").pop()),
  };
});

// Override require globally for template loading
const originalRequire = globalThis.require;
(globalThis as any).require = vi.fn().mockImplementation((modulePath) => {
  if (
    modulePath === "mocked-templates-path" ||
    modulePath.includes("templates.index.cjs") ||
    modulePath === "/test/templates.index.cjs" ||
    modulePath ===
      "/Users/xnetcat/Projects/xnetcat/transflow/templates.index.cjs"
  ) {
    return {
      "test-template": mockTemplate,
      "nonexistent-template": undefined, // For error testing
    };
  }
  try {
    if (originalRequire) {
      return originalRequire(modulePath);
    }
  } catch (error) {
    // If original require fails, return empty object to prevent crashes
    console.warn(`Mock require: failed to load ${modulePath}:`, error);
    return {};
  }
  return {};
});

// Mock process.cwd to return a path that our global require mock handles
vi.mock("process", () => ({
  cwd: vi.fn().mockReturnValue("/test"),
  env: process.env,
}));

// Set environment variables
process.env.TRANSFLOW_BRANCH = "main";
process.env.AWS_REGION = "us-east-1";
process.env.SQS_QUEUE_URL =
  "https://sqs.us-east-1.amazonaws.com/123456789012/test-queue.fifo";
process.env.DYNAMODB_TABLE = "test-transflow-jobs";
process.env.MAX_BATCH_SIZE = "2";
process.env.TRANSFLOW_PROJECT = "test-project";
process.env.TEMPLATES_INDEX_PATH = "/test/templates.index.cjs";
process.env.TRANSFLOW_ALLOWED_BUCKETS = JSON.stringify(["test-bucket"]);
process.env.TRANSFLOW_TMP_BUCKET = "test-bucket";

describe("handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("processes S3 events", async () => {
    const { handler } = await import("./handler");

    const s3Event = {
      Records: [
        {
          s3: {
            bucket: { name: "test-bucket" },
            object: {
              key: "uploads/main/test-upload-123/test-template/file1.mp3",
            },
          },
        },
      ],
    };

    await expect(handler(s3Event)).resolves.toBeUndefined();
  });

  it("processes SQS events", async () => {
    const { handler } = await import("./handler");

    const sqsEvent = {
      Records: [
        {
          body: JSON.stringify({
            uploadId: "test-upload-123",
            templateId: "test-template",
            objects: [
              {
                bucket: "test-bucket",
                key: "uploads/main/test-upload-123/test-template/file1.mp3",
              },
            ],
            branch: "main",
          }),
          receiptHandle: "test-receipt-handle",
          messageId: "test-message-id",
        },
      ],
    };

    // Handler should process without throwing even if templates fail to load
    await expect(handler(sqsEvent)).resolves.toBeUndefined();
  });

  it("handles batch processing", async () => {
    const { handler } = await import("./handler");

    const sqsEvent = {
      Records: Array.from({ length: 5 }, (_, i) => ({
        body: JSON.stringify({
          uploadId: `test-upload-${i}`,
          templateId: "test-template",
          objects: [
            {
              bucket: "test-bucket",
              key: `uploads/main/test-upload-${i}/test-template/file.mp3`,
            },
          ],
          branch: "main",
        }),
        receiptHandle: `test-receipt-handle-${i}`,
        messageId: `test-message-id-${i}`,
      })),
    };

    await expect(handler(sqsEvent)).resolves.toBeUndefined();
  });

  it("throws error for unsupported event type", async () => {
    const { handler } = await import("./handler");

    const invalidEvent = {
      Records: [
        {
          // Neither S3 nor SQS structure
          unknown: { field: "value" },
        },
      ],
    };

    await expect(handler(invalidEvent as any)).rejects.toThrow(
      "Unsupported event type"
    );
  });

  it("handles template not found error", async () => {
    const { handler } = await import("./handler");

    const sqsEvent = {
      Records: [
        {
          body: JSON.stringify({
            uploadId: "test-upload-123",
            templateId: "nonexistent-template",
            objects: [
              {
                bucket: "test-bucket",
                key: "uploads/main/test-upload-123/file1.mp3",
              },
            ],
            branch: "main",
          }),
          receiptHandle: "test-receipt-handle",
          messageId: "test-message-id",
        },
      ],
    };

    // Should reject with template not found error
    await expect(handler(sqsEvent)).rejects.toThrow(
      "Template not found: nonexistent-template"
    );
  });
});

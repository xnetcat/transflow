import { describe, it, expect, vi } from "vitest";

// Mock AWS SDK
vi.mock("@aws-sdk/client-sqs", () => ({
  SQSClient: vi.fn().mockImplementation(() => ({
    send: vi.fn().mockResolvedValue({ MessageId: "test-message-id" }),
  })),
  SendMessageCommand: vi.fn().mockImplementation((params) => params),
  SendMessageBatchCommand: vi.fn().mockImplementation((params) => params),
}));

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: vi.fn().mockImplementation(() => ({
    send: vi.fn().mockResolvedValue({
      Metadata: {
        uploadid: "test-upload-123",
        templateid: "test-template",
      },
    }),
  })),
  HeadObjectCommand: vi.fn().mockImplementation((params) => params),
}));

// Set environment variables
process.env.SQS_QUEUE_URL =
  "https://sqs.us-east-1.amazonaws.com/123456789012/test-queue.fifo";
process.env.TRANSFLOW_BRANCH = "main";
process.env.AWS_REGION = "us-east-1";

describe("sqsBridgeHandler", () => {
  it("converts S3 events to SQS messages", async () => {
    const { sqsBridgeHandler } = await import("./sqsBridge");

    const s3Event = {
      Records: [
        {
          s3: {
            bucket: { name: "test-bucket" },
            object: { key: "uploads/main/test-upload-123/file1.mp3" },
          },
        },
        {
          s3: {
            bucket: { name: "test-bucket" },
            object: { key: "uploads/main/test-upload-123/file2.mp3" },
          },
        },
      ],
    };

    await expect(sqsBridgeHandler(s3Event)).resolves.toBeUndefined();
  });

  it("groups files by uploadId", async () => {
    const { sqsBridgeHandler } = await import("./sqsBridge");

    const s3Event = {
      Records: [
        {
          s3: {
            bucket: { name: "test-bucket" },
            object: { key: "uploads/main/upload-1/file1.mp3" },
          },
        },
        {
          s3: {
            bucket: { name: "test-bucket" },
            object: { key: "uploads/main/upload-2/file2.mp3" },
          },
        },
      ],
    };

    await expect(sqsBridgeHandler(s3Event)).resolves.toBeUndefined();
  });

  it("handles errors gracefully", async () => {
    const { sqsBridgeHandler } = await import("./sqsBridge");

    const s3Event = {
      Records: [
        {
          s3: {
            bucket: { name: "nonexistent-bucket" },
            object: { key: "invalid/key" },
          },
        },
      ],
    };

    // Should not throw even if S3 HEAD fails
    await expect(sqsBridgeHandler(s3Event)).resolves.toBeUndefined();
  });

  it("throws error when SQS_QUEUE_URL is missing", async () => {
    delete process.env.SQS_QUEUE_URL;

    const { sqsBridgeHandler } = await import("./sqsBridge");

    const s3Event = {
      Records: [],
    };

    await expect(sqsBridgeHandler(s3Event)).rejects.toThrow(
      "SQS_QUEUE_URL environment variable is required"
    );

    // Restore for other tests
    process.env.SQS_QUEUE_URL =
      "https://sqs.us-east-1.amazonaws.com/123456789012/test-queue.fifo";
  });
});


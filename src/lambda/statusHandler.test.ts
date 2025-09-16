import { describe, it, expect, vi, beforeEach } from "vitest";
import { handler } from "./statusHandler";
import type { StatusLambdaEvent } from "./statusHandler";

// Mock AWS SDK
vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: {
    from: vi.fn().mockReturnValue({
      send: vi.fn(),
    }),
  },
  GetCommand: vi.fn(),
}));

// Mock fetch for webhooks
global.fetch = vi.fn();

// Mock require for template loading
const mockTemplate = {
  default: {
    id: "test-template",
    webhookUrl: "https://example.com/webhook",
    webhookSecret: "test-secret",
    steps: [],
  },
};

(globalThis as any).require = vi.fn().mockImplementation((modulePath) => {
  if (
    modulePath.includes("templates.index.cjs") ||
    modulePath === "/test/templates.index.cjs" ||
    modulePath === "/var/task/templates.index.cjs" ||
    modulePath === "./templates.index.cjs" ||
    modulePath.endsWith("/templates.index.cjs")
  ) {
    return {
      "test-template": mockTemplate,
    };
  }
  return {};
});

describe("statusHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DYNAMODB_TABLE = "test-table";
    process.env.AWS_REGION = "us-east-1";
    process.env.TEMPLATES_INDEX_PATH =
      "/Users/xnetcat/Projects/xnetcat/transflow/templates.index.cjs";
  });

  it("returns 400 if assemblyId is missing", async () => {
    const event: StatusLambdaEvent = {
      assemblyId: "",
    };

    const result = await handler(event);

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body)).toEqual({
      error: "assemblyId is required",
    });
  });

  it("returns 500 if DYNAMODB_TABLE is not configured", async () => {
    delete process.env.DYNAMODB_TABLE;

    const event: StatusLambdaEvent = {
      assemblyId: "test-assembly-id",
    };

    const result = await handler(event);

    expect(result.statusCode).toBe(500);
    expect(JSON.parse(result.body)).toEqual({
      error: "DYNAMODB_TABLE not configured",
    });
  });

  it("returns 404 if assembly is not found", async () => {
    const mockDdb = {
      send: vi.fn().mockResolvedValue({ Item: null }),
    };

    const { DynamoDBDocumentClient } = await import("@aws-sdk/lib-dynamodb");
    vi.mocked(DynamoDBDocumentClient.from).mockReturnValue(mockDdb as any);

    const event: StatusLambdaEvent = {
      assemblyId: "nonexistent-assembly",
    };

    const result = await handler(event);

    expect(result.statusCode).toBe(404);
    expect(JSON.parse(result.body)).toEqual({
      error: "Assembly not found",
      assembly_id: "nonexistent-assembly",
    });
  });

  it("does not enforce ownership (no-auth mode)", async () => {
    const mockAssembly = {
      assembly_id: "test-assembly",
      user: { userId: "other-user" },
      ok: "ASSEMBLY_COMPLETED",
      message: "Processing completed",
    };

    const mockDdb = {
      send: vi.fn().mockResolvedValue({ Item: mockAssembly }),
    };

    const { DynamoDBDocumentClient } = await import("@aws-sdk/lib-dynamodb");
    vi.mocked(DynamoDBDocumentClient.from).mockReturnValue(mockDdb as any);

    const event: StatusLambdaEvent = {
      assemblyId: "test-assembly",
    };

    const result = await handler(event);
    expect(result.statusCode).toBe(200);
  });

  it("returns assembly status successfully", async () => {
    const mockAssembly = {
      assembly_id: "test-assembly",
      user: { userId: "test-user" },
      ok: "ASSEMBLY_COMPLETED",
      message: "Processing completed",
      uploads: [],
      results: {},
    };

    const mockDdb = {
      send: vi.fn().mockResolvedValue({ Item: mockAssembly }),
    };

    const { DynamoDBDocumentClient } = await import("@aws-sdk/lib-dynamodb");
    vi.mocked(DynamoDBDocumentClient.from).mockReturnValue(mockDdb as any);

    const event: StatusLambdaEvent = {
      assemblyId: "test-assembly",
      userId: "test-user",
    };

    const result = await handler(event);

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual(mockAssembly);
    expect(result.headers).toEqual({
      "Content-Type": "application/json",
      "Cache-Control": "no-cache",
    });
  });

  it("triggers webhook when requested", async () => {
    const mockAssembly = {
      assembly_id: "test-assembly",
      user: { userId: "test-user" },
      template_id: "test-template",
      ok: "ASSEMBLY_COMPLETED",
      message: "Processing completed",
      uploads: [],
      results: {},
    };

    const mockDdb = {
      send: vi.fn().mockResolvedValue({ Item: mockAssembly }),
    };

    const { DynamoDBDocumentClient } = await import("@aws-sdk/lib-dynamodb");
    vi.mocked(DynamoDBDocumentClient.from).mockReturnValue(mockDdb as any);

    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
    } as Response);

    const event: StatusLambdaEvent = {
      assemblyId: "test-assembly",
      userId: "test-user",
      triggerWebhook: true,
    };

    const result = await handler(event);

    expect(result.statusCode).toBe(200);
    expect(mockFetch).toHaveBeenCalledWith(
      "https://example.com/webhook",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          "User-Agent": "Transflow-Status/1.0",
          "X-Transflow-Signature": expect.stringMatching(/^sha256=/),
        }),
        body: JSON.stringify(mockAssembly),
      })
    );
  });

  it("doesn't fail if webhook fails", async () => {
    const mockAssembly = {
      assembly_id: "test-assembly",
      user: { userId: "test-user" },
      template_id: "test-template",
      ok: "ASSEMBLY_COMPLETED",
      message: "Processing completed",
    };

    const mockDdb = {
      send: vi.fn().mockResolvedValue({ Item: mockAssembly }),
    };

    const { DynamoDBDocumentClient } = await import("@aws-sdk/lib-dynamodb");
    vi.mocked(DynamoDBDocumentClient.from).mockReturnValue(mockDdb as any);

    const mockFetch = vi.mocked(fetch);
    mockFetch.mockRejectedValue(new Error("Network error"));

    const event: StatusLambdaEvent = {
      assemblyId: "test-assembly",
      userId: "test-user",
      triggerWebhook: true,
    };

    const result = await handler(event);

    // Should still return the assembly status even if webhook fails
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual(mockAssembly);
  });
});

import { describe, it, expect, vi } from "vitest";
import {
  generateUserPath,
  generateUserOutputPath,
  validateUserAccess,
  validateContentType,
  validateFileSize,
  extractUserContext,
  AuthenticationError,
} from "./auth";
import type { TransflowConfig } from "../core/types";

// Mock jsonwebtoken
vi.mock("jsonwebtoken", () => ({
  verify: vi.fn().mockImplementation((token, secret) => {
    if (token === "valid-token") {
      return { sub: "user-123", iss: "test-app.com" };
    }
    if (token === "invalid-issuer") {
      return { sub: "user-123", iss: "wrong-issuer.com" };
    }
    throw new Error("Invalid token");
  }),
}));

const mockConfig: TransflowConfig = {
  project: "test-app",
  region: "us-east-1",
  s3: {
    mode: "prefix",
    uploadBucket: "test-uploads",
    outputBucket: "test-outputs",
    userIsolation: true,
    maxFileSize: 1048576, // 1MB
    allowedContentTypes: ["image/*", "video/mp4", "application/pdf"],
  },
  ecrRepo: "test-repo",
  lambdaPrefix: "test-",
  templatesDir: "./templates",
  lambdaBuildContext: "./build",
  dynamoDb: {
    tableName: "test-table",
  },
  lambda: {
    memoryMb: 512,
    timeoutSec: 60,
    maxBatchSize: 10,
  },
  sqs: {
    queueName: "test-processing.fifo",
    visibilityTimeoutSec: 960,
    maxReceiveCount: 3,
    batchSize: 10,
  },
  auth: {
    requireAuth: false,
  },
};

describe("User Path Generation", () => {
  it("should generate secure user-specific upload paths", () => {
    const path = generateUserPath("user-123", "main", "upload-abc", "file.mp3");
    expect(path).toBe("uploads/main/users/user-123/upload-abc/file.mp3");
  });

  it("should sanitize dangerous path components", () => {
    const path = generateUserPath(
      "../../../evil",
      "main",
      "../hack",
      "../../etc/passwd"
    );
    expect(path).toContain("uploads/main/users/");
    expect(path).toContain("evil");
    expect(path).toContain("hack");
    expect(path).toContain("etc-passwd");
    expect(path).not.toContain("../");
  });

  it("should generate user-specific output paths", () => {
    const path = generateUserOutputPath("user-456", "feature", "upload-def");
    expect(path).toBe("outputs/feature/users/user-456/upload-def/");
  });

  it("should limit path component length", () => {
    const longString = "a".repeat(200);
    const path = generateUserPath(longString, "main", "upload", "file.txt");
    expect(path.length).toBeLessThan(500);
    expect(path).toContain("users/" + "a".repeat(100));
  });
});

describe("User Access Validation", () => {
  it("should allow access to user's own files", () => {
    const userPath = "uploads/main/users/user-123/upload-abc/file.mp3";
    expect(validateUserAccess("user-123", userPath)).toBe(true);
  });

  it("should deny access to other users' files", () => {
    const otherUserPath = "uploads/main/users/user-456/upload-def/file.mp3";
    expect(validateUserAccess("user-123", otherUserPath)).toBe(false);
  });

  it("should deny access to paths without user directory", () => {
    const publicPath = "uploads/main/public/file.mp3";
    expect(validateUserAccess("user-123", publicPath)).toBe(false);
  });

  it("should handle write access validation", () => {
    const userPath = "uploads/main/users/user-123/upload-abc/file.mp3";
    const otherUserPath = "uploads/main/users/user-456/upload-def/file.mp3";

    expect(validateUserAccess("user-123", userPath, "write")).toBe(true);
    expect(validateUserAccess("user-123", otherUserPath, "write")).toBe(false);
  });
});

describe("Content Type Validation", () => {
  it("should allow permitted content types", () => {
    expect(validateContentType("image/jpeg", ["image/*", "video/*"])).toBe(
      true
    );
    expect(validateContentType("video/mp4", ["image/*", "video/*"])).toBe(true);
  });

  it("should deny unpermitted content types", () => {
    expect(
      validateContentType("application/javascript", ["image/*", "video/*"])
    ).toBe(false);
    expect(validateContentType("text/html", ["image/*", "video/*"])).toBe(
      false
    );
  });

  it("should handle exact matches", () => {
    expect(validateContentType("application/pdf", ["application/pdf"])).toBe(
      true
    );
    expect(validateContentType("application/json", ["application/pdf"])).toBe(
      false
    );
  });

  it("should allow all types when no restrictions", () => {
    expect(validateContentType("any/type", undefined)).toBe(true);
    expect(validateContentType("any/type", [])).toBe(true);
  });

  it("should handle wildcard patterns", () => {
    expect(validateContentType("image/png", ["image/*"])).toBe(true);
    expect(validateContentType("image/gif", ["image/*"])).toBe(true);
    expect(validateContentType("video/mp4", ["image/*"])).toBe(false);
  });
});

describe("File Size Validation", () => {
  it("should allow files under size limit", () => {
    expect(validateFileSize(500000, 1048576)).toBe(true); // 500KB < 1MB
  });

  it("should deny files over size limit", () => {
    expect(validateFileSize(2097152, 1048576)).toBe(false); // 2MB > 1MB
  });

  it("should allow any size when no limit set", () => {
    expect(validateFileSize(999999999, undefined)).toBe(true);
  });

  it("should handle exact size limit", () => {
    expect(validateFileSize(1048576, 1048576)).toBe(true); // Exactly 1MB
  });
});

describe("User Context Extraction", () => {
  it("should return null when authentication not required", async () => {
    const configNoAuth = { ...mockConfig, auth: { requireAuth: false } };
    const req = { headers: {}, cookies: {} };

    const context = await extractUserContext(req, configNoAuth);
    expect(context).toBeNull();
  });

  it("should not trust header user id when auth disabled (anonymous)", async () => {
    const configNoAuth = { ...mockConfig, auth: { requireAuth: false } };
    const req = {
      headers: { "x-user-id": "header-user-999" },
      cookies: {},
    };

    const context = await extractUserContext(req, configNoAuth);
    expect(context).toBeNull();
  });

  it("returns null in no-auth mode", async () => {
    const req = { headers: {}, cookies: {} } as any;
    const context = await extractUserContext(req, mockConfig);
    expect(context).toBeNull();
  });

  it("does not validate JWT in no-auth mode", async () => {
    const req = {
      headers: { authorization: "Bearer invalid-token" },
      cookies: {},
    } as any;
    const context = await extractUserContext(req, mockConfig);
    expect(context).toBeNull();
  });

  it("ignores issuer in no-auth mode", async () => {
    const req = {
      headers: { authorization: "Bearer invalid-issuer" },
      cookies: {},
    } as any;
    const context = await extractUserContext(req, mockConfig);
    expect(context).toBeNull();
  });

  it("returns null when no auth provided (no-auth mode)", async () => {
    const req = { headers: {}, cookies: {} } as any;
    const context = await extractUserContext(req, mockConfig);
    expect(context).toBeNull();
  });

  it("ignores tokens in no-auth mode", async () => {
    const req = {
      headers: { authorization: "valid-token" },
      cookies: {},
    } as any;
    const context = await extractUserContext(req, mockConfig);
    expect(context).toBeNull();
  });
});

describe("Path Sanitization", () => {
  it("should remove dangerous characters", () => {
    const path = generateUserPath("user$%^&*", "main", "upload", "file");
    expect(path).not.toContain("$");
    expect(path).not.toContain("%");
    expect(path).not.toContain("^");
    expect(path).not.toContain("&");
    expect(path).not.toContain("*");
  });

  it("should prevent directory traversal", () => {
    const path = generateUserPath(
      "../../../admin",
      "main",
      "../../../etc",
      "../../passwd"
    );
    expect(path).not.toContain("../");
    expect(path).toContain("----admin");
    expect(path).toContain("----etc");
    expect(path).toContain("--passwd");
  });

  it("should convert to lowercase", () => {
    const path = generateUserPath("USER-ABC", "MAIN", "UPLOAD", "FILE.TXT");
    expect(path).toContain("uploads/main/users/user-abc/upload/");
    expect(path).toContain("file");
    expect(path.toLowerCase()).toBe(path); // Entire path should be lowercase
  });

  it("should handle empty or whitespace", () => {
    const path = generateUserPath("  ", "main", "upload", "file");
    expect(path).toContain("users/");
    expect(path).not.toContain("  ");
  });
});

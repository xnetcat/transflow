/*
  Authentication utilities (no-op in no-auth mode)
*/
import type { TransflowConfig, UserContext } from "../core/types";

export interface AuthRequest {
  headers?: Record<string, string | string[] | undefined>;
  cookies?: Record<string, string>;
}

export class AuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthenticationError";
  }
}

export class AuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthorizationError";
  }
}

/**
 * Extract and validate user context from request
 */
export async function extractUserContext(
  _req: AuthRequest,
  _cfg: TransflowConfig
): Promise<UserContext | null> {
  // No authentication: always anonymous
  return null;
}

// No auth helpers needed in no-auth mode

/**
 * Generate secure user-specific S3 path
 */
export function generateUserPath(
  userId: string,
  branch: string,
  uploadId: string,
  filename?: string
): string {
  // Sanitize user ID to prevent path traversal
  const sanitizedUserId = sanitizePathComponent(userId);
  const sanitizedBranch = sanitizePathComponent(branch);
  const sanitizedUploadId = sanitizePathComponent(uploadId);

  const basePath = `uploads/${sanitizedBranch}/users/${sanitizedUserId}/${sanitizedUploadId}`;

  if (filename) {
    const sanitizedFilename = sanitizePathComponent(filename);
    return `${basePath}/${sanitizedFilename}`;
  }

  return basePath;
}

/**
 * Generate user-specific output path
 */
export function generateUserOutputPath(
  userId: string,
  branch: string,
  uploadId: string
): string {
  const sanitizedUserId = sanitizePathComponent(userId);
  const sanitizedBranch = sanitizePathComponent(branch);
  const sanitizedUploadId = sanitizePathComponent(uploadId);

  return `outputs/${sanitizedBranch}/users/${sanitizedUserId}/${sanitizedUploadId}/`;
}

/**
 * Validate user can access specific path
 */
export function validateUserAccess(
  userId: string,
  s3Key: string,
  action: "read" | "write" = "read"
): boolean {
  const sanitizedUserId = sanitizePathComponent(userId);

  // Check if path contains user's directory
  const userPathPattern = `/users/${sanitizedUserId}/`;

  if (!s3Key.includes(userPathPattern)) {
    return false;
  }

  // Additional validation for write operations
  if (action === "write") {
    // Prevent writing to other user directories
    const otherUserPattern = /\/users\/([^\/]+)\//;
    const match = s3Key.match(otherUserPattern);
    if (match && match[1] !== sanitizedUserId) {
      return false;
    }
  }

  return true;
}

/**
 * Sanitize path component to prevent directory traversal
 */
function sanitizePathComponent(component: string): string {
  return component
    .replace(/[^a-zA-Z0-9\-_\.]/g, "-") // Replace invalid chars with dash
    .replace(/\.\./g, "--") // Replace .. with --
    .replace(/^\.+/, "") // Remove leading dots
    .replace(/\.+$/, "") // Remove trailing dots
    .toLowerCase()
    .substring(0, 100); // Limit length
}

/**
 * Validate file content type against allowed types
 */
export function validateContentType(
  contentType: string,
  allowedTypes?: string[]
): boolean {
  if (!allowedTypes || allowedTypes.length === 0) {
    return true; // No restrictions
  }

  return allowedTypes.some((allowed) => {
    if (allowed.includes("*")) {
      // Support wildcard patterns like "image/*"
      const pattern = allowed.replace("*", ".*");
      return new RegExp(pattern).test(contentType);
    }
    return contentType === allowed;
  });
}

/**
 * Validate file size against configured limits
 */
export function validateFileSize(
  fileSize: number,
  maxFileSize?: number
): boolean {
  if (!maxFileSize) {
    return true; // No size limit
  }

  return fileSize <= maxFileSize;
}

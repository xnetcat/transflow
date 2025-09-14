/*
  Authentication utilities for secure user-based uploads
*/

import { verify } from "jsonwebtoken";
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
  req: AuthRequest,
  cfg: TransflowConfig
): Promise<UserContext | null> {
  if (!cfg.auth?.requireAuth) {
    return null; // Authentication not required
  }

  const userId = await extractUserId(req, cfg);
  if (!userId) {
    throw new AuthenticationError("Authentication required");
  }

  return {
    userId,
    permissions: [], // Could be extended to load from database
    metadata: {},
  };
}

/**
 * Extract user ID from JWT token or session
 */
async function extractUserId(
  req: AuthRequest,
  cfg: TransflowConfig
): Promise<string | null> {
  // Try JWT from Authorization header first
  const authHeader = req.headers?.authorization;
  if (authHeader && typeof authHeader === "string") {
    const token = authHeader.replace(/^Bearer\s+/, "");
    const userId = await validateJWT(token, cfg);
    if (userId) return userId;
  }

  // Try session cookie
  const sessionCookieName = cfg.auth?.sessionCookieName || "session";
  const sessionToken = req.cookies?.[sessionCookieName];
  if (sessionToken) {
    const userId = await validateSession(sessionToken, cfg);
    if (userId) return userId;
  }

  return null;
}

/**
 * Validate JWT token and extract user ID
 */
async function validateJWT(
  token: string,
  cfg: TransflowConfig
): Promise<string | null> {
  if (!cfg.auth?.jwtSecret) {
    throw new Error("JWT secret not configured");
  }

  try {
    const decoded = verify(token, cfg.auth.jwtSecret) as any;

    // Validate issuer if configured
    if (cfg.auth.jwtIssuer && decoded.iss !== cfg.auth.jwtIssuer) {
      throw new AuthenticationError("Invalid token issuer");
    }

    // Extract user ID from configured claim
    const userIdClaim = cfg.auth.userIdClaim || "sub";
    const userId = decoded[userIdClaim];

    if (!userId || typeof userId !== "string") {
      throw new AuthenticationError("Invalid user ID in token");
    }

    return userId;
  } catch (error) {
    if (error instanceof AuthenticationError) {
      throw error;
    }
    throw new AuthenticationError("Invalid or expired token");
  }
}

/**
 * Validate session token (implement based on your session store)
 */
async function validateSession(
  sessionToken: string,
  cfg: TransflowConfig
): Promise<string | null> {
  // This is a placeholder - implement based on your session storage
  // Common options: Redis, DynamoDB, database, etc.

  // Example for Redis session store:
  /*
  const redis = new Redis(cfg.redis.url);
  const sessionData = await redis.get(`session:${sessionToken}`);
  if (sessionData) {
    const session = JSON.parse(sessionData);
    return session.userId;
  }
  */

  console.warn("Session validation not implemented");
  return null;
}

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


/**
 * Validate file content type against an allowlist.
 * Supports wildcard patterns like "image/*". No allowlist = unrestricted.
 */
export function validateContentType(
  contentType: string,
  allowedTypes?: string[]
): boolean {
  if (!allowedTypes || allowedTypes.length === 0) return true;
  return allowedTypes.some((allowed) => {
    if (allowed.includes("*")) {
      const pattern = allowed.replace("*", ".*");
      return new RegExp(pattern).test(contentType);
    }
    return contentType === allowed;
  });
}

/**
 * Validate file size against a configured maximum.
 * Undefined max = unrestricted.
 */
export function validateFileSize(
  fileSize: number,
  maxFileSize?: number
): boolean {
  if (!maxFileSize) return true;
  return fileSize <= maxFileSize;
}

# Transflow Security Guide

This document outlines how to implement secure, multi-tenant file uploads where users can only access their own files through multiple layers of security enforcement.

## Security Architecture Overview

Transflow implements defense-in-depth security with multiple layers:

1. **Authentication Layer**: JWT/Session validation
2. **Authorization Layer**: Server-side permission checks
3. **S3 Bucket Policies**: Path-based access control
4. **Pre-signed URL Security**: Restricted upload conditions
5. **Lambda Validation**: Runtime access enforcement

## Multi-Tenant Path Structure

When user isolation is enabled, files are organized by user:

```
uploads/
  ├── main/
  │   └── users/
  │       ├── user-123/
  │       │   └── upload-abc/
  │       │       └── file.mp3
  │       └── user-456/
  │           └── upload-def/
  │               └── video.mp4
  └── feature-branch/
      └── users/
          └── user-123/
              └── upload-xyz/
                  └── document.pdf

outputs/
  ├── main/
  │   └── users/
  │       ├── user-123/
  │       │   └── upload-abc/
  │       │       ├── converted.mp4
  │       │       └── thumbnail.jpg
  │       └── user-456/
  │           └── upload-def/
  │               └── processed.mp4
```

## Configuration

### Enable User Isolation

```json
{
  "s3": {
    "mode": "prefix",
    "uploadBucket": "myapp-uploads",
    "outputBucket": "myapp-outputs",
    "userIsolation": true,
    "maxFileSize": 104857600,
    "allowedContentTypes": ["image/*", "video/*", "audio/*", "application/pdf"]
  },
  "auth": {
    "requireAuth": true,
    "jwtSecret": "your-jwt-secret",
    "jwtIssuer": "your-app.com",
    "userIdClaim": "sub",
    "sessionCookieName": "session"
  }
}
```

### Environment Variables

```bash
# Production secrets (never commit these)
JWT_SECRET="your-256-bit-secret"

# Configuration
TRANSFLOW_BRANCH="main"
SQS_QUEUE_URL="https://sqs.region.amazonaws.com/account/queue-name.fifo"
SQS_PROGRESS_QUEUE_URL="https://sqs.region.amazonaws.com/account/progress-queue.fifo"
```

## Authentication Implementation

### JWT Token Validation

The upload handler validates JWT tokens from the `Authorization` header:

```typescript
// Client request
fetch("/api/create-upload", {
  method: "POST",
  headers: {
    Authorization: "Bearer eyJ0eXAiOiJKV1QiLCJhbGci...",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    filename: "video.mp4",
    contentType: "video/mp4",
    templateId: "video-processing",
  }),
});
```

### Session Cookie Validation

Alternative authentication via session cookies:

```javascript
// Set session cookie after login
document.cookie = `session=${sessionToken}; Secure; HttpOnly; SameSite=Strict`;
```

### User Context Extraction

Server extracts user ID from validated tokens:

```typescript
// JWT payload structure
{
  "sub": "user-123",        // User ID (configurable claim)
  "iss": "your-app.com",    // Issuer validation
  "exp": 1234567890,        // Expiration
  "permissions": ["upload", "process"]
}
```

## S3 Security Policies

### Bucket Policy for User Isolation

Apply this policy to your upload bucket:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowUserSpecificUploads",
      "Effect": "Allow",
      "Principal": "*",
      "Action": "s3:PutObject",
      "Resource": "arn:aws:s3:::YOUR_UPLOAD_BUCKET/uploads/*/users/${aws:userid}/*",
      "Condition": {
        "StringEquals": {
          "s3:x-amz-server-side-encryption": "AES256"
        }
      }
    },
    {
      "Sid": "DenyAccessToOtherUsers",
      "Effect": "Deny",
      "Principal": "*",
      "Action": ["s3:GetObject", "s3:PutObject"],
      "Resource": "arn:aws:s3:::YOUR_UPLOAD_BUCKET/*/users/*",
      "Condition": {
        "StringNotLike": {
          "s3:prefix": "uploads/*/users/${aws:userid}/*"
        }
      }
    }
  ]
}
```

### Lambda Execution Role Policy

Minimal permissions for Lambda processing:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject"],
      "Resource": [
        "arn:aws:s3:::YOUR_UPLOAD_BUCKET/uploads/*",
        "arn:aws:s3:::YOUR_OUTPUT_BUCKET/outputs/*"
      ]
    },
    {
      "Effect": "Deny",
      "Action": "s3:PutObject",
      "Resource": "*",
      "Condition": {
        "StringNotEquals": {
          "s3:x-amz-server-side-encryption": "AES256"
        }
      }
    }
  ]
}
```

## Server-Side Validation

### Pre-Upload Validation

Before generating pre-signed URLs:

```typescript
// 1. Authenticate user
const userContext = await extractUserContext(req, cfg);
if (!userContext) {
  return res.status(401).json({ error: "Authentication required" });
}

// 2. Validate file type
if (!validateContentType(contentType, cfg.s3.allowedContentTypes)) {
  return res.status(400).json({ error: "File type not allowed" });
}

// 3. Validate file size
if (!validateFileSize(fileSize, cfg.s3.maxFileSize)) {
  return res.status(400).json({ error: "File too large" });
}

// 4. Generate user-specific path
const key = generateUserPath(userContext.userId, branch, uploadId, filename);

// 5. Validate user access to path
if (!validateUserAccess(userContext.userId, key, "write")) {
  return res.status(403).json({ error: "Access denied" });
}
```

### Lambda Processing Validation

During file processing:

```typescript
// Validate user can write to output path
if (user && outKey.includes("/users/")) {
  const expectedUserPath = `/users/${user.userId}/`;
  if (!outKey.includes(expectedUserPath)) {
    throw new Error("Access denied: Cannot write outside user directory");
  }
}
```

## Pre-Signed URL Security

### Upload Constraints

Pre-signed URLs include security conditions:

```typescript
const presignedUrl = await getSignedUrl(s3, putCommand, {
  expiresIn: 3600, // 1 hour expiration
  // Conditions enforced by S3
});

// Metadata includes user context
const metadata = {
  templateid: templateId,
  uploadid: uploadId,
  userid: userContext.userId,
  "content-type": contentType,
};
```

### Advanced POST Policy (Recommended)

For maximum security, use S3 POST policies instead of PUT pre-signed URLs:

```typescript
const postPolicy = {
  expiration: new Date(Date.now() + 3600000).toISOString(),
  conditions: [
    { bucket: bucket },
    { key: key },
    { "Content-Type": contentType },
    ["content-length-range", 0, maxFileSize],
    { "x-amz-server-side-encryption": "AES256" },
    ["starts-with", "$key", `uploads/${branch}/users/${userId}/`],
  ],
};
```

## Runtime Security Enforcement

### Path Validation Functions

```typescript
// Sanitize user input to prevent path traversal
function sanitizePathComponent(component: string): string {
  return component
    .replace(/[^a-zA-Z0-9\-_\.]/g, "-")
    .replace(/\.\./g, "--")
    .replace(/^\.+/, "")
    .replace(/\.+$/, "")
    .toLowerCase()
    .substring(0, 100);
}

// Validate user can access specific S3 path
function validateUserAccess(userId: string, s3Key: string): boolean {
  const sanitizedUserId = sanitizePathComponent(userId);
  const userPathPattern = `/users/${sanitizedUserId}/`;
  return s3Key.includes(userPathPattern);
}
```

### Content Type Validation

```typescript
function validateContentType(
  contentType: string,
  allowedTypes?: string[]
): boolean {
  if (!allowedTypes) return true;

  return allowedTypes.some((allowed) => {
    if (allowed.includes("*")) {
      const pattern = allowed.replace("*", ".*");
      return new RegExp(pattern).test(contentType);
    }
    return contentType === allowed;
  });
}
```

## Security Best Practices

### 1. Principle of Least Privilege

- Lambda execution roles have minimal S3 permissions
- Users can only access their own directories
- Pre-signed URLs expire quickly (1 hour max)

### 2. Defense in Depth

- Authentication at API level
- Authorization checks before URL generation
- S3 bucket policies as final enforcement
- Runtime validation in Lambda

### 3. Data Encryption

- Enforce server-side encryption (AES-256)
- Use HTTPS/TLS for all communications
- Consider client-side encryption for sensitive files

### 4. Audit and Monitoring

```typescript
// Log all access attempts
console.log(
  JSON.stringify({
    action: "file_upload",
    userId: userContext.userId,
    key: s3Key,
    timestamp: new Date().toISOString(),
    ip: req.headers["x-forwarded-for"] || req.connection.remoteAddress,
  })
);
```

### 5. Rate Limiting

Implement rate limiting to prevent abuse:

```typescript
// Example with Redis
const uploadCount = await redis.incr(`uploads:${userId}:${hour}`);
if (uploadCount > MAX_UPLOADS_PER_HOUR) {
  return res.status(429).json({ error: "Rate limit exceeded" });
}
await redis.expire(`uploads:${userId}:${hour}`, 3600);
```

## Deployment Security

### 1. Environment Isolation

Use separate environments with different:

- AWS accounts or strict IAM boundaries
- S3 buckets per environment
- Different JWT secrets
- Separate Redis instances

### 2. Secrets Management

Never commit secrets to code:

```bash
# Use AWS Secrets Manager, HashiCorp Vault, or environment variables
export JWT_SECRET=$(aws secretsmanager get-secret-value --secret-id transflow/jwt --query SecretString --output text)
```

### 3. Network Security

- Deploy Lambda in VPC for database access
- Use VPC endpoints for S3 access
- Implement WAF rules for API Gateway

## Incident Response

### Compromised User Account

1. Immediately revoke JWT tokens/sessions
2. List objects in user's S3 directory
3. Check CloudTrail for suspicious access
4. Rotate API keys if needed

### Bulk Unauthorized Access

1. Apply emergency bucket policy denying all access
2. Investigate CloudTrail logs
3. Check Lambda logs for access patterns
4. Implement additional monitoring

## Testing Security

### Unit Tests

```typescript
describe("User Isolation", () => {
  it("should deny access to other user's files", async () => {
    const user1 = { userId: "user-123" };
    const user2Path = "uploads/main/users/user-456/file.txt";

    expect(validateUserAccess(user1.userId, user2Path)).toBe(false);
  });

  it("should allow access to own files", async () => {
    const user1 = { userId: "user-123" };
    const user1Path = "uploads/main/users/user-123/file.txt";

    expect(validateUserAccess(user1.userId, user1Path)).toBe(true);
  });
});
```

### Integration Tests

Test complete upload flows with different user contexts to ensure isolation works end-to-end.

This multi-layered security approach ensures that users can only access their own files, even if one security layer fails.

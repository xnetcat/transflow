# Status Tracking Guide

Transflow provides comprehensive job status tracking using DynamoDB as the single source of truth, with deterministic assembly IDs for reliable status lookups.

## Overview

The status tracking system provides:

1. **Deterministic Job IDs**: `assembly_id` based on file hash + template + user
2. **Rich Status Data**: Transloadit-like JSON with uploads, results, timing, bytes
3. **Real-time Polling**: Simple REST API calls every 2-5 seconds
4. **Authentication**: JWT-based ownership validation
5. **Optional Status Lambda**: Dedicated Lambda for high-frequency status checks
6. **Webhook Notifications**: Optional POST notifications with retries and HMAC

## Architecture

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   File Upload   │───▶│  Assembly ID    │───▶│   DynamoDB      │
│   (with MD5)    │    │  Generation     │    │   Status Store  │
└─────────────────┘    └─────────────────┘    └─────────────────┘
                                                       │
                                                       ▼
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Status UI     │◀───│  REST Polling   │◀───│   Status API    │
│   (React)       │    │  (every 2-5s)   │    │   Handler       │
└─────────────────┘    └─────────────────┘    └─────────────────┘

                       ┌─────────────────┐
                       │  Optional       │
                       │  Status Lambda  │◀─── Direct API calls
                       │  (User-facing)  │
                       └─────────────────┘
```

## Assembly ID Generation

### Deterministic Hash Algorithm

```typescript
// Single file upload
const assemblyId = sha256(md5(fileContent) + templateId + userId);

// Batch file upload
const md5List = files.map((f) => f.md5hash).sort();
const assemblyId = sha256(md5List.join("") + templateId + userId);
```

### Benefits

- **Idempotent**: Same files + template + user = same assembly ID
- **Predictable**: Status always available at same ID
- **Secure**: Includes user context for ownership validation
- **Collision-free**: SHA256 ensures unique identifiers

## Status Data Schema

### AssemblyStatus Interface

```typescript
interface AssemblyStatus {
  assembly_id: string; // Deterministic job ID
  ok?: "ASSEMBLY_COMPLETED"; // Success indicator
  error?: string; // Error message if failed
  message: string; // Human-readable status

  // File information
  uploads: Array<{
    id: string; // Upload ID
    name: string; // Original filename
    basename: string; // Name without extension
    ext: string; // File extension
    size: number; // File size in bytes
    mime: string; // MIME type
    field: string; // Form field name
    md5hash: string; // MD5 hash
    meta?: Record<string, any>; // Additional metadata
  }>;

  // Processing results by step
  results: {
    [stepName: string]: Array<{
      id: string; // Result ID
      name: string; // Output filename
      basename: string; // Name without extension
      ext: string; // File extension
      size: number; // File size in bytes
      mime: string; // MIME type
      field: string; // Original field name
      original_id: string; // Links back to upload
      ssl_url: string; // Download URL
      meta?: Record<string, any>; // Result metadata
    }>;
  };

  // Execution metrics
  bytes_expected: number; // Total input bytes
  bytes_received: number; // Bytes successfully downloaded
  bytes_usage: number; // Bytes processed/generated
  execution_duration: number; // Total time in seconds
  execution_start: string; // ISO timestamp
  last_job_completed?: string; // ISO timestamp

  // System metadata
  template_id: string; // Template used
  branch: string; // Git branch
  user: { userId: string }; // User who created job
  created_at: string; // ISO timestamp
  updated_at: string; // ISO timestamp
}
```

## Client-Side Implementation

### React Hook for Status Polling

```tsx
import { useEffect, useState } from "react";
import type { AssemblyStatus } from "@xnetcat/transflow";

function useAssemblyStatus(assemblyId: string) {
  const [status, setStatus] = useState<AssemblyStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    let pollInterval: NodeJS.Timeout;

    async function pollStatus() {
      try {
        const response = await fetch(
          `/api/transflow/status?assemblyId=${assemblyId}`
        );

        if (!response.ok) {
          if (response.status === 404) {
            // Job not found yet, keep polling
            return;
          }
          throw new Error(`Status request failed: ${response.status}`);
        }

        const assembly = await response.json();
        if (mounted) {
          setStatus(assembly);
          setLoading(false);

          // Stop polling if job is complete or errored
          if (assembly.ok === "ASSEMBLY_COMPLETED" || assembly.error) {
            clearInterval(pollInterval);
          }
        }
      } catch (err) {
        if (mounted) {
          setError(err instanceof Error ? err.message : "Unknown error");
          setLoading(false);
        }
      }
    }

    // Start polling immediately, then every 2 seconds
    pollStatus();
    pollInterval = setInterval(pollStatus, 2000);

    return () => {
      mounted = false;
      clearInterval(pollInterval);
    };
  }, [assemblyId]);

  return { status, loading, error };
}
```

### Status Display Component

```tsx
import type { AssemblyStatus } from "@xnetcat/transflow";

interface StatusDisplayProps {
  assembly: AssemblyStatus;
}

export function StatusDisplay({ assembly }: StatusDisplayProps) {
  const isComplete = assembly.ok === "ASSEMBLY_COMPLETED";
  const hasError = !!assembly.error;

  return (
    <div
      className={`status-card ${
        isComplete ? "complete" : hasError ? "error" : "processing"
      }`}
    >
      <div className="header">
        <h3>Assembly {assembly.assembly_id.slice(-8)}</h3>
        <span className="status-badge">
          {isComplete ? "✅ Complete" : hasError ? "❌ Error" : "🔄 Processing"}
        </span>
      </div>

      <div className="message">
        <strong>Status:</strong> {assembly.message}
      </div>

      {assembly.execution_duration && (
        <div className="timing">
          <strong>Duration:</strong> {assembly.execution_duration.toFixed(1)}s
        </div>
      )}

      {assembly.uploads && (
        <details className="uploads">
          <summary>Uploads ({assembly.uploads.length} files)</summary>
          {assembly.uploads.map((upload) => (
            <div key={upload.id} className="file-item">
              <strong>{upload.name}</strong> ({(upload.size / 1024).toFixed(1)}{" "}
              KB)
              {upload.mime && <span className="mime"> - {upload.mime}</span>}
            </div>
          ))}
        </details>
      )}

      {assembly.results && Object.keys(assembly.results).length > 0 && (
        <details className="results">
          <summary>
            Results ({Object.values(assembly.results).flat().length} files)
          </summary>
          {Object.entries(assembly.results).map(([stepName, results]) => (
            <div key={stepName} className="step-results">
              <strong>{stepName}:</strong>
              {results.map((result) => (
                <div key={result.id} className="result-item">
                  <a
                    href={result.ssl_url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {result.name}
                  </a>
                  {result.size && (
                    <span className="size">
                      {" "}
                      ({(result.size / 1024).toFixed(1)} KB)
                    </span>
                  )}
                </div>
              ))}
            </div>
          ))}
        </details>
      )}

      {assembly.bytes_expected && (
        <div className="bytes">
          Bytes: {assembly.bytes_received?.toLocaleString() || 0} /{" "}
          {assembly.bytes_expected.toLocaleString()}
          {assembly.bytes_usage &&
            ` (${assembly.bytes_usage.toLocaleString()} processed)`}
        </div>
      )}

      {assembly.error && (
        <div className="error-details">
          <strong>Error:</strong> {assembly.error}
        </div>
      )}
    </div>
  );
}
```

## Server-Side Implementation

### Status API Handler

```typescript
// pages/api/transflow/status.ts
import { createStatusHandler } from "@xnetcat/transflow";
import config from "../../../transflow.config";

// Automatically handles:
// - DynamoDB lookup by assembly_id
// - JWT authentication
// - Ownership validation (users can only see their assemblies)
// - Error handling (404, 403, 500)
export default createStatusHandler(config);
```

### Custom Status Implementation

```typescript
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import type { AssemblyStatus } from "@xnetcat/transflow";

async function getAssemblyStatus(
  assemblyId: string
): Promise<AssemblyStatus | null> {
  const ddb = DynamoDBDocumentClient.from(
    new DynamoDBClient({ region: "us-east-1" })
  );

  const result = await ddb.send(
    new GetCommand({
      TableName: "TransflowJobs",
      Key: { assembly_id: assemblyId },
    })
  );

  return (result.Item as AssemblyStatus) || null;
}
```

## Status Lambda Integration

### Direct Lambda Calls

```typescript
import { StatusLambdaClient } from "@xnetcat/transflow";

const client = new StatusLambdaClient({
  region: "us-east-1",
  functionName: "myapp-status",
});

// Basic status check
const result = await client.getStatus("assembly_123", "user_456");
if (result.success) {
  console.log("Assembly status:", result.status);
}

// Status check + webhook trigger
const result = await client.getStatusWithWebhook("assembly_123", "user_456");
```

### API Gateway Integration

```typescript
// Serverless function for API Gateway
export const handler = async (event) => {
  const { assemblyId } = event.queryStringParameters;
  const userId = extractUserId(event); // Your auth logic

  const client = new StatusLambdaClient({
    region: process.env.AWS_REGION,
    functionName: process.env.STATUS_FUNCTION_NAME,
  });

  const result = await client.getStatus(assemblyId, userId);

  return {
    statusCode: result.success ? 200 : result.statusCode || 500,
    body: JSON.stringify(
      result.success ? result.status : { error: result.error }
    ),
  };
};
```

## Webhook Integration

### Template Configuration

```typescript
export default {
  id: "my-template",
  webhookUrl: "https://myapp.com/api/webhooks/transflow",
  webhookSecret: process.env.TRANSFLOW_WEBHOOK_SECRET,
  steps: [
    // ... processing steps
  ],
} as TemplateDefinition;
```

### Webhook Handler

```typescript
// pages/api/webhooks/transflow.ts
import { createHmac } from "crypto";
import type { AssemblyStatus } from "@xnetcat/transflow";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Verify HMAC signature
  const signature = req.headers["x-transflow-signature"] as string;
  const secret = process.env.TRANSFLOW_WEBHOOK_SECRET;

  if (secret && signature) {
    const expectedSignature = `sha256=${createHmac("sha256", secret)
      .update(JSON.stringify(req.body))
      .digest("hex")}`;
    if (signature !== expectedSignature) {
      return res.status(401).json({ error: "Invalid signature" });
    }
  }

  const assembly: AssemblyStatus = req.body;

  // Process webhook
  console.log(`Webhook received for assembly ${assembly.assembly_id}`);

  if (assembly.ok === "ASSEMBLY_COMPLETED") {
    // Handle successful completion
    await notifyUser(assembly.user.userId, "Processing completed", assembly);
  } else if (assembly.error) {
    // Handle errors
    await notifyUser(assembly.user.userId, "Processing failed", assembly);
  }

  res.status(200).json({ message: "Webhook processed" });
}
```

## Performance Considerations

### Polling Optimization

**Recommended Intervals:**

- **Active processing**: 2 seconds
- **Queue/pending**: 5 seconds
- **Completed jobs**: Stop polling
- **Error state**: Stop polling

**Exponential Backoff:**

```typescript
let pollInterval = 2000; // Start with 2s
let consecutiveNotFound = 0;

async function pollWithBackoff() {
  const response = await fetch(`/api/status?assemblyId=${assemblyId}`);

  if (response.status === 404) {
    consecutiveNotFound++;
    // Gradually increase interval for not-found responses
    pollInterval = Math.min(pollInterval * 1.2, 10000); // Max 10s
  } else {
    consecutiveNotFound = 0;
    pollInterval = 2000; // Reset to 2s when found
  }
}
```

### Memory Management

```typescript
// Auto-cleanup completed assemblies from UI state
useEffect(() => {
  const cleanup = setInterval(() => {
    setAssemblies((prev) =>
      prev.filter((assembly) => {
        const completed =
          assembly.ok === "ASSEMBLY_COMPLETED" || assembly.error;
        const oldEnough =
          Date.now() - new Date(assembly.updated_at).getTime() > 300000; // 5 minutes
        return !(completed && oldEnough);
      })
    );
  }, 60000); // Check every minute

  return () => clearInterval(cleanup);
}, []);
```

## Security

### Authentication Required

All status endpoints require valid authentication:

```typescript
// Status API validates JWT and ownership
const userContext = await extractUserContext(req, config);
if (!userContext) {
  return res.status(401).json({ error: "Authentication required" });
}

// Users can only see their own assemblies
if (assembly.user?.userId !== userContext.userId) {
  return res.status(403).json({ error: "Access denied" });
}
```

### Assembly ID Security

Assembly IDs are deterministic but not guessable:

- Include user ID in hash (prevents cross-user access)
- 256-bit SHA256 output (collision-resistant)
- Based on file content hash (prevents tampering)

## Error Handling

### Status API Error Codes

| Code | Meaning      | Response                       |
| ---- | ------------ | ------------------------------ |
| 200  | Success      | Returns AssemblyStatus         |
| 401  | Unauthorized | Authentication required        |
| 403  | Forbidden    | User doesn't own this assembly |
| 404  | Not Found    | Assembly doesn't exist (yet)   |
| 500  | Server Error | DynamoDB or Lambda error       |

### Client Error Handling

```typescript
async function getAssemblyStatus(
  assemblyId: string
): Promise<AssemblyStatus | null> {
  try {
    const response = await fetch(
      `/api/transflow/status?assemblyId=${assemblyId}`
    );

    if (response.status === 404) {
      return null; // Job not started yet, keep polling
    }

    if (response.status === 403) {
      throw new Error("Access denied: You don't own this assembly");
    }

    if (!response.ok) {
      throw new Error(`Status request failed: ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    console.error("Status check failed:", error);
    throw error;
  }
}
```

## Monitoring & Analytics

### CloudWatch Metrics

Monitor these DynamoDB metrics:

- **ReadCapacityUnits**: Status polling load
- **WriteCapacityUnits**: Job creation/update rate
- **ItemCount**: Total jobs in table
- **ConsumedReadCapacityUnits**: Actual read consumption

### Custom Analytics

```typescript
// Track status check patterns
const analytics = {
  trackStatusCheck: (
    assemblyId: string,
    userId: string,
    result: "found" | "not_found" | "error"
  ) => {
    console.log(
      JSON.stringify({
        event: "status_check",
        assembly_id: assemblyId,
        user_id: userId,
        result,
        timestamp: new Date().toISOString(),
      })
    );
  },
};

// In status polling logic
const assembly = await getAssemblyStatus(assemblyId);
analytics.trackStatusCheck(
  assemblyId,
  userId,
  assembly ? "found" : "not_found"
);
```

### Webhook Analytics

```typescript
// Track webhook delivery
const webhookMetrics = {
  attempts: 0,
  successes: 0,
  failures: 0,
  avgRetryCount: 0,
};

// In webhook handler
console.log(
  JSON.stringify({
    event: "webhook_received",
    assembly_id: assembly.assembly_id,
    template_id: assembly.template_id,
    duration: assembly.execution_duration,
    success: assembly.ok === "ASSEMBLY_COMPLETED",
    timestamp: new Date().toISOString(),
  })
);
```

## Best Practices

### 1. **Efficient Polling**

```typescript
// Only poll active assemblies
const activeAssemblies = assemblies.filter(
  (a) =>
    !a.ok && !a.error && Date.now() - new Date(a.created_at).getTime() < 3600000 // 1 hour
);
```

### 2. **User Experience**

```typescript
// Show meaningful progress indicators
function getProgressMessage(assembly: AssemblyStatus): string {
  if (assembly.error) return `❌ ${assembly.error}`;
  if (assembly.ok)
    return `✅ Completed in ${assembly.execution_duration.toFixed(1)}s`;

  if (assembly.uploads && assembly.results) {
    const totalSteps = Object.keys(assembly.results).length;
    const completedSteps = Object.values(assembly.results).filter(
      (r) => r.length > 0
    ).length;
    return `🔄 Processing (${completedSteps}/${totalSteps} steps)`;
  }

  return "🔄 Processing...";
}
```

### 3. **Error Recovery**

```typescript
// Retry failed status checks
async function robustStatusCheck(
  assemblyId: string,
  maxRetries = 3
): Promise<AssemblyStatus | null> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await getAssemblyStatus(assemblyId);
    } catch (error) {
      if (attempt === maxRetries) throw error;

      // Exponential backoff
      const delay = Math.pow(2, attempt) * 1000;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  return null;
}
```

## Migration from SSE/Redis

### Breaking Changes

1. **Remove EventSource** - Replace with fetch() polling
2. **Remove stream endpoints** - Use status endpoints
3. **Update component state** - Store AssemblyStatus objects
4. **Remove Redis dependency** - No more Redis client needed

### Migration Steps

```typescript
// Before (SSE)
const eventSource = new EventSource(
  `/api/transflow/stream?uploadId=${uploadId}`
);
eventSource.onmessage = (event) => {
  const data = JSON.parse(event.data);
  updateProgress(data);
};

// After (Polling)
const pollInterval = setInterval(async () => {
  const assembly = await getAssemblyStatus(assemblyId);
  if (assembly) {
    updateStatus(assembly);
    if (assembly.ok || assembly.error) {
      clearInterval(pollInterval);
    }
  }
}, 2000);
```

## Advanced Usage

### Batch Status Checking

```typescript
// Check multiple assemblies efficiently
async function getBatchStatus(
  assemblyIds: string[]
): Promise<Record<string, AssemblyStatus | null>> {
  const results: Record<string, AssemblyStatus | null> = {};

  // Parallel requests (be mindful of DynamoDB read limits)
  const promises = assemblyIds.map(async (id) => {
    try {
      const status = await getAssemblyStatus(id);
      results[id] = status;
    } catch (error) {
      results[id] = null;
    }
  });

  await Promise.all(promises);
  return results;
}
```

### Status Caching

```typescript
// Client-side caching for completed jobs
const statusCache = new Map<string, AssemblyStatus>();

async function getCachedStatus(
  assemblyId: string
): Promise<AssemblyStatus | null> {
  const cached = statusCache.get(assemblyId);
  if (cached && (cached.ok || cached.error)) {
    return cached; // Return cached completed/errored jobs
  }

  const fresh = await getAssemblyStatus(assemblyId);
  if (fresh) {
    statusCache.set(assemblyId, fresh);
  }
  return fresh;
}
```

This status tracking system provides reliable, efficient, and secure job status management without the complexity of real-time streaming protocols.

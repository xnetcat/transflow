# Transflow

**Serverless media processing for Next.js**

Transform audio, video, and images with zero-config TypeScript templates deployed as AWS Lambda containers.

## Features

- 🎬 **Custom Processing** - Write TypeScript templates using ffmpeg/ffprobe
- ⚡ **Serverless** - AWS Lambda containers with Node.js 20 + ffmpeg + libvips
- 🌿 **Shared Infrastructure** - Single Lambda/SQS/DynamoDB for all branches
- 📊 **Rich Status Tracking** - DynamoDB-based with Transloadit-like response data
- 🔐 **Deterministic Job IDs** - Based on file hash + template + user ID
- 🪝 **Webhook Support** - Optional POST notifications with HMAC signing
- 🚀 **Zero Config CI/CD** - GitHub Actions with OIDC
- 🔒 **Type Safe** - Full TypeScript support throughout

## Quick Start

### 1. Install

```bash
npm install -D @xnetcat/transflow
```

### 2. Configure

Create `transflow.config.js`:

```js
module.exports = {
  project: "myapp",
  region: "us-east-1",

  // S3 buckets (created if missing, never deleted)
  s3: {
    buckets: ["myapp-uploads", "myapp-outputs"],
    mode: "prefix", // uploads/{branch}/, outputs/{branch}/
    uploadBucket: "myapp-uploads",
    outputBucket: "myapp-outputs",
    userIsolation: true, // uploads/{branch}/users/{userId}/
  },

  // Container registry
  ecrRepo: "transflow-worker",
  lambdaPrefix: "transflow-worker-",
  templatesDir: "./templates",
  lambdaBuildContext: "./lambda",

  // DynamoDB (required for status tracking)
  dynamoDb: {
    tableName: "TransflowJobs",
  },

  // SQS (required for processing)
  sqs: {
    queueName: "myapp-processing.fifo",
    visibilityTimeoutSec: 960,
    maxReceiveCount: 3,
    batchSize: 10,
  },

  // Optional: Dedicated status Lambda
  statusLambda: {
    enabled: true,
    functionName: "myapp-status",
    memoryMb: 512,
    timeoutSec: 30,
  },

  // Authentication (optional)
  auth: {
    requireAuth: true,
    jwtSecret: process.env.JWT_SECRET,
    userIdClaim: "sub",
  },

  lambda: {
    memoryMb: 2048,
    timeoutSec: 900,
    roleArn: process.env.TRANSFLOW_LAMBDA_ROLE_ARN,
  },
};
```

### 3. Create a Template

Create `templates/audio-preview.ts`:

```ts
import type { TemplateDefinition, StepContext } from "@xnetcat/transflow";

async function makePreview(ctx: StepContext) {
  const args = [
    "-i",
    ctx.inputLocalPath,
    "-t",
    "30", // 30 second preview
    "-acodec",
    "libmp3lame",
    "-ab",
    "128k",
    `${ctx.tmpDir}/preview.mp3`,
  ];

  const { code, stderr } = await ctx.utils.execFF(args);
  if (code !== 0) throw new Error(`ffmpeg failed: ${stderr}`);

  await ctx.utils.uploadResult(
    `${ctx.tmpDir}/preview.mp3`,
    "preview.mp3",
    "audio/mpeg"
  );
}

export default {
  id: "audio-preview",
  webhookUrl: "https://myapp.com/webhooks/transflow", // Optional
  webhookSecret: process.env.WEBHOOK_SECRET, // Optional
  steps: [{ name: "preview", run: makePreview }],
} as TemplateDefinition;
```

### 4. Add Next.js API Routes

```ts
// pages/api/transflow/create-upload.ts
import { createUploadHandler } from "@xnetcat/transflow";
import config from "../../../transflow.config";

export default createUploadHandler(config);
```

```ts
// pages/api/transflow/status.ts
import { createStatusHandler } from "@xnetcat/transflow";
import config from "../../../transflow.config";

export default createStatusHandler(config);
```

### 5. Add Upload Component with Status Polling

```tsx
import { Uploader, TransflowProvider } from "@xnetcat/transflow";
import { useState } from "react";
import type { AssemblyStatus } from "@xnetcat/transflow";

export default function App() {
  const [assemblies, setAssemblies] = useState<AssemblyStatus[]>([]);

  const handleUpdate = (assembly: AssemblyStatus) => {
    setAssemblies((prev) => {
      const existing = prev.findIndex(
        (a) => a.assembly_id === assembly.assembly_id
      );
      if (existing >= 0) {
        const updated = [...prev];
        updated[existing] = assembly;
        return updated;
      }
      return [...prev, assembly];
    });
  };

  return (
    <TransflowProvider
      endpoints={{
        action: "/api/transflow/create-upload",
        status: "/api/transflow/status",
      }}
    >
      <div>
        <h1>Media Processing</h1>

        {/* File uploader with real-time status */}
        <Uploader template="audio-preview" onUpdate={handleUpdate} />

        {/* Status display */}
        {assemblies.map((assembly) => (
          <div key={assembly.assembly_id}>
            <h3>Job {assembly.assembly_id.slice(-8)}</h3>
            <p>Status: {assembly.ok || assembly.error || "Processing..."}</p>

            {assembly.uploads?.map((upload) => (
              <div key={upload.id}>
                📁 {upload.name} ({(upload.size / 1024).toFixed(1)} KB)
              </div>
            ))}

            {Object.entries(assembly.results || {}).map(([step, results]) => (
              <div key={step}>
                <strong>{step}:</strong>
                {results.map((result) => (
                  <div key={result.id}>
                    <a
                      href={result.ssl_url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      📎 {result.name}
                    </a>
                  </div>
                ))}
              </div>
            ))}
          </div>
        ))}
      </div>
    </TransflowProvider>
  );
}
```

### 6. Deploy

```bash
# Bake templates and deploy shared infrastructure
npx transflow bake --config transflow.config.js
npx transflow deploy --branch main --sha $(git rev-parse HEAD) --config transflow.config.js
```

## Architecture Highlights

### **Deterministic Job Tracking**

Every file upload gets a deterministic `assembly_id` that can be used to check status:

```typescript
// Get status by assembly ID
const response = await fetch(`/api/transflow/status?assemblyId=${assemblyId}`);
const status: AssemblyStatus = await response.json();
```

### **Rich Status Data**

Complete job information in single response:

```json
{
  "assembly_id": "abc123...",
  "ok": "ASSEMBLY_COMPLETED",
  "message": "Processing completed successfully",
  "uploads": [{"name": "input.mp3", "size": 1024, ...}],
  "results": {
    "preview": [{"name": "preview.mp3", "ssl_url": "https://...", ...}]
  },
  "execution_duration": 5.2,
  "bytes_expected": 1024,
  "bytes_received": 1024,
  "created_at": "2023-...",
  "updated_at": "2023-..."
}
```

### **Optional Webhook Notifications**

Templates can trigger webhooks on completion:

```typescript
// Webhook payload = complete AssemblyStatus
// Headers include HMAC signature if secret provided
"X-Transflow-Signature": "sha256=abc123..."
```

### **Shared Resource Benefits**

- **Cost Effective**: Single infrastructure serves unlimited branches
- **Simple Management**: No per-branch resource cleanup needed
- **Consistent Monitoring**: All jobs in one DynamoDB table
- **Easy Debugging**: Single Lambda function to monitor

## CLI Commands

- `transflow bake` - Bundle TypeScript templates for deployment
- `transflow deploy` - Deploy shared infrastructure to AWS
- `transflow cleanup` - Clean branch-specific S3 prefixes (never touches shared resources)
- `transflow status --assembly <id>` - Check job status by assembly ID
- `transflow check` - Verify Docker/AWS CLI setup

## Status Lambda (Optional)

For high-frequency status checks or direct API access:

```typescript
import { StatusLambdaClient } from "@xnetcat/transflow";

const client = new StatusLambdaClient({
  region: "us-east-1",
  functionName: "myapp-status",
});

// Get status
const result = await client.getStatus("assembly_123", "user_456");

// Get status + trigger webhook
const result = await client.getStatusWithWebhook("assembly_123", "user_456");
```

## Documentation

- **[Architecture](docs/ARCHITECTURE.md)** - Shared resource design and data flow
- **[Status Lambda](docs/STATUS_LAMBDA.md)** - Dedicated status checking Lambda
- **[Templates](docs/TEMPLATES.md)** - Writing custom processing templates
- **[Deployment](docs/DEPLOYMENT.md)** - AWS setup and deployment guide
- **[GitHub Actions](docs/WORKFLOWS.md)** - CI/CD configuration
- **[IAM Policies](docs/IAM.md)** - Required AWS permissions
- **[Security](docs/SECURITY.md)** - Multi-tenant security guide
- **[Troubleshooting](docs/TROUBLESHOOTING.md)** - Common issues and solutions

## Migration from v0.x

**Breaking Changes:**

- ❌ **Removed Redis** - No more Redis dependency
- ❌ **Removed SSE** - No more EventSource/Server-Sent Events
- ❌ **No Progress Queues** - Eliminated SQS progress streaming
- ✅ **DynamoDB Required** - Single source of truth for status
- ✅ **Polling-based UI** - Simple REST API calls every 2-5 seconds
- ✅ **Shared Resources** - One Lambda/SQS/DynamoDB for all branches

**Upgrade Steps:**

1. Update config: Remove `redis`, ensure `dynamoDb` is present
2. Update API routes: Replace `stream.ts` with `status.ts`
3. Update components: Replace SSE with polling (`useEffect` + `fetch`)
4. Redeploy: Run `transflow deploy` with new configuration

## Example

See the complete [Next.js example app](examples/next-app/) for a working implementation with status polling and rich UI.

## License

MIT

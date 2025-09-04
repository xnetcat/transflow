# Transflow

**Serverless media processing for Next.js**

Transform audio, video, and images with zero-config TypeScript templates deployed as AWS Lambda containers.

## Features

- 🎬 **Custom Processing** - Write TypeScript templates using ffmpeg/ffprobe
- ⚡ **Serverless** - AWS Lambda containers with Node.js 20 + ffmpeg + libvips
- 🌿 **Branch Isolation** - Per-branch deployments with S3 prefix or bucket modes
- 📡 **Real-time Updates** - Live progress via Server-Sent Events
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
  s3: {
    mode: "prefix",
    uploadBucket: "myapp-uploads",
    outputBucket: "myapp-outputs",
  },
  ecrRepo: "transflow-worker",
  lambdaPrefix: "transflow-worker-",
  templatesDir: "./templates",
  lambdaBuildContext: "./lambda",
  // Redis (required for real-time updates)
  // Single instance shared across all branches with branch-aware channels
  redis: {
    provider: "upstash",
    restUrl: process.env.REDIS_REST_URL,
    token: process.env.REDIS_TOKEN,
  },

  // DynamoDB (optional job persistence)
  // Single table with branch isolation via composite keys (branch#uploadId)
  dynamoDb: {
    enabled: process.env.TRANSFLOW_DDB_ENABLED === "true",
    tableName: process.env.TRANSFLOW_DDB_TABLE,
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
    "30",
    "-acodec",
    "libmp3lame",
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
  steps: [{ name: "preview", run: makePreview }],
} as TemplateDefinition;
```

### 4. Add Next.js API Routes

```ts
// pages/api/transflow/create-upload.ts
import { createUploadHandler } from "@xnetcat/transflow";
const cfg = require("../../transflow.config.js");
export default createUploadHandler(cfg);
```

```ts
// pages/api/transflow/stream.ts
import { createStreamHandler } from "@xnetcat/transflow";
export default createStreamHandler(process.env.REDIS_URL!);
```

### 5. Add Upload Component

```tsx
import { Uploader, TransflowProvider } from "@xnetcat/transflow";

export default function App() {
  return (
    <TransflowProvider
      endpoints={{
        action: "/api/transflow/create-upload",
        stream: "/api/transflow/stream",
      }}
    >
      <Uploader template="audio-preview" onUpdate={(msg) => console.log(msg)} />
    </TransflowProvider>
  );
}
```

### 6. Deploy

```bash
# Bake templates and deploy
npx transflow bake --config transflow.config.js
npx transflow deploy --branch main --sha $(git rev-parse HEAD) --config transflow.config.js
```

## CLI Commands

- `transflow bake` - Bundle TypeScript templates for deployment
- `transflow deploy` - Build Docker image and deploy to AWS
- `transflow cleanup` - Remove branch resources
- `transflow local:run` - Test templates locally
- `transflow check` - Verify Docker/AWS CLI setup

## Documentation

- **[Architecture](docs/ARCHITECTURE.md)** - System design and data flow
- **[Templates](docs/TEMPLATES.md)** - Writing custom processing templates
- **[Deployment](docs/DEPLOYMENT.md)** - AWS setup and deployment guide
- **[Multi-Branch](docs/MULTI-BRANCH.md)** - Shared resources with branch isolation
- **[GitHub Actions](docs/WORKFLOWS.md)** - CI/CD configuration
- **[IAM Policies](docs/IAM.md)** - Required AWS permissions
- **[Troubleshooting](docs/TROUBLESHOOTING.md)** - Common issues and solutions

## Example

See the complete [Next.js example app](examples/next-app/) for a working implementation.

## License

MIT

### Transflow

Serverless media-processing for Next.js with S3 + Lambda (container images) + Redis (+ optional DynamoDB). Templates are written in TypeScript and baked into the Lambda image at deploy time.

- Zero runtime fetch of templates — no cold-config dependencies
- Per-branch isolation (bucket or prefix mode)
- GitHub Actions copy-paste workflows with OIDC
- Docker-only build on the runner

### Install

Use npx or install globally:

```bash
npm install -D @xnetcat/transflow
# or global
npm i -g @xnetcat/transflow
```

### Quick start

1. Create `transflow.config.json` in your app repo (copy and edit from `assets/transflow.config.sample.json`).

```json
{
  "project": "myapp",
  "region": "us-east-1",
  "s3": {
    "mode": "prefix",
    "uploadBucket": "myapp-uploads",
    "outputBucket": "myapp-outputs"
  },
  "ecrRepo": "transflow-worker",
  "lambdaPrefix": "transflow-worker-",
  "templatesDir": "./templates",
  "lambdaBuildContext": "./lambda",
  "redis": {
    "provider": "upstash",
    "restUrl": "https://xxx.upstash.io",
    "token": "UPSTASH_TOKEN"
  },
  "dynamoDb": { "enabled": true, "tableName": "TransflowJobs" },
  "lambda": {
    "memoryMb": 2048,
    "timeoutSec": 900,
    "roleArn": "arn:aws:iam::<ACCOUNT_ID>:role/transflow-lambda-role"
  }
}
```

2. Put templates in `./templates/*.ts` (see Template API below).

3. Bake and deploy per-branch:

```bash
transflow bake --config transflow.config.json
transflow deploy --branch feature-x --sha <commit-sha> --config transflow.config.json --yes
```

4. Next.js routes (use the package helpers):

```ts
// pages/api/create-upload.ts
import { createUploadHandler } from "@xnetcat/transflow";
import cfg from "../../transflow.config.json";
export default createUploadHandler(cfg);
```

```ts
// pages/api/stream.ts
import { createStreamHandler } from "@xnetcat/transflow";
export default createStreamHandler(process.env.REDIS_URL!);
```

5. In your UI:

```tsx
import { Uploader } from "@xnetcat/transflow";
<Uploader action="/api/create-upload" onUpdate={(m) => console.log(m)} />;
```

### CLI commands

- `transflow bake` — bundles TypeScript templates via esbuild into the Docker build context; emits `templates/` and `templates.index.cjs` and compiles the runtime handler into `dist/lambda/handler.js`.
- `transflow deploy` — builds a Lambda container image (Node 20 + ffmpeg + libvips for sharp), pushes to ECR, creates/updates the Lambda per branch, ensures S3 buckets and notifications exist, and sets env vars.
- `transflow cleanup` — removes S3 notifications for the branch, deletes the branch Lambda, and optionally deletes storage and ECR images.
- `transflow local:run --file <path>` — runs a baked template locally using your local ffmpeg/ffprobe; writes results under `.transflow-outputs/` by default.
- `transflow check` — checks Docker/AWS CLI availability.

### Branch isolation modes

- `prefix` (default): single upload and output buckets. Per-branch prefixes: `uploads/<branch>/...`, `outputs/<branch>/...`.
- `bucket`: creates one bucket per branch: `<project>-<safe-branch>`. Both upload and outputs use this bucket.

`safe-branch` is the sanitized branch name: lowercased, non-alphanumeric chars → `-`, collapsed repeats.

### Template authoring (TypeScript)

Templates export a `TemplateDefinition` with `id` and `steps[]`. Each step is an async function receiving a `StepContext` with helpers.

```ts
import type { TemplateDefinition, StepContext } from "@xnetcat/transflow";

async function makePreview(ctx: StepContext) {
  const out = ctx.utils.generateKey("preview.mp3");
  // Use local input file path
  const args = ["-i", ctx.inputLocalPath, "-t", "30", "-acodec", "libmp3lame", "-y", `${ctx.tmpDir}/preview.mp3`];
  const { code, stderr } = await ctx.utils.execFF(args);
  if (code !== 0) throw new Error(`ffmpeg failed: ${stderr}`);
  await ctx.utils.uploadResult(`${ctx.tmpDir}/preview.mp3", "preview.mp3", "audio/mpeg");
}

const tpl: TemplateDefinition = { id: "tpl_basic_audio", steps: [{ name: "preview", run: makePreview }] };
export default tpl;
```

See `docs/TEMPLATES.md` for full API details.

### GitHub Actions

Option A: Use the provided composite Action directly:

```yaml
name: Transflow Deploy
on: [push]
jobs:
  deploy:
    runs-on: ubuntu-latest
    permissions:
      id-token: write
      contents: read
    steps:
      - uses: xnetcat/transflow@v0
        with:
          mode: deploy
          branch: ${{ github.ref_name }}
          sha: ${{ github.sha }}
          config: transflow.config.json
          yes: true
          aws-region: ${{ secrets.AWS_REGION }}
          role-to-assume: ${{ secrets.AWS_ROLE_ARN }}
```

Option B: Copy `assets/workflows/deploy.yml` and `assets/workflows/cleanup.yml` into `.github/workflows/` and set repository secrets:

- `AWS_ROLE_ARN` — the OIDC role to assume in your AWS account
- `AWS_REGION` — e.g. `us-east-1`
- `UPSTASH_TOKEN` (if using Upstash REST), and any other app secrets

The deploy workflow runs on every push and calls:

```bash
npx transflow bake --config transflow.config.json
npx transflow deploy --branch ${{ github.ref_name }} --sha ${{ github.sha }} --config transflow.config.json --yes
```

See `docs/WORKFLOWS.md` for details.

### IAM policies

Provide two roles:

- GitHub Actions deploy role (assumed by OIDC) — ECR push, Lambda create/update/delete, S3 bucket/notification ops, logs, optional DynamoDB, and iam:PassRole for the Lambda execution role
- Lambda execution role — S3 Get/Put (scoped to prefixes/buckets), CloudWatch Logs, optional DynamoDB

See `docs/IAM.md` for sample policies to adapt.

### Redis and SSE

- Redis is required for realtime progress (Upstash recommended). The worker publishes to channels `upload:<uploadId>`.
- The `createStreamHandler` provides a simple SSE endpoint for the browser to subscribe to messages.

Env vars used by the Lambda:

- `REDIS_URL` or `REDIS_REST_URL` + `REDIS_REST_TOKEN`
- `TRANSFLOW_BRANCH`, `OUTPUT_BUCKET`, and optionally `DYNAMODB_TABLE`

### Local development

Bake first, then run:

```bash
transflow bake --config transflow.config.json
transflow local:run --config transflow.config.json --file ./path/to/media.wav --template tpl_basic_audio --out ./local-out
```

Requires `ffmpeg` and `ffprobe` installed locally.

### Acceptance checklist

- Push a branch — workflow deploys `transflow-worker-<branch>` image tagged `<branch>-<sha>`
- Upload a file using the Uploader — it lands under `uploads/<branch>/...`
- Lambda triggers, processes, and writes outputs to `outputs/<branch>/...`
- SSE stream receives progress updates
- Optional: DynamoDB row exists in `TransflowJobs`
- Branch delete triggers cleanup workflow (removes Lambda + S3 notification; optional storage/ECR cleanup)

### Troubleshooting

- Missing `templates.index.cjs` during deploy: run `transflow bake` first
- Docker push auth errors: ensure `aws ecr get-login-password` works in the environment
- No SSE updates: check Redis URL/token; verify CloudWatch logs

### License

MIT

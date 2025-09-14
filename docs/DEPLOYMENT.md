# Deployment Guide

This guide covers setting up AWS infrastructure and deploying Transflow pipelines.

## Prerequisites

### Local Requirements

- **Node.js 18+** - Runtime for CLI and builds
- **Docker** - For building Lambda container images
- **AWS CLI** - For authentication and resource management
- **Git** - For branch-based deployments

Verify setup:

```bash
npx transflow check
```

### AWS Requirements

- **AWS Account** with programmatic access
- **IAM permissions** for ECR, Lambda, S3, CloudWatch (see [IAM Guide](IAM.md))
- **ECR repository** (created automatically)
- **S3 buckets** (explicitly listed in config; created if missing; never deleted)

## Configuration

### 1. Create Config File

Create `transflow.config.js` in your project root:

```js
module.exports = {
  project: process.env.TRANSFLOW_PROJECT || "myapp",
  region: process.env.AWS_REGION || "us-east-1",

  // S3 configuration
  s3: {
    // Explicit list of buckets to ensure exist (never deleted)
    buckets: [
      process.env.TRANSFLOW_UPLOAD_BUCKET || "myapp-uploads",
      process.env.TRANSFLOW_OUTPUT_BUCKET || "myapp-outputs",
    ],
    // Optional legacy prefix mode (kept for back-compat)
    mode: process.env.TRANSFLOW_S3_MODE || "prefix",
    uploadBucket: process.env.TRANSFLOW_UPLOAD_BUCKET || "myapp-uploads",
    outputBucket: process.env.TRANSFLOW_OUTPUT_BUCKET || "myapp-outputs",
  },

  // Container registry
  ecrRepo: process.env.TRANSFLOW_ECR_REPO || "transflow-worker",

  // Lambda configuration
  lambdaPrefix: process.env.TRANSFLOW_LAMBDA_PREFIX || "transflow-worker-",
  lambdaBuildContext: process.env.TRANSFLOW_BUILD_CONTEXT || "./lambda",
  templatesDir: process.env.TRANSFLOW_TEMPLATES_DIR || "./templates",

  // SQS (required for real-time updates)
  sqs: {
    // Shared queues across all branches
    queueName: process.env.TRANSFLOW_SQS_QUEUE || "myapp-processing.fifo",
    progressQueueName:
      process.env.TRANSFLOW_SQS_PROGRESS_QUEUE || "myapp-progress.fifo",
    visibilityTimeoutSec: 960,
    maxReceiveCount: 3,
    batchSize: 10,
  },

  // DynamoDB (optional job persistence)
  // Single table with branch isolation via composite keys (branch#uploadId)
  dynamoDb: {
    enabled: process.env.TRANSFLOW_DDB_ENABLED === "true",
    tableName: process.env.TRANSFLOW_DDB_TABLE,
  },

  // Lambda runtime settings
  lambda: {
    memoryMb: Number(process.env.TRANSFLOW_LAMBDA_MEMORY_MB || 2048), // 128-10240
    timeoutSec: Number(process.env.TRANSFLOW_LAMBDA_TIMEOUT_SEC || 900), // 1-900
    architecture: process.env.TRANSFLOW_LAMBDA_ARCH || "x86_64", // "x86_64" | "arm64"
    roleArn: process.env.TRANSFLOW_LAMBDA_ROLE_ARN, // IAM role for Lambda execution
  },
};
```

### 2. Environment Variables

Set these in your environment (`.env.local`, GitHub secrets, etc.):

```bash
# AWS
AWS_REGION=us-east-1
TRANSFLOW_PROJECT=myapp

# Redis (Upstash recommended)
REDIS_REST_URL=https://your-db.upstash.io
REDIS_TOKEN=your-token

# Lambda IAM role
TRANSFLOW_LAMBDA_ROLE_ARN=arn:aws:iam::123456789012:role/transflow-lambda-role

# S3 (prefix mode)
TRANSFLOW_UPLOAD_BUCKET=myapp-uploads
TRANSFLOW_OUTPUT_BUCKET=myapp-outputs

# Optional: DynamoDB job tracking
TRANSFLOW_DDB_ENABLED=true
TRANSFLOW_DDB_TABLE=TransflowJobs
```

## Branch Isolation Modes

### Prefix Mode (Recommended)

- **Upload bucket**: `myapp-uploads`
- **Output bucket**: `myapp-outputs`
- **Prefixes**: `uploads/{branch}/`, `outputs/{branch}/`
- **Lambda functions**: `transflow-worker-{branch}`

```js
s3: {
  mode: "prefix",
  uploadBucket: "myapp-uploads",
  outputBucket: "myapp-outputs"
}
```

**Pros**: Simple bucket management, cost-effective
**Cons**: Shared buckets across branches

### Bucket Mode

- **Per-branch buckets**: `myapp-{branch}` (e.g., `myapp-main`, `myapp-feature-x`)
- **Both uploads and outputs**: Same bucket per branch
- **Lambda functions**: `transflow-worker-{branch}`

```js
s3: {
  mode: "bucket",
  baseBucket: "myapp"  // Creates myapp-{branch} buckets
}
```

**Pros**: Complete isolation, easier security policies
**Cons**: More S3 buckets to manage

## Manual Deployment

### 1. Bake Templates

Compile TypeScript templates and prepare build context:

```bash
npx transflow bake --config transflow.config.js
```

This creates:

- `./lambda/templates/` - Compiled JavaScript modules
- `./lambda/templates.index.cjs` - Template registry
- `./lambda/dist/lambda/handler.js` - Runtime handler
- `./lambda/package.json` - Runtime dependencies
- `./lambda/Dockerfile` - Container definition

### 2. Deploy Infrastructure

Deploy to specific branch:

```bash
npx transflow deploy \
  --branch main \
  --sha $(git rev-parse HEAD) \
  --config transflow.config.js \
  --yes
```

This will:

1. **Create ECR repository** (if not exists)
2. **Build Docker image** with Node.js 20 + ffmpeg + libvips
3. **Push to ECR** with tag `{branch}-{sha}`
4. **Create/update Lambda function** named `{prefix}-{branch}`
5. **Create S3 buckets** (if not exists)
6. **Configure S3 notifications** to trigger Lambda
7. **Set environment variables** for branch, Redis, S3 config

### 3. Verify Deployment

Check that resources were created:

```bash
# List Lambda functions
aws lambda list-functions --query 'Functions[?starts_with(FunctionName, `transflow-worker-`)].FunctionName'

# Check ECR images
aws ecr describe-images --repository-name transflow-worker

# Verify S3 buckets
aws s3 ls | grep transflow
```

## Automated Deployment

### Using GitHub Actions Composite Action

The simplest approach - use the provided composite action:

```yaml
# .github/workflows/deploy.yml
name: Transflow Deploy
on: [push]

jobs:
  deploy:
    runs-on: ubuntu-latest
    permissions:
      id-token: write # OIDC
      contents: read
    steps:
      - uses: xnetcat/transflow@v0
        with:
          mode: deploy
          branch: ${{ github.ref_name }}
          sha: ${{ github.sha }}
          config: transflow.config.js
          yes: true
          aws-region: ${{ secrets.AWS_REGION }}
          role-to-assume: ${{ secrets.AWS_ROLE_ARN }}
```

### Custom GitHub Actions Workflow

For more control, copy the workflow templates:

```bash
# Copy workflow templates to your repo
cp node_modules/@xnetcat/transflow/assets/workflows/* .github/workflows/
```

Edit `.github/workflows/deploy.yml`:

```yaml
name: Transflow Deploy
on:
  push:
    branches: ["**"]

jobs:
  deploy:
    runs-on: ubuntu-latest
    permissions:
      id-token: write
      contents: read
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm

      - run: npm ci

      - name: Bake templates
        run: npx transflow bake --config transflow.config.js

      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ secrets.AWS_ROLE_ARN }}
          role-session-name: transflow-deploy
          aws-region: ${{ secrets.AWS_REGION }}

      - name: Deploy
        run: |
          npx transflow deploy \
            --branch "${{ github.ref_name }}" \
            --sha "${{ github.sha }}" \
            --config transflow.config.js \
            --yes
```

### Repository Secrets

Configure these secrets in your GitHub repository:

- `AWS_ROLE_ARN` - IAM role for OIDC authentication
- `AWS_REGION` - AWS region (e.g., `us-east-1`)
- `REDIS_REST_URL` - Upstash Redis REST endpoint
- `REDIS_TOKEN` - Upstash Redis token

## Branch Cleanup

### Automatic Cleanup on Branch Delete

Configure cleanup workflow:

```yaml
# .github/workflows/cleanup.yml
name: Transflow Cleanup
on:
  delete:
    branches: ["**"]

jobs:
  cleanup:
    if: github.event.ref_type == 'branch'
    runs-on: ubuntu-latest
    permissions:
      id-token: write
      contents: read
    steps:
      - uses: actions/checkout@v4
        with:
          ref: main # Checkout main since branch was deleted

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm

      - run: npm ci

      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ secrets.AWS_ROLE_ARN }}
          aws-region: ${{ secrets.AWS_REGION }}

      - name: Cleanup
        run: |
          npx transflow cleanup \
            --branch "${{ github.event.ref }}" \
            --config transflow.config.js \
            --yes
```

### Manual Cleanup

Remove branch resources manually:

```bash
npx transflow cleanup \
  --branch feature-branch \
  --config transflow.config.js \
  --delete-storage \  # Remove S3 objects
  --delete-ecr-images \ # Remove ECR images
  --yes
```

## Multi-Environment Setup

### Development/Staging/Production

Use separate configs per environment:

```js
// transflow.config.dev.js
module.exports = {
  project: "myapp-dev",
  region: "us-east-1",
  s3: {
    mode: "prefix",
    uploadBucket: "myapp-dev-uploads",
    outputBucket: "myapp-dev-outputs",
  },
  // ... rest of config
};
```

Deploy with specific config:

```bash
npx transflow deploy \
  --config transflow.config.dev.js \
  --branch staging \
  --sha $(git rev-parse HEAD)
```

### Region-Specific Deployments

Deploy to multiple regions:

```bash
# US East
AWS_REGION=us-east-1 npx transflow deploy --config transflow.config.js --branch main --sha $(git rev-parse HEAD)

# EU West
AWS_REGION=eu-west-1 npx transflow deploy --config transflow.config.js --branch main --sha $(git rev-parse HEAD)
```

## Monitoring & Logs

### CloudWatch Logs

Lambda logs are automatically sent to CloudWatch:

```bash
# View recent logs
aws logs tail /aws/lambda/transflow-worker-main --follow

# Search for errors
aws logs filter-log-events \
  --log-group-name /aws/lambda/transflow-worker-main \
  --filter-pattern "ERROR"
```

### Lambda Insights (Optional)

Enable enhanced monitoring:

```js
// In deploy configuration
lambda: {
  memoryMb: 2048,
  timeoutSec: 900,
  layers: [
    "arn:aws:lambda:us-east-1:580247275435:layer:LambdaInsightsExtension:14"
  ]
}
```

### Custom Metrics

Templates can publish custom CloudWatch metrics:

```ts
// In template step
await ctx.utils.publish({
  type: "metric",
  name: "ProcessingDuration",
  value: processingTimeMs,
  unit: "Milliseconds",
});
```

## Performance Tuning

### Memory Configuration

Higher memory = more CPU and better performance:

```js
lambda: {
  memoryMb: 3008,  // ~2 vCPUs
  timeoutSec: 600
}
```

**Guidelines**:

- **Audio processing**: 1024-2048 MB
- **Video transcoding**: 2048-4096 MB
- **4K video**: 4096-10240 MB

### Container Optimization

Optimize Docker builds for faster cold starts:

```dockerfile
# Custom Dockerfile for faster builds
FROM public.ecr.aws/lambda/nodejs:20

# Install dependencies in separate layer for caching
RUN yum install -y tar gzip xz

# Cache ffmpeg download
COPY install-ffmpeg.sh .
RUN ./install-ffmpeg.sh

# Application code last (changes most frequently)
COPY package*.json ./
RUN npm ci --omit=dev

COPY . .
CMD ["dist/lambda/handler.handler"]
```

### Architecture Selection

Choose based on your needs:

- **x86_64**: Broader software compatibility, more instance types
- **arm64**: Better price/performance ratio, newer Graviton processors

```js
lambda: {
  architecture: "arm64",  // 20% better price/performance
  memoryMb: 2048
}
```

## Troubleshooting

### Common Issues

**Build failures**: Ensure Docker is running and authenticated
**Deploy timeouts**: Increase Lambda timeout or reduce memory
**S3 permissions**: Verify IAM role has proper S3 access
**Redis connection**: Check network connectivity and credentials

See [Troubleshooting Guide](TROUBLESHOOTING.md) for detailed solutions.

### Debug Mode

Enable verbose logging:

```bash
DEBUG=transflow:* npx transflow deploy --config transflow.config.js --branch debug --sha $(git rev-parse HEAD)
```

### Local Testing

Test before deploying:

```bash
# Bake templates
npx transflow bake --config transflow.config.js

# Test locally
npx transflow local:run \
  --file test-media/sample.mp4 \
  --template video-compress \
  --config transflow.config.js
```

This deployment guide covers the essentials of setting up and managing Transflow in production. For advanced configurations and troubleshooting, see the additional documentation files.

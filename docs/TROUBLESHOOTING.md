# Troubleshooting Guide

Common issues and solutions for Transflow deployment and operation.

## Build & Deployment Issues

### Missing `templates.index.cjs` during deploy

**Error**: `Error: ENOENT: no such file or directory, open './lambda/templates.index.cjs'`

**Cause**: Templates haven't been baked before deployment.

**Solution**:

```bash
# Run bake first
npx transflow bake --config transflow.config.js
npx transflow deploy --branch main --sha $(git rev-parse HEAD) --config transflow.config.js
```

In CI/CD, ensure bake step runs before deploy:

```yaml
- name: Bake templates
  run: npx transflow bake --config transflow.config.js
- name: Deploy
  run: npx transflow deploy --branch main --sha ${{ github.sha }} --config transflow.config.js --yes
```

### Docker authentication errors

**Error**: `Error response from daemon: unauthorized: authentication required`

**Cause**: Docker not authenticated with ECR or AWS credentials expired.

**Solution**:

```bash
# Re-authenticate with ECR
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin 123456789012.dkr.ecr.us-east-1.amazonaws.com

# Verify AWS credentials
aws sts get-caller-identity

# Check Docker is running
docker info
```

### Docker build context issues

**Error**: `Error: ENOENT: no such file or directory, scandir './lambda'`

**Cause**: Lambda build context directory doesn't exist or is misconfigured.

**Solution**:

```bash
# Check build context path in config
cat transflow.config.js | grep lambdaBuildContext

# Ensure bake creates the directory
npx transflow bake --config transflow.config.js
ls -la ./lambda/

# Verify Dockerfile exists
ls -la ./lambda/Dockerfile
```

### ECR repository access denied

**Error**: `RepositoryNotFoundException: The repository with name 'transflow-worker' does not exist`

**Cause**: ECR repository doesn't exist or insufficient permissions.

**Solution**:

```bash
# Create repository manually
aws ecr create-repository --repository-name transflow-worker --region us-east-1

# Check IAM permissions for ECR
aws iam simulate-principal-policy \
  --policy-source-arn arn:aws:iam::123456789012:role/transflow-deploy-role \
  --action-names ecr:CreateRepository ecr:DescribeRepositories \
  --resource-arns "*"
```

## Lambda Function Issues

### Lambda function creation failed

**Error**: `InvalidParameterValueException: The role defined for the function cannot be assumed by Lambda`

**Cause**: Lambda execution role trust policy is incorrect or missing.

**Solution**:

```bash
# Check role trust policy
aws iam get-role --role-name transflow-lambda-role --query 'Role.AssumeRolePolicyDocument'

# Should include Lambda service principal
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Service": "lambda.amazonaws.com"
      },
      "Action": "sts:AssumeRole"
    }
  ]
}
```

### Lambda timeout errors

**Error**: `Task timed out after 900.00 seconds`

**Cause**: Processing taking longer than configured timeout.

**Solution**:

```js
// Increase timeout in config
lambda: {
  memoryMb: 3008,  // More memory = more CPU
  timeoutSec: 900, // Maximum allowed
}
```

Or optimize templates:

```ts
// Use more efficient ffmpeg settings
const args = [
  "-i",
  ctx.inputLocalPath,
  "-preset",
  "ultrafast", // Faster encoding
  "-crf",
  "28", // Lower quality for speed
  outputPath,
];
```

### Lambda out of memory

**Error**: `Runtime.OutOfMemory: RequestId: xxx Process exited before completing request`

**Cause**: Insufficient memory allocation for media processing.

**Solution**:

```js
// Increase memory allocation
lambda: {
  memoryMb: 10240,  // Maximum: 10GB
  timeoutSec: 900
}
```

Clean up temp files in templates:

```ts
async function cleanupStep(ctx: StepContext) {
  const tempFile = `${ctx.tmpDir}/large-intermediate.mp4`;

  try {
    // Process file
    await processFile(tempFile);
  } finally {
    // Clean up immediately
    try {
      fs.unlinkSync(tempFile);
    } catch {}
  }
}
```

### Lambda cold start issues

**Error**: Long delays on first invocation after deployment.

**Cause**: Container image is large or has many dependencies.

**Solution**:
Optimize Docker image:

```dockerfile
# Multi-stage build to reduce size
FROM public.ecr.aws/lambda/nodejs:20 as base

# Install system dependencies in one layer
RUN yum install -y tar gzip xz libvips && \
    curl -L -o /tmp/ffmpeg.tar.xz https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz && \
    mkdir -p /opt/ffmpeg && \
    tar -xJf /tmp/ffmpeg.tar.xz -C /opt/ffmpeg --strip-components=1 && \
    ln -s /opt/ffmpeg/ffmpeg /usr/local/bin/ffmpeg && \
    ln -s /opt/ffmpeg/ffprobe /usr/local/bin/ffprobe && \
    rm -f /tmp/ffmpeg.tar.xz && \
    yum clean all

# Copy dependencies first (cached layer)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy app code last (changes most frequently)
COPY . .
CMD ["dist/lambda/handler.handler"]
```

## S3 Issues

### S3 event notifications not triggering Lambda

**Error**: Files uploaded but Lambda not executing.

**Cause**: S3 notification configuration missing or incorrect.

**Solution**:

```bash
# Check bucket notifications
aws s3api get-bucket-notification-configuration --bucket myapp-uploads

# Should show Lambda configuration for your prefix
{
  "LambdaConfigurations": [
    {
      "Id": "...",
      "LambdaFunctionArn": "arn:aws:lambda:us-east-1:123456789012:function:transflow-worker-main",
      "Events": ["s3:ObjectCreated:*"],
      "Filter": {
        "Key": {
          "FilterRules": [
            {
              "Name": "prefix",
              "Value": "uploads/main/"
            }
          ]
        }
      }
    }
  ]
}

# Check Lambda has permission to be invoked by S3
aws lambda get-policy --function-name transflow-worker-main
```

### S3 access denied errors

**Error**: `AccessDenied: Access Denied` when uploading or downloading.

**Cause**: Insufficient IAM permissions or bucket policy restrictions.

**Solution**:

```bash
# Test S3 access with AWS CLI
aws s3 cp test.txt s3://myapp-uploads/uploads/main/test.txt
aws s3 ls s3://myapp-uploads/uploads/main/

# Check IAM policy for Lambda execution role
aws iam list-attached-role-policies --role-name transflow-lambda-role
aws iam get-policy-version --policy-arn arn:aws:iam::123456789012:policy/TransflowExecutionPolicy --version-id v1
```

Verify S3 permissions:

```json
{
  "Effect": "Allow",
  "Action": ["s3:GetObject", "s3:HeadObject"],
  "Resource": "arn:aws:s3:::myapp-uploads/uploads/*"
}
```

### S3 bucket in wrong region

**Error**: `IllegalLocationConstraintException: The unspecified location constraint is incompatible`

**Cause**: S3 bucket and Lambda function in different regions.

**Solution**:

```bash
# Check bucket region
aws s3api get-bucket-location --bucket myapp-uploads

# Check Lambda region
aws lambda get-function --function-name transflow-worker-main

# Ensure they match in config
module.exports = {
  region: "us-east-1",  // Same region for both
  s3: {
    uploadBucket: "myapp-uploads",
    outputBucket: "myapp-outputs"
  }
};
```

## Status Tracking Issues

### No status updates received

**Error**: Status polling returns 404 or empty responses.

**Cause**: DynamoDB not configured or assembly_id incorrect.

**Solution**:

```bash
# Test DynamoDB connectivity
aws dynamodb describe-table --table-name TransflowJobs --region us-east-1

# Check status API endpoint directly
curl "http://localhost:3000/api/transflow/status?assemblyId=test-assembly-123"

# Verify environment variables in Lambda
aws lambda get-function-configuration --function-name transflow-worker-main \
  --query 'Environment.Variables'
```

Check Next.js API route:

```ts
// pages/api/transflow/status.ts
import { createStatusHandler } from "@xnetcat/transflow";
import config from "../../../transflow.config";

export default createStatusHandler(config);
```

### Assembly not found errors

**Error**: 404 responses when checking status.

**Causes & Fixes**:

- Assembly ID mismatch between upload and status check
  - Ensure `fileHash` or `md5hash` is provided during upload
  - Verify same templateId and userId are used
- DynamoDB table doesn't exist
  - Check table name in configuration matches deployed table
  - Verify region matches between Lambda and DynamoDB
- Lambda lacks DynamoDB permissions
  - Attach policy allowing `PutItem`, `GetItem`, `UpdateItem` on status table

## Template Issues

### Template compilation errors

**Error**: `Build failed with 1 error: src/templates/my-template.ts:10:5: ERROR: Cannot resolve module`

**Cause**: Import path issues or missing dependencies.

**Solution**:

```ts
// Use relative imports for local modules
import { helper } from "./utils/helper";

// Use full package names for node_modules
import path from "path";
import fs from "fs";

// Don't import React/DOM types in templates
// Templates run in Node.js, not browser
```

### ffmpeg command failures

**Error**: `ffmpeg failed with code 1: Unknown encoder 'libx264'`

**Cause**: ffmpeg binary doesn't include required codec.

**Solution**:

```ts
// Check available encoders first
const { stdout } = await ctx.utils.execFF(["-encoders"]);
console.log("Available encoders:", stdout);

// Use alternative codec
const args = [
  "-i",
  ctx.inputLocalPath,
  "-c:v",
  "libx265", // Alternative to libx264
  "-preset",
  "medium",
  outputPath,
];
```

### Template runtime errors

**Error**: `Error: Template not found: my-template`

**Cause**: Template ID mismatch or not included in bake.

**Solution**:

```bash
# Check baked templates
cat ./lambda/templates.index.cjs

# Should include your template:
module.exports = {
  "my-template": require('./templates/my-template.js'),
  // ...
};

# Verify template export
head -n 20 ./lambda/templates/my-template.js
```

Ensure proper export:

```ts
export default {
  id: "my-template", // Must match usage
  steps: [
    /* ... */
  ],
} as TemplateDefinition;
```

## Local Development Issues

### Local ffmpeg not found

**Error**: `spawn ffmpeg ENOENT`

**Cause**: ffmpeg not installed on local system.

**Solution**:

```bash
# macOS
brew install ffmpeg

# Ubuntu/Debian
sudo apt update && sudo apt install ffmpeg

# Windows (with Chocolatey)
choco install ffmpeg

# Verify installation
ffmpeg -version
ffprobe -version
```

### Local DynamoDB testing

**Error**: DynamoDB connection failed when testing locally.

**Cause**: Local development requires DynamoDB configuration.

**Solution**:

```bash
# Use DynamoDB Local for testing
docker run -d -p 8000:8000 amazon/dynamodb-local

# Or use AWS DynamoDB directly (recommended)
export DYNAMODB_TABLE="TransflowJobs"
export AWS_REGION="us-east-1"

# Create table for testing
aws dynamodb create-table \
  --table-name TransflowJobs \
  --attribute-definitions AttributeName=assembly_id,AttributeType=S \
  --key-schema AttributeName=assembly_id,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --region us-east-1
```

## GitHub Actions Issues

### OIDC authentication failed

**Error**: `Error: Could not assume role with OIDC: Access denied`

**Cause**: OIDC provider or trust policy misconfigured.

**Solution**:

```bash
# Check OIDC provider exists
aws iam list-open-id-connect-providers

# Check trust policy includes correct repository
aws iam get-role --role-name transflow-deploy-role \
  --query 'Role.AssumeRolePolicyDocument.Statement[0].Condition'

# Should include:
{
  "StringLike": {
    "token.actions.githubusercontent.com:sub": "repo:your-org/your-repo:*"
  }
}
```

### GitHub Actions timeout

**Error**: Workflow exceeds time limits.

**Cause**: Docker build or deployment taking too long.

**Solution**:

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    timeout-minutes: 30 # Increase timeout

    steps:
      - name: Build and deploy
        timeout-minutes: 20 # Per-step timeout
        run: |
          npx transflow bake --config transflow.config.js
          npx transflow deploy --branch main --sha ${{ github.sha }} --config transflow.config.js --yes
```

### Secrets not available

**Error**: Environment variables are undefined.

**Cause**: Repository secrets not configured or referenced incorrectly.

**Solution**:

```yaml
# Correct secret reference
env:
  REDIS_REST_URL: ${{ secrets.REDIS_REST_URL }}
  REDIS_TOKEN: ${{ secrets.REDIS_TOKEN }}
# Not: ${{ env.REDIS_REST_URL }} (env is for job variables)
```

## Performance Issues

### Slow processing times

**Issue**: Template execution takes much longer than expected.

**Solutions**:

1. **Increase Lambda memory**:

```js
lambda: {
  memoryMb: 10240,  // More memory = more CPU
  timeoutSec: 900
}
```

2. **Optimize ffmpeg settings**:

```ts
// Use faster presets for real-time processing
const args = [
  "-i",
  ctx.inputLocalPath,
  "-preset",
  "ultrafast", // vs "slow"
  "-tune",
  "zerolatency", // for low latency
  outputPath,
];
```

3. **Process in parallel**:

```ts
// Process multiple outputs concurrently
await Promise.all([
  generateThumbnail(ctx),
  createPreview(ctx),
  extractMetadata(ctx),
]);
```

### High Lambda costs

**Issue**: Unexpected AWS charges from Lambda execution.

**Solutions**:

1. **Optimize memory allocation**:

```js
// Find optimal memory/cost balance
lambda: {
  memoryMb: 1769,  // Often optimal price/performance
  timeoutSec: 300  // Reduce if possible
}
```

2. **Reduce cold starts**:

```bash
# Smaller Docker images
docker build --squash -t image:tag .

# Pre-warm with scheduled events
aws events put-rule --name transflow-warmer --schedule-expression "rate(5 minutes)"
```

## Debug Mode

Enable comprehensive logging:

```bash
# CLI debug mode
DEBUG=transflow:* npx transflow deploy --config transflow.config.js

# Lambda debug logs
aws logs tail /aws/lambda/transflow-worker-main --follow

# Docker build debug
DOCKER_BUILDKIT_PROGRESS=plain npx transflow deploy --config transflow.config.js
```

Template debugging:

```ts
async function debugStep(ctx: StepContext) {
  console.log("Context:", JSON.stringify(ctx, null, 2));
  console.log("Input file size:", fs.statSync(ctx.inputLocalPath).size);
  console.log("Temp dir contents:", fs.readdirSync(ctx.tmpDir));

  // Debug logs are automatically captured in CloudWatch
  console.log("Debug info:", {
    uploadId: ctx.uploadId,
    branch: ctx.branch,
    template: ctx.input.key,
    step: "debug-step",
  });
}
```

## Getting Help

If issues persist:

1. **Check logs**: CloudWatch Logs for Lambda execution details
2. **Enable debug mode**: Use `DEBUG=transflow:*` for verbose output
3. **Test locally**: Use `transflow local:run` to isolate issues
4. **Verify IAM**: Ensure all required permissions are granted
5. **Check versions**: Ensure compatible Node.js, Docker, and AWS CLI versions

For additional support, create an issue on GitHub with:

- Error messages and stack traces
- Configuration file (redacted)
- Steps to reproduce
- Environment details (Node.js, Docker, AWS CLI versions)

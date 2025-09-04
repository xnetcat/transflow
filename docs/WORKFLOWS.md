# GitHub Actions Workflows

This guide covers setting up CI/CD workflows for automated Transflow deployments using GitHub Actions.

## Overview

Transflow provides two approaches for GitHub Actions integration:

1. **Composite Action** - Simple, one-step setup using the provided action
2. **Custom Workflows** - Full control with workflow templates

Both approaches support:

- **OIDC Authentication** - No long-lived AWS credentials
- **Branch-based Deployments** - Each branch gets its own Lambda function
- **Automatic Cleanup** - Remove resources when branches are deleted
- **Matrix Builds** - Deploy to multiple regions/environments

## Quick Setup with Composite Action

### 1. Repository Configuration

Set these secrets in your GitHub repository settings:

- `AWS_ROLE_ARN` - IAM role for deployment (see [IAM Guide](IAM.md))
- `AWS_REGION` - Primary AWS region (e.g., `us-east-1`)
- `REDIS_REST_URL` - Upstash Redis REST endpoint
- `REDIS_TOKEN` - Upstash Redis authentication token

### 2. Simple Deploy Workflow

Create `.github/workflows/deploy.yml`:

```yaml
name: Transflow Deploy
on: [push]

jobs:
  deploy:
    runs-on: ubuntu-latest
    permissions:
      id-token: write # Required for OIDC
      contents: read # Required for checkout
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

### 3. Cleanup Workflow

Create `.github/workflows/cleanup.yml`:

```yaml
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
          ref: main # Use main branch since deleted branch is unavailable

      - uses: xnetcat/transflow@v0
        with:
          mode: cleanup
          branch: ${{ github.event.ref }}
          config: transflow.config.js
          yes: true
          aws-region: ${{ secrets.AWS_REGION }}
          role-to-assume: ${{ secrets.AWS_ROLE_ARN }}
```

## Custom Workflows

For more control, use the provided workflow templates:

### 1. Copy Templates

```bash
# Copy workflow templates to your repository
mkdir -p .github/workflows
cp node_modules/@xnetcat/transflow/assets/workflows/* .github/workflows/
```

### 2. Deploy Workflow

`.github/workflows/deploy.yml`:

```yaml
name: Transflow Deploy

on:
  push:
    branches: ["**"] # Deploy all branches
  workflow_dispatch: # Manual trigger
    inputs:
      branch:
        description: "Branch to deploy"
        required: true
        default: "main"

jobs:
  deploy:
    runs-on: ubuntu-latest
    permissions:
      id-token: write
      contents: read

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Bake templates
        run: npx transflow bake --config transflow.config.js

      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ secrets.AWS_ROLE_ARN }}
          role-session-name: transflow-deploy-${{ github.run_id }}
          aws-region: ${{ secrets.AWS_REGION }}

      - name: Deploy to AWS
        run: |
          npx transflow deploy \
            --branch "${{ github.event.inputs.branch || github.ref_name }}" \
            --sha "${{ github.sha }}" \
            --config transflow.config.js \
            --yes
        env:
          REDIS_REST_URL: ${{ secrets.REDIS_REST_URL }}
          REDIS_TOKEN: ${{ secrets.REDIS_TOKEN }}
```

### 3. Cleanup Workflow

`.github/workflows/cleanup.yml`:

```yaml
name: Transflow Cleanup

on:
  delete:
    branches: ["**"]
  workflow_dispatch:
    inputs:
      branch:
        description: "Branch to cleanup"
        required: true
      delete-storage:
        description: "Delete S3 objects"
        type: boolean
        default: false
      delete-ecr-images:
        description: "Delete ECR images"
        type: boolean
        default: false

jobs:
  cleanup:
    if: github.event.ref_type == 'branch' || github.event_name == 'workflow_dispatch'
    runs-on: ubuntu-latest
    permissions:
      id-token: write
      contents: read

    steps:
      - name: Checkout
        uses: actions/checkout@v4
        with:
          ref: main # Use main since branch might be deleted

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ secrets.AWS_ROLE_ARN }}
          role-session-name: transflow-cleanup-${{ github.run_id }}
          aws-region: ${{ secrets.AWS_REGION }}

      - name: Cleanup resources
        run: |
          BRANCH="${{ github.event.ref || github.event.inputs.branch }}"
          ARGS=(--branch "$BRANCH" --config transflow.config.js --yes)

          if [ "${{ github.event.inputs.delete-storage }}" = "true" ]; then
            ARGS+=(--delete-storage)
          fi

          if [ "${{ github.event.inputs.delete-ecr-images }}" = "true" ]; then
            ARGS+=(--delete-ecr-images)
          fi

          npx transflow cleanup "${ARGS[@]}"
```

## Advanced Configurations

### Multi-Environment Deployment

Deploy to multiple environments with different configurations:

```yaml
name: Multi-Environment Deploy

on:
  push:
    branches: [main, staging, develop]

jobs:
  deploy:
    runs-on: ubuntu-latest
    permissions:
      id-token: write
      contents: read

    strategy:
      matrix:
        include:
          - branch: main
            environment: production
            config: transflow.config.prod.js
            aws-region: us-east-1
          - branch: staging
            environment: staging
            config: transflow.config.staging.js
            aws-region: us-west-2
          - branch: develop
            environment: development
            config: transflow.config.dev.js
            aws-region: us-east-1

    environment: ${{ matrix.environment }}

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm

      - run: npm ci

      - name: Bake templates
        run: npx transflow bake --config ${{ matrix.config }}

      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ secrets.AWS_ROLE_ARN }}
          aws-region: ${{ matrix.aws-region }}

      - name: Deploy
        run: |
          npx transflow deploy \
            --branch "${{ matrix.branch }}" \
            --sha "${{ github.sha }}" \
            --config ${{ matrix.config }} \
            --yes
        env:
          REDIS_REST_URL: ${{ secrets.REDIS_REST_URL }}
          REDIS_TOKEN: ${{ secrets.REDIS_TOKEN }}
```

### Multi-Region Deployment

Deploy the same branch to multiple regions:

```yaml
name: Multi-Region Deploy

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    permissions:
      id-token: write
      contents: read

    strategy:
      matrix:
        region: [us-east-1, eu-west-1, ap-southeast-1]

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
          aws-region: ${{ matrix.region }}

      - name: Deploy to ${{ matrix.region }}
        run: |
          npx transflow deploy \
            --branch "${{ github.ref_name }}" \
            --sha "${{ github.sha }}" \
            --config transflow.config.js \
            --yes
        env:
          AWS_REGION: ${{ matrix.region }}
          REDIS_REST_URL: ${{ secrets.REDIS_REST_URL }}
          REDIS_TOKEN: ${{ secrets.REDIS_TOKEN }}
```

### Conditional Deployment

Deploy only when specific conditions are met:

```yaml
name: Conditional Deploy

on:
  push:
    branches: ["**"]
    paths:
      - "templates/**"
      - "transflow.config.js"
      - ".github/workflows/deploy.yml"

jobs:
  changes:
    runs-on: ubuntu-latest
    outputs:
      templates: ${{ steps.changes.outputs.templates }}
      config: ${{ steps.changes.outputs.config }}
    steps:
      - uses: actions/checkout@v4
      - uses: dorny/paths-filter@v2
        id: changes
        with:
          filters: |
            templates:
              - 'templates/**'
            config:
              - 'transflow.config.js'

  deploy:
    needs: changes
    if: ${{ needs.changes.outputs.templates == 'true' || needs.changes.outputs.config == 'true' }}
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
          aws-region: ${{ secrets.AWS_REGION }}

      - name: Deploy
        run: |
          npx transflow deploy \
            --branch "${{ github.ref_name }}" \
            --sha "${{ github.sha }}" \
            --config transflow.config.js \
            --yes
        env:
          REDIS_REST_URL: ${{ secrets.REDIS_REST_URL }}
          REDIS_TOKEN: ${{ secrets.REDIS_TOKEN }}
```

## Testing & Validation

### Pre-deployment Testing

Add testing steps before deployment:

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm

      - run: npm ci

      - name: Type check
        run: npx tsc --noEmit

      - name: Test templates compilation
        run: npx transflow bake --config transflow.config.js

      - name: Run tests
        run: npm test

      - name: Test local template execution
        run: |
          # Install ffmpeg for local testing
          sudo apt-get update
          sudo apt-get install -y ffmpeg

          # Test template with sample file
          npx transflow local:run \
            --file test/fixtures/sample.mp3 \
            --template audio-preview \
            --config transflow.config.js

  deploy:
    needs: test
    # ... deployment steps
```

### Post-deployment Validation

Verify deployment success:

```yaml
- name: Validate deployment
  run: |
    # Check Lambda function exists
    aws lambda get-function \
      --function-name "transflow-worker-${{ github.ref_name }}" \
      --region ${{ secrets.AWS_REGION }}
      
    # Check S3 bucket configuration
    aws s3api get-bucket-notification-configuration \
      --bucket "${{ env.UPLOAD_BUCKET }}" \
      --region ${{ secrets.AWS_REGION }}
      
    # Test Redis connectivity (if accessible)
    curl -X GET "${{ secrets.REDIS_REST_URL }}/ping" \
      -H "Authorization: Bearer ${{ secrets.REDIS_TOKEN }}"
```

## Notification & Monitoring

### Slack Notifications

Send deployment status to Slack:

```yaml
- name: Notify Slack on success
  if: success()
  uses: 8398a7/action-slack@v3
  with:
    status: success
    text: "✅ Transflow deployed successfully to branch `${{ github.ref_name }}`"
  env:
    SLACK_WEBHOOK_URL: ${{ secrets.SLACK_WEBHOOK_URL }}

- name: Notify Slack on failure
  if: failure()
  uses: 8398a7/action-slack@v3
  with:
    status: failure
    text: "❌ Transflow deployment failed for branch `${{ github.ref_name }}`"
  env:
    SLACK_WEBHOOK_URL: ${{ secrets.SLACK_WEBHOOK_URL }}
```

### GitHub Deployment Status

Track deployments in GitHub:

```yaml
- name: Create deployment
  uses: actions/github-script@v6
  id: deployment
  with:
    script: |
      const deployment = await github.rest.repos.createDeployment({
        owner: context.repo.owner,
        repo: context.repo.repo,
        ref: context.sha,
        environment: 'production',
        auto_merge: false
      });
      return deployment.data.id;

- name: Update deployment status
  if: always()
  uses: actions/github-script@v6
  with:
    script: |
      await github.rest.repos.createDeploymentStatus({
        owner: context.repo.owner,
        repo: context.repo.repo,
        deployment_id: ${{ steps.deployment.outputs.result }},
        state: '${{ job.status }}',
        environment_url: 'https://console.aws.amazon.com/lambda/home'
      });
```

## Composite Action Reference

### Inputs

| Input            | Description                                 | Required | Default                  |
| ---------------- | ------------------------------------------- | -------- | ------------------------ |
| `mode`           | Action mode: `bake`, `deploy`, or `cleanup` | Yes      | -                        |
| `branch`         | Branch name for deploy/cleanup              | No       | `${{ github.ref_name }}` |
| `sha`            | Git SHA for deploy                          | No       | `${{ github.sha }}`      |
| `tag`            | Docker image tag override                   | No       | `{branch}-{sha}`         |
| `config`         | Path to config file                         | No       | `transflow.config.json`  |
| `yes`            | Non-interactive mode                        | No       | `false`                  |
| `node-version`   | Node.js version                             | No       | `20`                     |
| `aws-region`     | AWS region                                  | No       | -                        |
| `role-to-assume` | IAM role ARN for OIDC                       | No       | -                        |

### Example Usage

```yaml
- uses: xnetcat/transflow@v0
  with:
    mode: deploy
    branch: ${{ github.ref_name }}
    sha: ${{ github.sha }}
    config: transflow.config.js
    yes: true
    aws-region: us-east-1
    role-to-assume: arn:aws:iam::123456789012:role/transflow-deploy
```

## Troubleshooting

### Common Workflow Issues

**OIDC Authentication Fails**

- Verify OIDC provider is configured in AWS
- Check repository name in trust policy
- Ensure role ARN is correct

**Docker Build Fails**

- Check Docker daemon availability on runner
- Verify ECR permissions in IAM role
- Check build context path in config

**S3 Permissions Issues**

- Verify bucket names match configuration
- Check IAM permissions for S3 operations
- Ensure region consistency

**Lambda Deployment Timeouts**

- Increase workflow timeout
- Check Lambda function memory/timeout settings
- Verify ECR image size isn't too large

### Debug Mode

Enable debug logging:

```yaml
- name: Debug deployment
  run: |
    npx transflow deploy \
      --branch "${{ github.ref_name }}" \
      --sha "${{ github.sha }}" \
      --config transflow.config.js \
      --yes
  env:
    DEBUG: transflow:*
    ACTIONS_STEP_DEBUG: true
```

This workflow guide provides comprehensive CI/CD setup for Transflow deployments. Choose the approach that best fits your team's needs and security requirements.

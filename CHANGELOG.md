# Changelog

## 1.1.0 — 2026-04-27

### Added

- **LocalStack-friendly client factory** (`src/core/awsClients.ts`). All AWS clients now respect `cfg.endpoint` / `TRANSFLOW_AWS_ENDPOINT`, `cfg.credentials` / `TRANSFLOW_AWS_*` env vars, and force S3 path-style addressing automatically when an endpoint is configured.
- **New CLI commands**:
  - `transflow bake --out <dir>` — build `templates.index.cjs` + runtime context locally.
  - `transflow local:start` — provision LocalStack-side buckets, queue, DDB table, and the S3 → SQS notification.
  - `transflow local:worker [--templates-index <path>]` — long-lived process that polls SQS and runs the Lambda handler in-process. Replaces the Lambda for local e2e.
- **Cost-optimization defaults applied by `deploy`**:
  - S3 lifecycle on the tmp bucket (`uploads/` expires after `s3.tmpRetentionDays`, default 7; `outputs/` after 4×; abort multipart after 1 day).
  - DynamoDB TTL on `ttl` attribute (`dynamoDb.ttlDays`, default 30).
  - ECR lifecycle policy keeps last `ecr.retainImages` (default 10) images.
  - Reserved Lambda concurrency cap (default 10).
  - Configurable `s3.corsAllowedOrigins`.
- **`sqs.fifo` toggle** — set to `false` to let S3 deliver events straight to SQS, halving Lambda invocations per upload. Recommended for most production deployments and required for the S3 → SQS direct path used by `local:start`.
- **Webhook helper** (`src/core/webhook.ts`) — single source of truth for HMAC-signed retry-with-backoff webhooks; both lambda handlers use it.
- **`exportToBucket` populates `results`** — previously only `uploadResult` did, which meant DDB `results` was empty even when files were exported.
- **Dependency updates** — AWS SDK 3.948 → 3.1037, esbuild 0.23 → 0.28, yargs 17 → 18, zod 3 → 4, typescript 5.9 → 6.0, vitest 2 → 3, jsdom 26 → 29, aws-sdk-client-mock 3 → 4. (Held back: `execa`/`ora` v9 — pure ESM; `vitest@4` — broken mock-constructor semantics; `react@19` — peer-dep change.)
- **CI** — switched to bun (root + example), added Node 24-ready `actions/checkout@v5` and `actions/setup-node@v5`, added a LocalStack-backed e2e job that runs the full integration suite.
- **Docs** — full README rewrite with config table, dual mermaid diagrams (FIFO vs standard SQS), LocalStack walkthrough.

### Fixed

- **Batch-upload race**: two SQS messages sharing an `assembly_id` ran as parallel `processJob` calls and clobbered DDB `uploads`. The handler now merges jobs by `assembly_id` before processing so each assembly has exactly one writer.
- **`x-amz-checksum-crc32` rejection**: AWS SDK ≥3.660 auto-attaches a CRC32 header on PUTs, which older LocalStack/MinIO releases reject. The S3 client factory sets `requestChecksumCalculation: "WHEN_REQUIRED"` to opt out.
- **`parseSQSJobs` shape detection**: now handles three message bodies — pre-parsed `ProcessingJob`, S3 event from a direct S3 → SQS notification, or `s3:TestEvent` (skipped silently).
- **`local:run`**: `ctx.inputsLocalPaths` was undefined; templates that iterated it crashed. Also missing the `exportToBucket` shim. Both fixed.
- **`local:start`** now applies the same S3 lifecycle policy `deploy` does, for parity with prod.
- **GitHub Actions templates** (`assets/workflows/*`): removed the redundant `bake` step (deploy bakes internally) and added `docker/setup-buildx-action`.

### Removed

- `src/lambda/sqsBridge.{ts,test.ts}` — was orphaned (deploy.ts:521 already noted it).
- Dead auth code in `src/server/auth.ts` (`extractUserContext`, `generateUserPath`, `generateUserOutputPath`, `validateUserAccess`, error classes, `sanitizePathComponent`). Kept `validateContentType` and `validateFileSize` which are actually used.
- `UserContext` type and `StepContext.user` / `AssemblyStatus.user` fields — were defined in types but never populated anywhere.
- Stale `ioredis` dependency in the runtime `package.json` emitted by `bake` (SSE was removed; ioredis was a leftover).

### Replaced (internal)

- `aws sts get-caller-identity`, `aws ecr get-login-password`, and `aws dynamodb create-table` shell-outs in `deploy.ts` are now SDK calls (ECR `GetAuthorizationToken`, DynamoDB `Describe/CreateTableCommand`).

## 1.0.0

Initial release.

export interface TransflowConfig {
  project: string;
  region: string;
  awsProfile?: string;
  s3: {
    // Optional explicit list of export buckets (never deleted)
    exportBuckets?: string[];
    userIsolation?: boolean; // Enable user-based path isolation
    maxFileSize?: number; // Max file size in bytes
    allowedContentTypes?: string[]; // Restrict file types
  };
  ecrRepo: string;
  // When using shared resources, this is the single function name to deploy
  lambdaPrefix: string;
  templatesDir: string;
  // Removed; build context derived from project root
  dynamoDb: {
    tableName: string; // REQUIRED: single table for job/status storage
  };
  lambda: {
    memoryMb: number;
    timeoutSec: number;
    architecture?: "x86_64" | "arm64";
    roleArn?: string;
    reservedConcurrency?: number; // Limit concurrent executions
    maxBatchSize?: number; // Max files to process per invocation
  };
  // Optional dedicated status Lambda for user-facing status checks
  // Status Lambda is automatically deployed with name: {project}-status
  sqs: {
    // Shared processing queue across all branches
    queueName?: string;
    visibilityTimeoutSec?: number;
    maxReceiveCount?: number; // For DLQ
    batchSize?: number; // SQS batch size (1-10)
  };
  // auth removed
}

export interface StepContextUtils {
  execFF: (
    args: string[],
    opts?: { env?: Record<string, string>; cwd?: string }
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
  execProbe: (
    args: string[],
    opts?: { env?: Record<string, string>; cwd?: string }
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
  uploadResult: (
    localPath: string,
    key: string,
    contentType?: string
  ) => Promise<{ bucket: string; key: string; url?: string }>;
  uploadResults?: (
    files: Array<{ localPath: string; key: string; contentType?: string }>
  ) => Promise<Array<{ bucket: string; key: string }>>;
  uploadToKey?: (
    localPath: string,
    absoluteKey: string,
    contentType?: string
  ) => Promise<{ bucket: string; key: string }>;
  exportToBucket?: (
    localPath: string,
    key: string,
    bucketName: string,
    contentType?: string
  ) => Promise<{ bucket: string; key: string }>;
  addArtifact?: (
    name: string,
    localPath: string,
    contentType?: string,
    absoluteKey?: string
  ) => void;
  generateKey: (basename: string) => string;
  /** @deprecated SSE removed, use DynamoDB status polling instead */
  publish: (message: Record<string, unknown>) => Promise<void>;
}

export interface UserContext {
  userId: string;
  permissions?: string[];
  metadata?: Record<string, unknown>;
}

export interface StepContext {
  uploadId: string;
  input: { bucket: string; key: string; contentType?: string };
  inputLocalPath: string;
  inputs?: Array<{ bucket: string; key: string; contentType?: string }>;
  inputsLocalPaths?: string[];
  output: { bucket: string; prefix: string };
  branch: string;
  awsRegion: string;
  utils: StepContextUtils;
  tmpDir: string;
  // Arbitrary, small metadata provided by the client at upload time
  // (e.g., slug, timestamp, previewStartTime, previewEndTime)
  fields?: Record<string, string>;
  // User context for secure processing
  user?: UserContext;
}

export interface TemplateStep {
  name: string;
  run: (ctx: StepContext) => Promise<void>;
}

export interface TemplateDefinition {
  id: string;
  outputPrefix?: string;
  // Optional override for where results should be stored.
  // If not provided, the handler will use OUTPUT_BUCKET env or fallback to the input bucket.
  outputBucket?: string;
  // Optional: webhook URL to notify on completion/error with assembly payload
  webhookUrl?: string;
  // Optional: secret for HMAC signing of webhook payload (X-Transflow-Signature header)
  webhookSecret?: string;
  steps: TemplateStep[];
}

export interface BakedTemplateIndexEntry {
  id: string;
  path: string; // relative path inside the image, e.g. templates/tpl_basic_audio.js
}

export interface BakeResult {
  outDir: string;
  entries: BakedTemplateIndexEntry[];
  indexFile: string; // templates.index.cjs path
}

export interface DeployOptions {
  branch: string;
  sha: string;
  tag?: string; // optional override tag
  yes?: boolean; // non-interactive
  configPath?: string;
  forceRebuild?: boolean; // force docker image rebuild
}

export interface CleanupOptions {
  branch: string;
  yes?: boolean;
  deleteStorage?: boolean;
  deleteEcrImages?: boolean;
  configPath?: string;
}

export interface CheckResult {
  dockerAvailable: boolean;
  awsCliAvailable: boolean;
  nodeVersion: string;
}

// Final job/assembly record shape (simplified Transloadit-like)
export interface AssemblyStatus {
  assembly_id: string;
  ok?: "ASSEMBLY_COMPLETED";
  error?: string;
  message?: string;
  warnings?: string[];
  account_id?: string;
  assembly_ssl_url?: string;
  assembly_url?: string;
  bytes_expected?: number;
  bytes_received?: number;
  bytes_usage?: number;
  execution_duration?: number;
  execution_start?: string;
  jobs_queue_duration?: number;
  last_job_completed?: string;
  // Progress tracking
  progress_pct?: number; // 0-100
  steps_total?: number;
  steps_completed?: number;
  current_step?: number; // 1-based index of current step
  current_step_name?: string;
  // Client-side upload progress (ephemeral, not guaranteed to persist server-side)
  upload_progress_pct?: number; // 0-100
  merged_params?: Record<string, unknown>;
  uploads?: Array<{
    id: string;
    name: string;
    basename: string;
    ext: string;
    size: number;
    mime?: string;
    field?: string;
    md5hash?: string;
    meta?: Record<string, unknown>;
  }>;
  results?: Record<
    string,
    Array<{
      id: string;
      name: string;
      basename: string;
      ext: string;
      size: number;
      mime?: string;
      field?: string;
      original_id?: string;
      ssl_url?: string;
      meta?: Record<string, unknown>;
    }>
  >;
  instance?: string;
  project?: string;
  branch?: string;
  template_id?: string;
  user?: { userId: string };
  updated_at?: string;
  created_at?: string;
}

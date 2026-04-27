export interface TransflowAwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface TransflowConfig {
  project: string;
  region: string;
  awsProfile?: string;
  /**
   * Optional custom endpoint (e.g. http://localhost:4566 for LocalStack).
   * When set, every AWS client routes through this URL and S3 forces path-style.
   * Can also be supplied via TRANSFLOW_AWS_ENDPOINT.
   */
  endpoint?: string;
  /**
   * Static credentials override. Useful for LocalStack ("test"/"test") or CI.
   * Can also be supplied via TRANSFLOW_AWS_ACCESS_KEY_ID / SECRET_ACCESS_KEY.
   */
  credentials?: TransflowAwsCredentials;
  s3: {
    exportBuckets?: string[];
    maxFileSize?: number;
    allowedContentTypes?: string[];
    /** Force path-style addressing (auto-enabled when endpoint is set). */
    forcePathStyle?: boolean;
    /** CORS AllowedOrigins for the tmp bucket. Defaults to ["*"]. */
    corsAllowedOrigins?: string[];
    /** Days after which uploads/ objects in the tmp bucket expire. Defaults to 7. */
    tmpRetentionDays?: number;
  };
  ecrRepo: string;
  /** Optional ECR config. */
  ecr?: {
    /** Keep only the last N images in the repo. Defaults to 10. */
    retainImages?: number;
  };
  lambdaPrefix: string;
  templatesDir: string;
  dynamoDb: {
    tableName: string;
    /** TTL in days for assembly records. 0 disables TTL. Defaults to 30. */
    ttlDays?: number;
  };
  lambda: {
    memoryMb: number;
    timeoutSec: number;
    architecture?: "x86_64" | "arm64";
    roleArn?: string;
    /** Cap on concurrent Lambda executions. Defaults to 10. */
    reservedConcurrency?: number;
    maxBatchSize?: number;
  };
  sqs: {
    queueName?: string;
    visibilityTimeoutSec?: number;
    maxReceiveCount?: number;
    batchSize?: number;
    /** FIFO queue with content-based dedupe. Defaults to true. */
    fifo?: boolean;
  };
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
  fields?: Record<string, string>;
}

export interface TemplateStep {
  name: string;
  run: (ctx: StepContext) => Promise<void>;
}

export interface TemplateDefinition {
  id: string;
  outputPrefix?: string;
  outputBucket?: string;
  webhookUrl?: string;
  webhookSecret?: string;
  steps: TemplateStep[];
}

export interface BakedTemplateIndexEntry {
  id: string;
  path: string;
}

export interface BakeResult {
  outDir: string;
  entries: BakedTemplateIndexEntry[];
  indexFile: string;
}

export interface DeployOptions {
  branch: string;
  sha: string;
  tag?: string;
  yes?: boolean;
  configPath?: string;
  forceRebuild?: boolean;
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
  progress_pct?: number;
  steps_total?: number;
  steps_completed?: number;
  current_step?: number;
  current_step_name?: string;
  upload_progress_pct?: number;
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
  updated_at?: string;
  created_at?: string;
  /** Epoch seconds when DynamoDB will expire this record. */
  ttl?: number;
}

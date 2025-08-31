export type BranchIsolationMode = "bucket" | "prefix";

export interface TransflowConfig {
  project: string;
  region: string;
  awsProfile?: string;
  s3: {
    mode: BranchIsolationMode;
    uploadBucket?: string; // required for prefix mode
    outputBucket?: string; // required for prefix mode
    baseBucket?: string; // optional base name for bucket-per-branch
  };
  ecrRepo: string;
  lambdaPrefix: string;
  templatesDir: string;
  lambdaBuildContext: string;
  redis: {
    provider: "upstash" | "ioredis";
    restUrl?: string;
    token?: string;
    url?: string;
  };
  dynamoDb?: {
    enabled: boolean;
    tableName?: string;
  };
  lambda: {
    memoryMb: number;
    timeoutSec: number;
    architecture?: "x86_64" | "arm64";
    roleArn?: string;
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
  generateKey: (basename: string) => string;
  publish: (message: Record<string, unknown>) => Promise<void>;
}

export interface StepContext {
  uploadId: string;
  input: { bucket: string; key: string; contentType?: string };
  inputLocalPath: string;
  output: { bucket: string; prefix: string };
  branch: string;
  awsRegion: string;
  utils: StepContextUtils;
  tmpDir: string;
}

export interface TemplateStep {
  name: string;
  run: (ctx: StepContext) => Promise<void>;
}

export interface TemplateDefinition {
  id: string;
  outputPrefix?: string;
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

export type UploadEventMessage =
  | { type: "start"; key: string; templateId: string }
  | { type: "step:start"; step: string }
  | { type: "step:done"; step: string }
  | { type: "ffprobe"; stdout: string }
  | {
      type: "done";
      status: "completed";
      templateId: string;
      uploadId: string;
      outputsPrefix: string;
      input: { bucket: string; key: string };
    }
  | { type: "error"; message: string };

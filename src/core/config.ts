import { z } from "zod";
import type { TransflowConfig } from "./types";

export function computeTmpBucketName(project: string, region: string): string {
  const safeProject = project
    .toLowerCase()
    .replace(/[^a-z0-9.-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  const safeRegion = region.toLowerCase();
  return `${safeProject}-${safeRegion}-transflow-tmp`;
}

const CredentialsSchema = z.object({
  accessKeyId: z.string().min(1),
  secretAccessKey: z.string().min(1),
  sessionToken: z.string().optional(),
});

const ConfigSchema = z.object({
  project: z.string().min(1),
  region: z.string().min(1),
  awsProfile: z.string().optional(),
  endpoint: z.string().optional(),
  credentials: CredentialsSchema.optional(),
  s3: z.object({
    exportBuckets: z.array(z.string()).optional(),
    maxFileSize: z.number().int().min(1).max(5368709120).optional(),
    allowedContentTypes: z.array(z.string()).optional(),
    forcePathStyle: z.boolean().optional(),
    corsAllowedOrigins: z.array(z.string()).optional(),
    tmpRetentionDays: z.number().int().min(0).max(3650).optional(),
  }),
  ecrRepo: z.string().min(1),
  ecr: z
    .object({
      retainImages: z.number().int().min(1).max(10000).optional(),
    })
    .optional(),
  lambdaPrefix: z.string().min(1),
  templatesDir: z.string().min(1),
  dynamoDb: z.object({
    tableName: z.string().min(1),
    ttlDays: z.number().int().min(0).max(3650).optional(),
  }),
  lambda: z.object({
    memoryMb: z.number().int().min(128).default(2048),
    timeoutSec: z.number().int().min(1).max(900).default(900),
    architecture: z.enum(["x86_64", "arm64"]).optional(),
    roleArn: z.string().optional(),
    reservedConcurrency: z.number().int().min(1).max(1000).optional(),
    maxBatchSize: z.number().int().min(1).max(100).default(10),
  }),
  sqs: z.object({
    queueName: z.string().optional(),
    visibilityTimeoutSec: z.number().int().min(1).max(43200).default(960),
    maxReceiveCount: z.number().int().min(1).max(1000).default(3),
    batchSize: z.number().int().min(1).max(10).default(10),
    fifo: z.boolean().optional(),
  }),
});

export function sanitizeBranch(branch: string): string {
  const safe = branch
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return safe || "main";
}

export function loadConfigObject(raw: unknown): TransflowConfig {
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid config: ${issues}`);
  }
  return parsed.data as TransflowConfig;
}

/** Resolve the FIFO setting (defaults to true for backward compat). */
export function isFifoQueue(cfg: TransflowConfig): boolean {
  return cfg.sqs.fifo !== false;
}

/** Returns the configured queue name, ensuring .fifo suffix when FIFO. */
export function resolveQueueName(cfg: TransflowConfig): string {
  const fifo = isFifoQueue(cfg);
  const base = cfg.sqs.queueName || `${cfg.project}-processing`;
  if (fifo && !base.endsWith(".fifo")) return `${base}.fifo`;
  if (!fifo && base.endsWith(".fifo")) return base.replace(/\.fifo$/, "");
  return base;
}

export function resolveDlqName(cfg: TransflowConfig): string {
  const fifo = isFifoQueue(cfg);
  return `${cfg.project}-dlq${fifo ? ".fifo" : ""}`;
}

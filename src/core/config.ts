import fs from "fs";
import path from "path";
import { z } from "zod";
import type { TransflowConfig } from "./types";

const ConfigSchema = z.object({
  project: z.string().min(1),
  region: z.string().min(1),
  awsProfile: z.string().optional(),
  s3: z.object({
    mode: z.enum(["bucket", "prefix"]).default("prefix"),
    uploadBucket: z.string().optional(),
    outputBucket: z.string().optional(),
    baseBucket: z.string().optional(),
    buckets: z.array(z.string()).optional(),
    userIsolation: z.boolean().default(false),
    maxFileSize: z.number().int().min(1).max(5368709120).optional(), // Max 5GB
    allowedContentTypes: z.array(z.string()).optional(),
  }),
  ecrRepo: z.string().min(1),
  lambdaPrefix: z.string().min(1),
  templatesDir: z.string().min(1),
  lambdaBuildContext: z.string().min(1),
  dynamoDb: z.object({
    tableName: z.string().min(1),
  }),
  lambda: z.object({
    memoryMb: z.number().int().min(128).default(2048),
    timeoutSec: z.number().int().min(1).max(900).default(900),
    architecture: z.enum(["x86_64", "arm64"]).optional(),
    roleArn: z.string().optional(),
    reservedConcurrency: z.number().int().min(1).max(1000).optional(),
    maxBatchSize: z.number().int().min(1).max(100).default(10),
  }),
  statusLambda: z
    .object({
      enabled: z.boolean(),
      functionName: z.string().optional(),
      memoryMb: z.number().int().min(128).max(10240).default(512),
      timeoutSec: z.number().int().min(1).max(900).default(30),
      roleArn: z.string().optional(),
    })
    .optional(),
  sqs: z.object({
    queueName: z.string().optional(),
    visibilityTimeoutSec: z.number().int().min(1).max(43200).default(960), // 16 minutes (longer than Lambda timeout)
    maxReceiveCount: z.number().int().min(1).max(1000).default(3),
    batchSize: z.number().int().min(1).max(10).default(10),
  }),
  auth: z
    .object({
      jwtSecret: z.string().optional(),
      jwtIssuer: z.string().optional(),
      userIdClaim: z.string().default("sub"),
      sessionCookieName: z.string().default("session"),
      requireAuth: z.boolean().default(false),
    })
    .optional(),
});

export async function loadConfig(
  configPath?: string
): Promise<TransflowConfig> {
  // Support JS and JSON configs. Prefer JS if both exist and no explicit path.
  const defaultCandidates = [
    "transflow.config.js",
    "transflow.config.cjs",
    "transflow.config.mjs",
    "transflow.config.json",
  ];
  let rel = configPath ?? "";
  if (!rel) {
    const found = defaultCandidates.find((p) =>
      fs.existsSync(path.resolve(process.cwd(), p))
    );
    if (!found) {
      throw new Error(
        `Config file not found. Looked for: ${defaultCandidates.join(", ")}`
      );
    }
    rel = found;
  }
  const abs = path.isAbsolute(rel) ? rel : path.resolve(process.cwd(), rel);
  if (!fs.existsSync(abs)) {
    throw new Error(`Config file not found: ${abs}`);
  }

  let rawConfig: unknown;
  if (abs.endsWith(".json")) {
    const raw = fs.readFileSync(abs, "utf8");
    try {
      rawConfig = JSON.parse(raw);
    } catch (e) {
      throw new Error(`Invalid JSON in ${abs}: ${(e as Error).message}`);
    }
  } else if (abs.endsWith(".js") || abs.endsWith(".cjs")) {
    // CommonJS require
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(abs);
    rawConfig = (mod && (mod.default ?? mod)) as unknown;
  } else if (abs.endsWith(".mjs")) {
    // Dynamic import for ESM
    const mod = (require("node:module") as any).createRequire
      ? await import(abs)
      : // Fallback
        await import(abs as any);
    rawConfig = (mod && (mod.default ?? mod)) as unknown;
  } else {
    throw new Error(`Unsupported config extension: ${path.extname(abs)}`);
  }

  const parsed = ConfigSchema.safeParse(rawConfig);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid config: ${issues}`);
  }
  const cfg = parsed.data as TransflowConfig;

  // Legacy validation only if using prefix mode without explicit buckets
  if (
    cfg.s3.mode === "prefix" &&
    (!cfg.s3.buckets || cfg.s3.buckets.length === 0)
  ) {
    if (!cfg.s3.uploadBucket || !cfg.s3.outputBucket) {
      throw new Error(
        "s3.uploadBucket and s3.outputBucket are required in prefix mode when s3.buckets is not provided"
      );
    }
  }

  return cfg;
}

export function sanitizeBranch(branch: string): string {
  // Replace invalid S3/Lambda chars; keep alnum and dashes, convert others to '-'
  const safe = branch
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return safe || "main";
}

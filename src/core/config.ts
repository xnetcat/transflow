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
    baseBucket: z.string().optional()
  }),
  ecrRepo: z.string().min(1),
  lambdaPrefix: z.string().min(1),
  templatesDir: z.string().min(1),
  lambdaBuildContext: z.string().min(1),
  redis: z.object({
    provider: z.enum(["upstash", "ioredis"]).default("upstash"),
    restUrl: z.string().optional(),
    token: z.string().optional(),
    url: z.string().optional()
  }),
  dynamoDb: z
    .object({
      enabled: z.boolean(),
      tableName: z.string().optional()
    })
    .optional(),
  lambda: z.object({
    memoryMb: z.number().int().min(128).default(2048),
    timeoutSec: z.number().int().min(1).max(900).default(900),
    architecture: z.enum(["x86_64", "arm64"]).optional(),
    roleArn: z.string().optional()
  })
});

export function loadConfig(configPath?: string): TransflowConfig {
  const rel = configPath ?? "transflow.config.json";
  const abs = path.isAbsolute(rel) ? rel : path.resolve(process.cwd(), rel);
  if (!fs.existsSync(abs)) {
    throw new Error(`Config file not found: ${abs}`);
  }
  const raw = fs.readFileSync(abs, "utf8");
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Invalid JSON in ${abs}: ${(e as Error).message}`);
  }
  const parsed = ConfigSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid config: ${issues}`);
  }
  const cfg = parsed.data as TransflowConfig;
  if (cfg.s3.mode === "prefix") {
    if (!cfg.s3.uploadBucket || !cfg.s3.outputBucket) {
      throw new Error("s3.uploadBucket and s3.outputBucket are required in prefix mode");
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


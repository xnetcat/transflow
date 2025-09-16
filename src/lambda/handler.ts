/*
  Lambda container handler. Requires templates baked into image:
  - /var/task/templates.index.cjs => maps templateId -> module with default export TemplateDefinition
*/
import fs from "fs";
import path from "path";
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  UpdateCommand,
  GetCommand,
} from "@aws-sdk/lib-dynamodb";
import { spawn } from "child_process";
import { createHash, randomUUID, createHmac } from "crypto";

type S3EventLike = {
  Records: Array<{
    s3: { bucket: { name: string }; object: { key: string } };
  }>;
};

type SQSEventLike = {
  Records: Array<{
    body: string;
    receiptHandle: string;
    messageId: string;
  }>;
};

type S3Object = {
  bucket: string;
  key: string;
};

type ProcessingJob = {
  assemblyId: string;
  uploadId: string;
  templateId: string;
  objects: S3Object[];
  branch: string;
};

type UnifiedEvent = S3EventLike | SQSEventLike;

import type {
  TemplateDefinition,
  StepContext,
  AssemblyStatus,
} from "../core/types";

function loadTemplatesIndex(): any {
  // Prefer a globally stubbed require in tests, fall back to module require
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const reqFunc: any = (globalThis as any).require || require;
  const candidates = [
    process.env.TEMPLATES_INDEX_PATH,
    "/var/task/templates.index.cjs",
    // Fallbacks for local/dev environments
    path.resolve(__dirname, "../../templates.index.cjs"),
    path.resolve(process.cwd(), "templates.index.cjs"),
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    try {
      return reqFunc(candidate);
    } catch (_) {
      // try next candidate
    }
  }
  throw new Error("Templates index not found");
}

function getSQS() {
  const region =
    process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";
  return new SQSClient({ region });
}

function computeAssemblyIdFromObjects(
  objects: S3Object[],
  templateId: string
): string {
  // Temporary computation based on keys + template (will be MD5-based later)
  const objectKeys = objects
    .map((obj) => obj.key)
    .sort()
    .join(",");
  const input = `${objectKeys}:${templateId}`;
  return createHash("sha256").update(input).digest("hex");
}

async function sendWebhookWithRetries(
  webhookUrl: string,
  payload: any,
  secret?: string,
  maxRetries = 3
): Promise<void> {
  const body = JSON.stringify(payload ?? {});

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "Transflow/1.0",
  };

  // Add HMAC signature if secret provided
  if (secret) {
    const signature = createHmac("sha256", secret).update(body).digest("hex");
    headers["X-Transflow-Signature"] = `sha256=${signature}`;
  }

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(webhookUrl, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(30000), // 30s timeout
      });

      if (response.ok) {
        console.log(`Webhook sent successfully to ${webhookUrl}`);
        return;
      }

      if (response.status >= 400 && response.status < 500) {
        // Client error - don't retry
        throw new Error(
          `Webhook failed with client error: ${response.status} ${response.statusText}`
        );
      }

      // Server error - will retry
      throw new Error(
        `Webhook failed with server error: ${response.status} ${response.statusText}`
      );
    } catch (error) {
      console.error(`Webhook attempt ${attempt + 1} failed:`, error);

      if (attempt === maxRetries) {
        throw error; // Final attempt failed
      }

      // Exponential backoff: 1s, 2s, 4s
      const delay = Math.pow(2, attempt) * 1000;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

function isS3Event(event: UnifiedEvent): event is S3EventLike {
  return !!(event.Records?.[0] as any)?.s3;
}

function isSQSEvent(event: UnifiedEvent): event is SQSEventLike {
  return !!(event.Records?.[0] as any)?.body;
}

async function parseSQSJobs(event: SQSEventLike): Promise<ProcessingJob[]> {
  const jobs: ProcessingJob[] = [];

  for (const record of event.Records) {
    try {
      const job = JSON.parse(record.body) as ProcessingJob;
      jobs.push(job);
    } catch (error) {
      console.error(`Failed to parse SQS message ${record.messageId}:`, error);
      // Continue processing other messages
    }
  }

  return jobs;
}

async function parseS3Jobs(
  event: S3EventLike,
  s3: S3Client
): Promise<ProcessingJob[]> {
  type Expanded = {
    bucket: string;
    key: string;
    branch: string;
    assemblyId: string;
    uploadId?: string;
    templateId?: string;
  };
  const expanded: Expanded[] = [];

  for (const record of event.Records ?? []) {
    const bucket = record.s3.bucket.name;
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, " "));

    // New key structure: uploads/{branch}/{assemblyId}/{filename}
    const m = key.match(/^uploads\/([^/]+)\/([^/]+)\//);
    if (!m) {
      console.warn(`Key does not match expected layout: ${key}`);
      continue;
    }
    const [, branch, assemblyId] = m;

    // Get metadata from S3 object to extract templateId and uploadId
    try {
      const head = await s3.send(
        new HeadObjectCommand({ Bucket: bucket, Key: key })
      );
      const metadata = head.Metadata || {};
      expanded.push({
        bucket,
        key,
        branch,
        assemblyId,
        uploadId: metadata["upload-id"],
        templateId: metadata["template-id"],
      });
    } catch (err) {
      console.warn(`Failed to get metadata for ${key}:`, err);
      continue;
    }
  }

  // Group by assemblyId (not uploadId:templateId anymore)
  const groups = new Map<string, Expanded[]>();
  for (const rec of expanded) {
    const list = groups.get(rec.assemblyId) || ([] as Expanded[]);
    list.push(rec);
    groups.set(rec.assemblyId, list);
  }

  const jobs: ProcessingJob[] = [];
  for (const [assemblyId, items] of groups) {
    const first = items[0];
    if (!first.templateId || !first.uploadId) {
      console.warn(`Missing metadata for assembly ${assemblyId}`);
      continue;
    }
    jobs.push({
      assemblyId,
      uploadId: first.uploadId,
      templateId: first.templateId,
      branch: first.branch,
      objects: items.map((i) => ({ bucket: i.bucket, key: i.key })),
    });
  }

  return jobs;
}

async function execFF(
  args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    proc.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    proc.on("close", (code) =>
      resolve({ code: (code ?? 1) as number, stdout, stderr })
    );
  });
}

async function execProbe(
  args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn("ffprobe", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    proc.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    proc.on("close", (code) =>
      resolve({ code: (code ?? 1) as number, stdout, stderr })
    );
  });
}

async function processJob(
  job: ProcessingJob,
  s3: S3Client,
  sqs: SQSClient,
  ddb?: DynamoDBDocumentClient
) {
  const { assemblyId, uploadId, templateId, objects, branch } = job;
  // Predeclare hash collections for use in success and error paths
  const md5Hashes: string[] = [];
  const etagHashes: string[] = [];

  // Enforce buckets: inputs must be in allowed list and in tmp bucket
  const allowedBucketsEnv = process.env.TRANSFLOW_ALLOWED_BUCKETS || "[]";
  const allowedBuckets = JSON.parse(allowedBucketsEnv) as string[];
  const tmpBucket = process.env.TRANSFLOW_TMP_BUCKET || allowedBuckets[0];
  const allowedInputBuckets = new Set<string>([tmpBucket, ...allowedBuckets]);
  for (const obj of objects) {
    if (!allowedInputBuckets.has(obj.bucket)) {
      throw new Error(`Bucket not allowed: ${obj.bucket}`);
    }
  }

  try {
    // Load baked template (path-agnostic: env → /var/task → fallbacks)
    const index = loadTemplatesIndex();
    const mod = index[templateId];
    if (!mod || !mod.default)
      throw new Error(`Template not found: ${templateId}`);
    const tpl: TemplateDefinition = mod.default;

    const tmpDir = fs.mkdtempSync(path.join("/tmp", `transflow-`));
    // Output bucket must be explicitly set in template, otherwise use tmp/input bucket
    const outputBucket = tpl.outputBucket || objects[0].bucket;
    const outputPrefix = `outputs/${branch}/${uploadId}/${templateId}/`;

    // Download all inputs, compute MD5, and build uploads[] for status
    const inputsLocalPaths: string[] = [];
    const inputs: Array<{ bucket: string; key: string; contentType?: string }> =
      [];
    const uploads: AssemblyStatus["uploads"] = [];
    let bytesExpected = 0;
    // md5Hashes declared above for error-path reuse

    for (const obj of objects) {
      const p = path.join(tmpDir, path.basename(obj.key));
      // Get content info
      const head = await s3.send(
        new HeadObjectCommand({ Bucket: obj.bucket, Key: obj.key })
      );
      if (head.ETag) {
        etagHashes.push(String(head.ETag).replace(/"/g, ""));
      }
      const s3Obj = await s3.send(
        new GetObjectCommand({ Bucket: obj.bucket, Key: obj.key })
      );

      const stream: any = s3Obj.Body as any;
      await new Promise<void>((resolve, reject) => {
        const w = fs.createWriteStream(p);
        w.on("finish", () => resolve());
        w.on("error", reject);
        if (stream && typeof stream.pipe === "function") {
          stream.on?.("error", reject);
          stream.pipe(w);
        } else if (stream && typeof stream.getReader === "function") {
          // Web ReadableStream fallback
          const reader = stream.getReader();
          const pump = () =>
            reader
              .read()
              .then(({ done, value }: any) => {
                if (done) {
                  w.end();
                  return;
                }
                w.write(Buffer.from(value), (err) => {
                  if (err) reject(err);
                  else pump();
                });
              })
              .catch(reject);
          pump();
        } else {
          reject(new Error("Unsupported S3 Body stream type"));
        }
      });
      const computedMd5 = createHash("md5")
        .update(fs.readFileSync(p))
        .digest("hex");
      md5Hashes.push(computedMd5);
      inputsLocalPaths.push(p);
      inputs.push({
        bucket: obj.bucket,
        key: obj.key,
        contentType: head.ContentType,
      });

      // Build upload entry for status
      const size = head.ContentLength || 0;
      const filename = path.basename(obj.key);
      const ext = path.extname(filename).slice(1);
      const basename = path.basename(filename, path.extname(filename));
      const md5hash = computedMd5;

      uploads!.push({
        id: `upload_${randomUUID()}`,
        name: filename,
        basename,
        ext,
        size,
        mime: head.ContentType,
        field: "file",
        md5hash,
      });

      bytesExpected += size;
    }

    const region =
      process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";
    const ctx: StepContext & {
      currentStepName?: string;
      stepResults?: Record<string, any[]>;
    } = {
      uploadId,
      input: inputs[0],
      inputLocalPath: inputsLocalPaths[0],
      inputs,
      inputsLocalPaths,
      output: { bucket: outputBucket, prefix: outputPrefix },
      branch,
      awsRegion: region,
      tmpDir,
      utils: {
        execFF,
        execProbe,
        exportToBucket: async (localPath, key, bucketName, contentType) => {
          if (!allowedBuckets.includes(bucketName)) {
            throw new Error(`Export bucket not allowed: ${bucketName}`);
          }
          const body = fs.readFileSync(localPath);
          const outKey = `${outputPrefix}${key}`.replace(/\\/g, "/");
          await s3.send(
            new PutObjectCommand({
              Bucket: bucketName,
              Key: outKey,
              Body: body,
              ContentType: contentType,
            })
          );
          return { bucket: bucketName, key: outKey };
        },
        uploadResult: async (localPath, destKey, contentType) => {
          const body = fs.readFileSync(localPath);
          const outKey = `${outputPrefix}${destKey}`.replace(/\\/g, "/");

          // Enforce allowed buckets for outputs (allow tmp bucket as well)
          if (!new Set([tmpBucket, ...allowedBuckets]).has(outputBucket)) {
            throw new Error(`Output bucket not allowed: ${outputBucket}`);
          }

          await s3.send(
            new PutObjectCommand({
              Bucket: outputBucket,
              Key: outKey,
              Body: body,
              ContentType: contentType,
            })
          );

          // Track result for current step (we'll use the step context when available)
          const stepName = ctx.currentStepName || "default";
          const resultEntry = {
            id: `result_${randomUUID()}`,
            name: path.basename(destKey),
            basename: path.basename(destKey, path.extname(destKey)),
            ext: path.extname(destKey).slice(1),
            size: body.length,
            mime: contentType,
            field: "file",
            original_id: uploads?.[0]?.id,
            ssl_url: `https://${outputBucket}.s3.${region}.amazonaws.com/${outKey}`,
          };

          // Add to results tracking (we'll update DDB later)
          if (!ctx.stepResults) ctx.stepResults = {};
          if (!ctx.stepResults[stepName]) ctx.stepResults[stepName] = [];
          ctx.stepResults[stepName].push(resultEntry);

          return { bucket: outputBucket, key: outKey };
        },
        generateKey: (basename) => `${outputPrefix}${basename}`,
        publish: async (message) => {
          // No-op: SSE removed, status tracked via DynamoDB
          console.log("Template publish call (no-op):", message);
        },
      },
    };

    // Assembly ID is already provided from the upload handler
    const tableName = process.env.DYNAMODB_TABLE as string;
    const nowIso = new Date().toISOString();

    // Update assembly status (already created by upload handler)
    if (ddb && tableName) {
      await ddb.send(
        new UpdateCommand({
          TableName: tableName,
          Key: { assembly_id: assemblyId },
          UpdateExpression:
            "SET #msg = :msg, #start = :start, #updated = :updated, #uploads = :uploads, #bytes = :bytes, #stepsTotal = :stepsTotal, #stepsCompleted = :stepsCompleted, #currentStep = :currentStep, #currentStepName = :currentStepName, #progress = :progress",
          ExpressionAttributeNames: {
            "#msg": "message",
            "#start": "execution_start",
            "#updated": "updated_at",
            "#uploads": "uploads",
            "#bytes": "bytes_received",
            "#stepsTotal": "steps_total",
            "#stepsCompleted": "steps_completed",
            "#currentStep": "current_step",
            "#currentStepName": "current_step_name",
            "#progress": "progress_pct",
          },
          ExpressionAttributeValues: {
            ":msg": "Processing started",
            ":start": nowIso,
            ":updated": nowIso,
            ":uploads": uploads || [],
            ":bytes": bytesExpected,
            ":stepsTotal": tpl.steps?.length ?? 0,
            ":stepsCompleted": 0,
            ":currentStep": 0,
            ":currentStepName": "",
            ":progress": 0,
          },
        })
      );
    }

    let stepIndex = 0;
    const totalSteps = tpl.steps?.length ?? 0;
    for (const step of tpl.steps) {
      stepIndex += 1;
      ctx.currentStepName = step.name;
      // Update progress before running the step
      if (ddb && tableName) {
        const now = new Date().toISOString();
        const progress = Math.max(
          0,
          Math.min(
            100,
            Math.floor(((stepIndex - 1) / Math.max(1, totalSteps)) * 100)
          )
        );
        await ddb.send(
          new UpdateCommand({
            TableName: tableName,
            Key: { assembly_id: assemblyId },
            UpdateExpression:
              "SET #updated = :updated, #currentStep = :currentStep, #currentStepName = :currentStepName, #stepsCompleted = :stepsCompleted, #progress = :progress",
            ExpressionAttributeNames: {
              "#updated": "updated_at",
              "#currentStep": "current_step",
              "#currentStepName": "current_step_name",
              "#stepsCompleted": "steps_completed",
              "#progress": "progress_pct",
            },
            ExpressionAttributeValues: {
              ":updated": now,
              ":currentStep": stepIndex,
              ":currentStepName": step.name,
              ":stepsCompleted": stepIndex - 1,
              ":progress": progress,
            },
          })
        );
      }
      await step.run(ctx);
      // Update progress after step completes
      if (ddb && tableName) {
        const now = new Date().toISOString();
        const progress = Math.max(
          0,
          Math.min(100, Math.floor((stepIndex / Math.max(1, totalSteps)) * 100))
        );
        await ddb.send(
          new UpdateCommand({
            TableName: tableName,
            Key: { assembly_id: assemblyId },
            UpdateExpression:
              "SET #updated = :updated, #stepsCompleted = :stepsCompleted, #progress = :progress",
            ExpressionAttributeNames: {
              "#updated": "updated_at",
              "#stepsCompleted": "steps_completed",
              "#progress": "progress_pct",
            },
            ExpressionAttributeValues: {
              ":updated": now,
              ":stepsCompleted": stepIndex,
              ":progress": progress,
            },
          })
        );
      }
    }

    const result = {
      status: "completed",
      templateId,
      input: inputs[0],
      outputsPrefix: outputPrefix,
    } as const;

    if (!ddb) {
      await s3.send(
        new PutObjectCommand({
          Bucket: outputBucket,
          Key: `${outputPrefix}status.json`,
          Body: JSON.stringify(result),
          ContentType: "application/json",
        })
      );
    } else {
      // Update final status in DDB and post webhook if configured
      const doneIso = new Date().toISOString();
      const executionDuration =
        (new Date(doneIso).getTime() - new Date(nowIso).getTime()) / 1000;

      await ddb.send(
        new UpdateCommand({
          TableName: tableName,
          Key: { assembly_id: assemblyId },
          UpdateExpression:
            "SET ok = :ok, message = :msg, last_job_completed = :ljc, updated_at = :ua, execution_duration = :dur, results = :results, progress_pct = :progress",
          ExpressionAttributeValues: {
            ":ok": "ASSEMBLY_COMPLETED",
            ":msg": "Processing completed",
            ":ljc": doneIso,
            ":ua": doneIso,
            ":dur": executionDuration,
            ":results": ctx.stepResults || {},
            ":progress": 100,
          },
        })
      );
      // Webhook notify with retries and optional HMAC
      try {
        const index = loadTemplatesIndex();
        const mod = index[templateId];
        const tpl2: TemplateDefinition | undefined = mod?.default;
        if (tpl2?.webhookUrl) {
          const current = await ddb.send(
            new GetCommand({
              TableName: tableName,
              Key: { assembly_id: assemblyId },
            })
          );
          const payload = current.Item as AssemblyStatus;
          await sendWebhookWithRetries(
            tpl2.webhookUrl,
            payload,
            tpl2.webhookSecret
          );
        }
      } catch (webhookError) {
        console.error("Failed to send webhook:", webhookError);
      }
    }

    // Delete inputs from tmp bucket
    await Promise.all(
      objects
        .filter((o) => o.bucket === tmpBucket)
        .map((o) =>
          s3.send(new DeleteObjectCommand({ Bucket: o.bucket, Key: o.key }))
        )
    );
  } catch (err) {
    // On error also attempt cleanup of tmp bucket objects
    try {
      await Promise.all(
        objects
          .filter((o) => o.bucket === (process.env.TRANSFLOW_TMP_BUCKET || ""))
          .map((o) =>
            s3.send(new DeleteObjectCommand({ Bucket: o.bucket, Key: o.key }))
          )
      );
    } catch {}

    // Update error status in DDB if available
    const tableName = process.env.DYNAMODB_TABLE as string;
    if (ddb && tableName) {
      // Assembly ID is already provided from the upload handler
      const errorIso = new Date().toISOString();
      await ddb.send(
        new UpdateCommand({
          TableName: tableName,
          Key: { assembly_id: assemblyId },
          UpdateExpression:
            "SET #error = :err, #message = :msg, #updated = :ua, #progress = :progress",
          ExpressionAttributeNames: {
            "#error": "error",
            "#message": "message",
            "#updated": "updated_at",
            "#progress": "progress_pct",
          },
          ExpressionAttributeValues: {
            ":err": "PROCESSING_ERROR",
            ":msg": (err as Error).message,
            ":ua": errorIso,
            ":progress": 100,
          },
        })
      );

      // Send webhook notification for errors too
      try {
        const index = loadTemplatesIndex();
        const mod = index[templateId];
        const tpl2: TemplateDefinition | undefined = mod?.default;
        if (tpl2?.webhookUrl) {
          const current = await ddb.send(
            new GetCommand({
              TableName: tableName,
              Key: { assembly_id: assemblyId },
            })
          );
          const payload = current.Item as AssemblyStatus;
          await sendWebhookWithRetries(
            tpl2.webhookUrl,
            payload,
            tpl2.webhookSecret
          );
        }
      } catch (webhookError) {
        console.error("Failed to send error webhook:", webhookError);
      }
    }
    throw err;
  }
}

export const handler = async (event: UnifiedEvent) => {
  const sqs = getSQS();
  const region =
    process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";
  const s3 = new S3Client({ region });
  const ddbEnabled = !!process.env.DYNAMODB_TABLE;
  const ddb = ddbEnabled
    ? DynamoDBDocumentClient.from(new DynamoDBClient({ region }))
    : undefined;

  let jobs: ProcessingJob[] = [];

  if (isS3Event(event)) {
    // Convert S3 events to SQS jobs (single-Lambda bridge)
    const queueUrl = process.env.SQS_QUEUE_URL;
    if (!queueUrl) throw new Error("SQS_QUEUE_URL is required");
    const toQueue = await parseS3Jobs(event, s3);
    for (const job of toQueue) {
      try {
        await sqs.send(
          new SendMessageCommand({
            QueueUrl: queueUrl,
            MessageBody: JSON.stringify(job),
            MessageGroupId: job.uploadId,
            MessageDeduplicationId: `${
              job.uploadId
            }-${Date.now()}-${Math.random()}`,
          })
        );
      } catch (e) {
        console.error("Failed to enqueue job from S3 event:", e);
      }
    }
    // No inline processing; return after enqueue
    return;
  } else if (isSQSEvent(event)) {
    // SQS-based processing (new concurrency-safe path)
    jobs = await parseSQSJobs(event);
  } else {
    throw new Error("Unsupported event type");
  }

  const maxBatchSize = parseInt(process.env.MAX_BATCH_SIZE || "10");
  const jobBatches: ProcessingJob[][] = [];

  // Split jobs into batches to respect memory limits
  for (let i = 0; i < jobs.length; i += maxBatchSize) {
    jobBatches.push(jobs.slice(i, i + maxBatchSize));
  }

  // Process batches sequentially to avoid overwhelming resources
  for (const batch of jobBatches) {
    await Promise.all(batch.map((job) => processJob(job, s3, sqs, ddb)));
  }
};

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
import {
  DynamoDBDocumentClient,
  PutCommand,
  UpdateCommand,
  GetCommand,
} from "@aws-sdk/lib-dynamodb";
import { spawn } from "child_process";
import { createHash, randomUUID } from "crypto";
import {
  makeS3Client,
  makeSqsClient,
  makeDynamoDocClient,
  buildS3PublicUrl,
  resolveEndpoint,
  resolveRegion,
} from "../core/awsClients";
import { sendWebhookWithRetries } from "../core/webhook";
import type {
  TemplateDefinition,
  StepContext,
  AssemblyStatus,
} from "../core/types";

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

function loadTemplatesIndex(): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const globalReq = (globalThis as any).require;
  const reqFunc = typeof globalReq === "function" ? globalReq : require;
  const candidates = [
    process.env.TEMPLATES_INDEX_PATH,
    "/var/task/templates.index.cjs",
    path.resolve(__dirname, "../../templates.index.cjs"),
    path.resolve(process.cwd(), "templates.index.cjs"),
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    try {
      return reqFunc(candidate);
    } catch (_) {
      // try next
    }
  }
  throw new Error("Templates index not found");
}

function isS3Event(event: UnifiedEvent): event is S3EventLike {
  if (
    "Records" in event &&
    Array.isArray(event.Records) &&
    event.Records.length > 0
  ) {
    return "s3" in event.Records[0];
  }
  return false;
}

function isSQSEvent(event: UnifiedEvent): event is SQSEventLike {
  if (
    "Records" in event &&
    Array.isArray(event.Records) &&
    event.Records.length > 0
  ) {
    return "body" in event.Records[0];
  }
  return false;
}

async function parseSQSJobs(
  event: SQSEventLike,
  s3: S3Client
): Promise<ProcessingJob[]> {
  const jobs: ProcessingJob[] = [];
  for (const record of event.Records) {
    try {
      const parsed = JSON.parse(record.body) as
        | ProcessingJob
        | S3EventLike
        | { Event?: string };
      // S3 → SQS direct integrations deliver the standard S3 event payload.
      // Bridge-style enqueues deliver a pre-parsed ProcessingJob.
      if (
        parsed &&
        Array.isArray((parsed as S3EventLike).Records) &&
        (parsed as S3EventLike).Records[0] &&
        "s3" in (parsed as S3EventLike).Records[0]
      ) {
        const expanded = await parseS3Jobs(parsed as S3EventLike, s3);
        jobs.push(...expanded);
      } else if ((parsed as { Event?: string }).Event === "s3:TestEvent") {
        // S3 sends a TestEvent when the notification is first wired up.
        continue;
      } else {
        jobs.push(parsed as ProcessingJob);
      }
    } catch (error) {
      console.error(`Failed to parse SQS message ${record.messageId}:`, error);
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

    const m = key.match(/^uploads\/([^/]+)\/([^/]+)\//);
    if (!m) {
      console.warn(`Key does not match expected layout: ${key}`);
      continue;
    }
    const [, branch, assemblyId] = m;

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

function computeTtl(): number | undefined {
  const days = Number(process.env.TRANSFLOW_TTL_DAYS || 30);
  if (!Number.isFinite(days) || days <= 0) return undefined;
  return Math.floor(Date.now() / 1000) + days * 86400;
}

async function processJob(
  job: ProcessingJob,
  s3: S3Client,
  sqs: SQSClient,
  ddb?: DynamoDBDocumentClient
) {
  const { assemblyId, uploadId, templateId, objects, branch } = job;
  const md5Hashes: string[] = [];
  const etagHashes: string[] = [];

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
    const index = loadTemplatesIndex();
    const mod = index[templateId];
    if (!mod || !mod.default)
      throw new Error(`Template not found: ${templateId}`);
    const tpl: TemplateDefinition = mod.default;

    const tmpDir = fs.mkdtempSync(path.join("/tmp", `transflow-`));
    const outputBucket = tpl.outputBucket || objects[0].bucket;
    const outputPrefix = `outputs/${branch}/${uploadId}/${templateId}/`;

    const inputsLocalPaths: string[] = [];
    const inputs: Array<{ bucket: string; key: string; contentType?: string }> =
      [];
    const uploads: AssemblyStatus["uploads"] = [];
    let bytesExpected = 0;

    for (const obj of objects) {
      const p = path.join(tmpDir, path.basename(obj.key));
      const head = await s3.send(
        new HeadObjectCommand({ Bucket: obj.bucket, Key: obj.key })
      );
      if (head.ETag) {
        etagHashes.push(String(head.ETag).replace(/"/g, ""));
      }
      const s3Obj = await s3.send(
        new GetObjectCommand({ Bucket: obj.bucket, Key: obj.key })
      );

      const stream = s3Obj.Body;
      await new Promise<void>((resolve, reject) => {
        const w = fs.createWriteStream(p);
        w.on("finish", () => resolve());
        w.on("error", reject);

        if (stream && "pipe" in stream && typeof stream.pipe === "function") {
          const readable = stream as import("stream").Readable;
          readable.on("error", reject);
          readable.pipe(w);
        } else if (
          stream &&
          "getReader" in stream &&
          typeof stream.getReader === "function"
        ) {
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

      const size = head.ContentLength || 0;
      const filename = path.basename(obj.key);
      const ext = path.extname(filename).slice(1);
      const basename = path.basename(filename, path.extname(filename));

      uploads!.push({
        id: `upload_${randomUUID()}`,
        name: filename,
        basename,
        ext,
        size,
        mime: head.ContentType,
        field: "file",
        md5hash: computedMd5,
      });

      bytesExpected += size;
    }

    const region = resolveRegion();
    const endpoint = resolveEndpoint();
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

          const stepName = ctx.currentStepName || "default";
          const resultEntry = {
            id: `result_${randomUUID()}`,
            name: path.basename(key),
            basename: path.basename(key, path.extname(key)),
            ext: path.extname(key).slice(1),
            size: body.length,
            mime: contentType,
            field: "file",
            original_id: uploads?.[0]?.id,
            ssl_url: buildS3PublicUrl(bucketName, outKey, region, endpoint),
          };
          if (!ctx.stepResults) ctx.stepResults = {};
          if (!ctx.stepResults[stepName]) ctx.stepResults[stepName] = [];
          ctx.stepResults[stepName].push(resultEntry);

          return { bucket: bucketName, key: outKey };
        },
        uploadResult: async (localPath, destKey, contentType) => {
          const body = fs.readFileSync(localPath);
          const outKey = `${outputPrefix}${destKey}`.replace(/\\/g, "/");

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
            ssl_url: buildS3PublicUrl(outputBucket, outKey, region, endpoint),
          };

          if (!ctx.stepResults) ctx.stepResults = {};
          if (!ctx.stepResults[stepName]) ctx.stepResults[stepName] = [];
          ctx.stepResults[stepName].push(resultEntry);

          return { bucket: outputBucket, key: outKey };
        },
        generateKey: (basename) => `${outputPrefix}${basename}`,
        publish: async () => {
          // No-op: SSE removed, status tracked via DynamoDB
        },
      },
    };

    const tableName = process.env.DYNAMODB_TABLE as string;
    const nowIso = new Date().toISOString();

    if (ddb && tableName) {
      const ttl = computeTtl();
      await ddb.send(
        new UpdateCommand({
          TableName: tableName,
          Key: { assembly_id: assemblyId },
          UpdateExpression:
            "SET #msg = :msg, #start = :start, #updated = :updated, #uploads = :uploads, #bytes = :bytes, #stepsTotal = :stepsTotal, #stepsCompleted = :stepsCompleted, #currentStep = :currentStep, #currentStepName = :currentStepName, #progress = :progress" +
            (ttl !== undefined ? ", #ttl = :ttl" : ""),
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
            ...(ttl !== undefined ? { "#ttl": "ttl" } : {}),
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
            ...(ttl !== undefined ? { ":ttl": ttl } : {}),
          },
        })
      );
    }

    let stepIndex = 0;
    const totalSteps = tpl.steps?.length ?? 0;
    for (const step of tpl.steps) {
      stepIndex += 1;
      ctx.currentStepName = step.name;
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
      try {
        const idx = loadTemplatesIndex();
        const m2 = idx[templateId];
        const tpl2: TemplateDefinition | undefined = m2?.default;
        if (tpl2?.webhookUrl) {
          const current = await ddb.send(
            new GetCommand({
              TableName: tableName,
              Key: { assembly_id: assemblyId },
            })
          );
          await sendWebhookWithRetries({
            url: tpl2.webhookUrl,
            payload: current.Item as AssemblyStatus,
            secret: tpl2.webhookSecret,
          });
        }
      } catch (webhookError) {
        console.error("Failed to send webhook:", webhookError);
      }
    }

    await Promise.all(
      objects
        .filter((o) => o.bucket === tmpBucket)
        .map((o) =>
          s3.send(new DeleteObjectCommand({ Bucket: o.bucket, Key: o.key }))
        )
    );
  } catch (err) {
    try {
      await Promise.all(
        objects
          .filter((o) => o.bucket === (process.env.TRANSFLOW_TMP_BUCKET || ""))
          .map((o) =>
            s3.send(new DeleteObjectCommand({ Bucket: o.bucket, Key: o.key }))
          )
      );
    } catch {}

    const tableName = process.env.DYNAMODB_TABLE as string;
    if (ddb && tableName) {
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

      try {
        const idx = loadTemplatesIndex();
        const m2 = idx[templateId];
        const tpl2: TemplateDefinition | undefined = m2?.default;
        if (tpl2?.webhookUrl) {
          const current = await ddb.send(
            new GetCommand({
              TableName: tableName,
              Key: { assembly_id: assemblyId },
            })
          );
          await sendWebhookWithRetries({
            url: tpl2.webhookUrl,
            payload: current.Item as AssemblyStatus,
            secret: tpl2.webhookSecret,
          });
        }
      } catch (webhookError) {
        console.error("Failed to send error webhook:", webhookError);
      }
    }
    throw err;
  }
}

export const handler = async (event: UnifiedEvent) => {
  const sqs = makeSqsClient();
  const s3 = makeS3Client();
  const ddbEnabled = !!process.env.DYNAMODB_TABLE;
  const ddb = ddbEnabled ? makeDynamoDocClient() : undefined;

  let jobs: ProcessingJob[] = [];

  if (isS3Event(event)) {
    const queueUrl = process.env.SQS_QUEUE_URL;
    if (!queueUrl) throw new Error("SQS_QUEUE_URL is required");
    const fifo = queueUrl.endsWith(".fifo");
    const toQueue = await parseS3Jobs(event, s3);
    for (const job of toQueue) {
      try {
        await sqs.send(
          new SendMessageCommand({
            QueueUrl: queueUrl,
            MessageBody: JSON.stringify(job),
            ...(fifo
              ? {
                  MessageGroupId: job.uploadId,
                  MessageDeduplicationId: `${job.uploadId}-${Date.now()}-${Math.random()}`,
                }
              : {}),
          })
        );
      } catch (e) {
        console.error("Failed to enqueue job from S3 event:", e);
      }
    }
    return;
  } else if (isSQSEvent(event)) {
    jobs = await parseSQSJobs(event, s3);
  } else {
    throw new Error("Unsupported event type");
  }

  // Merge jobs that share an assembly_id. S3 → SQS direct integrations can
  // deliver one event per object, which would otherwise spawn parallel
  // processJob calls that race on the same DynamoDB record.
  const merged = new Map<string, ProcessingJob>();
  for (const job of jobs) {
    const existing = merged.get(job.assemblyId);
    if (!existing) {
      merged.set(job.assemblyId, { ...job, objects: [...job.objects] });
      continue;
    }
    const seen = new Set(existing.objects.map((o) => `${o.bucket}/${o.key}`));
    for (const obj of job.objects) {
      const k = `${obj.bucket}/${obj.key}`;
      if (!seen.has(k)) {
        existing.objects.push(obj);
        seen.add(k);
      }
    }
  }
  jobs = Array.from(merged.values());

  const maxBatchSize = parseInt(process.env.MAX_BATCH_SIZE || "10");
  const jobBatches: ProcessingJob[][] = [];

  for (let i = 0; i < jobs.length; i += maxBatchSize) {
    jobBatches.push(jobs.slice(i, i + maxBatchSize));
  }

  for (const batch of jobBatches) {
    await Promise.all(batch.map((job) => processJob(job, s3, sqs, ddb)));
  }
};

/** Exposed for tests and the local worker. */
export { parseSQSJobs, parseS3Jobs, processJob };

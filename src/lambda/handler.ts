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
  uploadId: string;
  templateId: string;
  objects: S3Object[];
  branch: string;
  fields?: Record<string, string>;
  user?: UserContext;
};

type UnifiedEvent = S3EventLike | SQSEventLike;

import type {
  TemplateDefinition,
  StepContext,
  UserContext,
  AssemblyStatus,
} from "../core/types";
import { generateUserOutputPath } from "../web/auth";

function getSQS() {
  const region =
    process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";
  return new SQSClient({ region });
}

function computeAssemblyIdFromObjects(
  objects: S3Object[],
  templateId: string,
  user?: UserContext
): string {
  // Fallback computation when assembly_id is not in metadata
  const userId = user?.userId || "anonymous";
  const objectKeys = objects
    .map((obj) => obj.key)
    .sort()
    .join(",");
  const input = `${objectKeys}:${templateId}:${userId}`;
  return createHash("sha256").update(input).digest("hex");
}

async function sendWebhookWithRetries(
  webhookUrl: string,
  payload: any,
  secret?: string,
  maxRetries = 3
): Promise<void> {
  const body = JSON.stringify(payload);

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
  const expanded: Array<{
    bucket: string;
    key: string;
    head: any;
    meta: Record<string, string>;
    uploadId: string;
    templateId: string;
    fields?: Record<string, string>;
    userContext?: UserContext;
  }> = [];

  // Process S3 events like before
  for (const record of event.Records ?? []) {
    const bucket = record.s3.bucket.name;
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, " "));
    const head = await s3.send(
      new HeadObjectCommand({ Bucket: bucket, Key: key })
    );
    const meta = (head.Metadata || {}) as Record<string, string>;
    const uploadId =
      (meta.uploadid as string) || (meta.uploadId as string) || "";
    const templateId =
      (meta.templateid as string) ||
      (meta.templateId as string) ||
      (process.env.DEFAULT_TEMPLATE_ID as string) ||
      "";

    // Extract user context from metadata
    let userContext: UserContext | undefined;
    if (meta.userid) {
      userContext = {
        userId: meta.userid,
        permissions: meta.permissions ? JSON.parse(meta.permissions) : [],
        metadata: {},
      };
    }

    let fields: Record<string, string> | undefined;
    if (typeof meta.fields === "string") {
      try {
        const decoded = Buffer.from(meta.fields, "base64").toString("utf8");
        const parsed = JSON.parse(decoded);
        if (parsed && typeof parsed === "object") {
          fields = Object.fromEntries(
            Object.entries(parsed).map(([k, v]) => [k, String(v)])
          );
        }
      } catch {}
    }
    expanded.push({
      bucket,
      key,
      head,
      meta,
      uploadId,
      templateId,
      fields,
      userContext,
    });
  }

  // Group by uploadId
  const groups = new Map<string, typeof expanded>();
  for (const rec of expanded) {
    const id = rec.uploadId || `solo:${rec.bucket}:${rec.key}`;
    const list = groups.get(id) || ([] as typeof expanded);
    list.push(rec);
    groups.set(id, list);
  }

  // Convert to ProcessingJobs
  const jobs: ProcessingJob[] = [];

  for (const [groupId, items] of groups) {
    const first = items[0];
    const uploadId = groupId.replace(/^solo:/, "");

    // Extract branch from key: uploads/{branch}/...
    let derivedBranch = "";
    const match = first.key.match(/^uploads\/([^/]+)\//);
    if (match) derivedBranch = match[1];

    jobs.push({
      uploadId,
      templateId: first.templateId,
      objects: items.map((item) => ({ bucket: item.bucket, key: item.key })),
      branch: derivedBranch,
      fields: first.fields,
      user: first.userContext,
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
  const { uploadId, templateId, objects, branch, fields, user } = job;

  try {
    // Load baked template
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const index = require(path.join(process.cwd(), "templates.index.cjs"));
    const mod = index[templateId];
    if (!mod || !mod.default)
      throw new Error(`Template not found: ${templateId}`);
    const tpl: TemplateDefinition = mod.default;

    const tmpDir = fs.mkdtempSync(path.join("/tmp", `transflow-`));
    const outputBucket =
      tpl.outputBucket || process.env.OUTPUT_BUCKET || objects[0].bucket;

    // Generate secure output path based on user context
    let outputPrefix: string;
    if (user) {
      outputPrefix = generateUserOutputPath(user.userId, branch, uploadId);
    } else {
      outputPrefix = `outputs/${branch}/${uploadId}/`;
    }

    // Download all inputs and build uploads[] for status
    const inputsLocalPaths: string[] = [];
    const inputs: Array<{ bucket: string; key: string; contentType?: string }> =
      [];
    const uploads: AssemblyStatus["uploads"] = [];
    let bytesExpected = 0;

    for (const obj of objects) {
      const p = path.join(tmpDir, path.basename(obj.key));
      const s3Obj = await s3.send(
        new GetObjectCommand({ Bucket: obj.bucket, Key: obj.key })
      );

      // Get content type from HEAD request for context
      const head = await s3.send(
        new HeadObjectCommand({ Bucket: obj.bucket, Key: obj.key })
      );

      const stream = s3Obj.Body as any as NodeJS.ReadableStream;
      await new Promise<void>((resolve, reject) => {
        const w = fs.createWriteStream(p);
        stream.pipe(w);
        w.on("finish", () => resolve());
        w.on("error", reject);
      });
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
      const md5hash = head.Metadata?.assemblyid
        ? // Extract from metadata if present
          undefined
        : head.ETag?.replace(/"/g, ""); // Use S3 ETag as fallback

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
        uploadResult: async (localPath, destKey, contentType) => {
          const body = fs.readFileSync(localPath);
          const outKey = `${outputPrefix}${destKey}`.replace(/\\/g, "/");

          // Additional validation for user-isolated uploads
          if (user && outKey.includes("/users/")) {
            const expectedUserPath = `/users/${user.userId}/`;
            if (!outKey.includes(expectedUserPath)) {
              throw new Error(
                `Access denied: Cannot write to path outside user directory`
              );
            }
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
      fields,
      user,
    };

    // Compute deterministic assemblyId from metadata if present
    // We expect S3 object metadata to include assemblyid when uploaded via our handler
    const head0 = await s3.send(
      new HeadObjectCommand({ Bucket: objects[0].bucket, Key: objects[0].key })
    );
    const meta0 = (head0.Metadata || {}) as Record<string, string>;
    const assemblyId =
      (meta0.assemblyid as string) || `${branch}:${uploadId}:${templateId}`;
    const tableName = process.env.DYNAMODB_TABLE as string;
    const nowIso = new Date().toISOString();

    // Initialize assembly status
    if (ddb && tableName) {
      const base: AssemblyStatus = {
        assembly_id: assemblyId,
        message: "Processing started",
        project: process.env.TRANSFLOW_PROJECT || undefined,
        branch,
        template_id: templateId,
        user: user ? { userId: user.userId } : undefined,
        uploads: uploads || [],
        results: {},
        bytes_expected: bytesExpected,
        bytes_received: bytesExpected, // All bytes downloaded successfully
        execution_start: nowIso,
        created_at: nowIso,
        updated_at: nowIso,
      };
      await ddb.send(new PutCommand({ TableName: tableName, Item: base }));
    }

    for (const step of tpl.steps) {
      ctx.currentStepName = step.name;
      await step.run(ctx);
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
            "SET ok = :ok, message = :msg, last_job_completed = :ljc, updated_at = :ua, execution_duration = :dur, results = :results",
          ExpressionAttributeValues: {
            ":ok": "ASSEMBLY_COMPLETED",
            ":msg": "Processing completed",
            ":ljc": doneIso,
            ":ua": doneIso,
            ":dur": executionDuration,
            ":results": ctx.stepResults || {},
          },
        })
      );
      // Webhook notify with retries and optional HMAC
      try {
        const index = require(path.join(process.cwd(), "templates.index.cjs"));
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
  } catch (err) {
    // Update error status in DDB if available
    const tableName = process.env.DYNAMODB_TABLE as string;
    if (ddb && tableName) {
      const assemblyId = computeAssemblyIdFromObjects(
        objects,
        templateId,
        user
      );
      const errorIso = new Date().toISOString();
      await ddb.send(
        new UpdateCommand({
          TableName: tableName,
          Key: { assembly_id: assemblyId },
          UpdateExpression:
            "SET error = :err, message = :msg, updated_at = :ua",
          ExpressionAttributeValues: {
            ":err": "PROCESSING_ERROR",
            ":msg": (err as Error).message,
            ":ua": errorIso,
          },
        })
      );

      // Send webhook notification for errors too
      try {
        const index = require(path.join(process.cwd(), "templates.index.cjs"));
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

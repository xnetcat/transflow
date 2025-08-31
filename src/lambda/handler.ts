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
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import Redis from "ioredis";
import { spawn } from "child_process";
type S3EventLike = {
  Records: Array<{
    s3: { bucket: { name: string }; object: { key: string } };
  }>;
};
import type { TemplateDefinition, StepContext } from "../core/types";

function getRedis() {
  const url = process.env.REDIS_URL;
  if (url) return new (Redis as any)(url);
  return undefined;
}

async function publish(
  redis: Redis | undefined,
  channel: string,
  message: unknown
) {
  if (!redis) return;
  try {
    await redis.publish(channel, JSON.stringify(message));
  } catch {}
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

export const handler = async (event: S3EventLike) => {
  const redis = getRedis();
  const region =
    process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";
  const s3 = new S3Client({ region });
  const ddbEnabled = !!process.env.DYNAMODB_TABLE;
  const ddb = ddbEnabled
    ? DynamoDBDocumentClient.from(new DynamoDBClient({ region }))
    : undefined;

  for (const record of event.Records ?? []) {
    const bucket = record.s3.bucket.name;
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, " "));
    const head = await s3.send(
      new HeadObjectCommand({ Bucket: bucket, Key: key })
    );
    const meta = head.Metadata || {};
    const uploadId =
      (meta.uploadid as string) || (meta.uploadId as string) || "";
    const templateId =
      (meta.templateid as string) ||
      (meta.templateId as string) ||
      process.env.DEFAULT_TEMPLATE_ID ||
      "";
    const branch = process.env.TRANSFLOW_BRANCH || "";
    const channel = `upload:${uploadId}`;

    await publish(redis as any, channel, { type: "start", key, templateId });

    try {
      // Load baked template
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const index = require(path.join(process.cwd(), "templates.index.cjs"));
      const mod = index[templateId];
      if (!mod || !mod.default)
        throw new Error(`Template not found: ${templateId}`);
      const tpl: TemplateDefinition = mod.default;

      const tmpDir = fs.mkdtempSync(path.join("/tmp", `transflow-`));
      const outputBucket = process.env.OUTPUT_BUCKET || bucket;
      const outputPrefix = `outputs/${branch}/${uploadId}/`;
      const inputLocalPath = path.join(tmpDir, path.basename(key));
      const obj = await s3.send(
        new GetObjectCommand({ Bucket: bucket, Key: key })
      );
      const stream = obj.Body as any as NodeJS.ReadableStream;
      await new Promise<void>((resolve, reject) => {
        const w = fs.createWriteStream(inputLocalPath);
        stream.pipe(w);
        w.on("finish", () => resolve());
        w.on("error", reject);
      });

      const ctx: StepContext = {
        uploadId,
        input: { bucket, key },
        inputLocalPath,
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
            await s3.send(
              new PutObjectCommand({
                Bucket: outputBucket,
                Key: outKey,
                Body: body,
                ContentType: contentType,
              })
            );
            return { bucket: outputBucket, key: outKey };
          },
          generateKey: (basename) => `${outputPrefix}${basename}`,
          publish: (message) => publish(redis as any, channel, message),
        },
      };

      for (const step of tpl.steps) {
        await publish(redis as any, channel, {
          type: "step:start",
          step: step.name,
        });
        await step.run(ctx);
        await publish(redis as any, channel, {
          type: "step:done",
          step: step.name,
        });
      }

      const result = {
        status: "completed",
        templateId,
        input: { bucket, key },
        outputsPrefix: outputPrefix,
        uploadId,
      };
      if (ddbEnabled && ddb) {
        await ddb.send(
          new PutCommand({
            TableName: process.env.DYNAMODB_TABLE,
            Item: {
              jobId: uploadId,
              ...result,
              updatedAt: Date.now(),
              createdAt: Date.now(),
            },
          })
        );
      } else {
        await s3.send(
          new PutObjectCommand({
            Bucket: outputBucket,
            Key: `${outputPrefix}status.json`,
            Body: JSON.stringify(result),
            ContentType: "application/json",
          })
        );
      }
      await publish(redis as any, channel, { type: "done", ...result });
    } catch (err) {
      await publish(redis as any, channel, {
        type: "error",
        message: (err as Error).message,
      });
      throw err;
    }
  }
};

/*
  SQS Bridge Handler: Converts S3 events to SQS messages for concurrency control
  
  This handler receives S3 events and queues them for processing, providing:
  - Concurrency throttling via SQS visibility timeout
  - Batch processing capabilities
  - Error handling with DLQ support
  - Reduced Lambda cold start impact
*/

import {
  SQSClient,
  SendMessageCommand,
  SendMessageBatchCommand,
} from "@aws-sdk/client-sqs";
import { S3Client, HeadObjectCommand } from "@aws-sdk/client-s3";
import type { UserContext } from "../core/types";

type S3EventLike = {
  Records: Array<{
    s3: { bucket: { name: string }; object: { key: string } };
  }>;
};

type ProcessingJob = {
  uploadId: string;
  templateId: string;
  objects: Array<{ bucket: string; key: string }>;
  branch: string;
  fields?: Record<string, string>;
  user?: UserContext;
};

export const sqsBridgeHandler = async (event: S3EventLike) => {
  const region =
    process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";
  const queueUrl = process.env.SQS_QUEUE_URL;
  const branch = process.env.TRANSFLOW_BRANCH || "";

  if (!queueUrl) {
    throw new Error("SQS_QUEUE_URL environment variable is required");
  }

  const s3 = new S3Client({ region });
  const sqs = new SQSClient({ region });

  // Group S3 events by uploadId like the main handler does
  const expanded: Array<{
    bucket: string;
    key: string;
    uploadId: string;
    templateId: string;
    fields?: Record<string, string>;
    user?: UserContext;
  }> = [];

  for (const record of event.Records ?? []) {
    const bucket = record.s3.bucket.name;
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, " "));

    try {
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

      // Extract user context
      let user: UserContext | undefined;
      if (meta.userid) {
        user = {
          userId: meta.userid,
          permissions: meta.permissions ? JSON.parse(meta.permissions) : [],
          metadata: {},
        };
      }

      expanded.push({ bucket, key, uploadId, templateId, fields, user });
    } catch (error) {
      console.error(`Failed to process S3 object ${bucket}/${key}:`, error);
      // Continue processing other files
    }
  }

  // Group by uploadId
  const groups = new Map<string, typeof expanded>();
  for (const rec of expanded) {
    const id = rec.uploadId || `solo:${rec.bucket}:${rec.key}`;
    const list = groups.get(id) || ([] as typeof expanded);
    list.push(rec);
    groups.set(id, list);
  }

  // Convert groups to processing jobs and send to SQS
  const messages: Array<{ Id: string; MessageBody: string }> = [];

  for (const [groupId, items] of groups) {
    const uploadId = groupId.replace(/^solo:/, "");
    const first = items[0];

    const job: ProcessingJob = {
      uploadId,
      templateId: first.templateId,
      objects: items.map((item) => ({ bucket: item.bucket, key: item.key })),
      branch,
      fields: first.fields,
      user: first.user,
    };

    messages.push({
      Id: uploadId,
      MessageBody: JSON.stringify(job),
    });
  }

  // Send messages to SQS in batches (max 10 per batch)
  const batchSize = 10;
  for (let i = 0; i < messages.length; i += batchSize) {
    const batch = messages.slice(i, i + batchSize);

    if (batch.length === 1) {
      // Single message
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: batch[0].MessageBody,
          MessageGroupId: branch, // For FIFO queues
          MessageDeduplicationId: batch[0].Id, // For FIFO queues
        })
      );
    } else {
      // Batch send
      await sqs.send(
        new SendMessageBatchCommand({
          QueueUrl: queueUrl,
          Entries: batch.map((msg) => ({
            Id: msg.Id,
            MessageBody: msg.MessageBody,
            MessageGroupId: branch, // For FIFO queues
            MessageDeduplicationId: msg.Id, // For FIFO queues
          })),
        })
      );
    }
  }

  console.log(`Queued ${messages.length} processing jobs for branch ${branch}`);
};

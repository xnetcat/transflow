/*
  Long-lived worker that polls the configured SQS queue and runs the Lambda
  handler in-process. Lets you run the full pipeline against LocalStack without
  packaging or deploying a Lambda image.
*/
import path from "path";
import {
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
} from "@aws-sdk/client-sqs";
import type { TransflowConfig } from "../../core/types";
import {
  computeTmpBucketName,
  resolveQueueName,
} from "../../core/config";
import { makeSqsClient, resolveEndpoint } from "../../core/awsClients";

export interface LocalWorkerArgs {
  cfg: TransflowConfig;
  templatesIndexPath?: string;
  signal?: AbortSignal;
}

export async function localWorker(args: LocalWorkerArgs) {
  const { cfg, signal } = args;
  const endpoint = resolveEndpoint(cfg);
  if (!endpoint) {
    throw new Error(
      "local:worker requires cfg.endpoint or TRANSFLOW_AWS_ENDPOINT (e.g. http://localhost:4566)"
    );
  }

  const tmpBucket = computeTmpBucketName(cfg.project, cfg.region);
  const queueName = resolveQueueName(cfg);

  // Configure env so the imported handler module picks up the same endpoint
  // and resource names as the rest of the app.
  process.env.TRANSFLOW_AWS_ENDPOINT = endpoint;
  process.env.AWS_REGION = cfg.region;
  process.env.SQS_QUEUE_URL = ""; // resolved below
  process.env.TRANSFLOW_TMP_BUCKET = tmpBucket;
  process.env.TRANSFLOW_ALLOWED_BUCKETS = JSON.stringify(
    cfg.s3.exportBuckets || []
  );
  process.env.DYNAMODB_TABLE = cfg.dynamoDb.tableName;
  process.env.TRANSFLOW_PROJECT = cfg.project;
  process.env.TRANSFLOW_BRANCH = process.env.TRANSFLOW_BRANCH || "local";
  process.env.MAX_BATCH_SIZE = String(cfg.lambda.maxBatchSize ?? 10);
  process.env.TRANSFLOW_TTL_DAYS = String(cfg.dynamoDb.ttlDays ?? 30);

  if (args.templatesIndexPath) {
    process.env.TEMPLATES_INDEX_PATH = path.resolve(args.templatesIndexPath);
  }

  if (cfg.credentials) {
    process.env.TRANSFLOW_AWS_ACCESS_KEY_ID = cfg.credentials.accessKeyId;
    process.env.TRANSFLOW_AWS_SECRET_ACCESS_KEY = cfg.credentials.secretAccessKey;
  } else {
    // LocalStack accepts dummy creds
    process.env.TRANSFLOW_AWS_ACCESS_KEY_ID =
      process.env.TRANSFLOW_AWS_ACCESS_KEY_ID || "test";
    process.env.TRANSFLOW_AWS_SECRET_ACCESS_KEY =
      process.env.TRANSFLOW_AWS_SECRET_ACCESS_KEY || "test";
  }

  const sqs = makeSqsClient(cfg);
  const queueUrl = (
    await sqs.send(new GetQueueUrlCommand({ QueueName: queueName }))
  ).QueueUrl;
  if (!queueUrl) throw new Error(`Queue not found: ${queueName}`);
  process.env.SQS_QUEUE_URL = queueUrl;

  // Lazy import so env vars are set before the handler module wires up clients.
  const { handler } = await import("../../lambda/handler");

  console.log(`🛠  local:worker polling ${queueUrl}`);
  console.log(`    endpoint=${endpoint}  bucket=${tmpBucket}`);

  while (!signal?.aborted) {
    const resp = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 5,
        VisibilityTimeout: cfg.sqs.visibilityTimeoutSec ?? 960,
      })
    );
    const messages = resp.Messages ?? [];
    if (messages.length === 0) continue;

    const event = {
      Records: messages.map((m) => ({
        body: m.Body ?? "{}",
        receiptHandle: m.ReceiptHandle ?? "",
        messageId: m.MessageId ?? "",
      })),
    };

    try {
      await handler(event as any);
      await Promise.all(
        messages.map((m) =>
          sqs.send(
            new DeleteMessageCommand({
              QueueUrl: queueUrl,
              ReceiptHandle: m.ReceiptHandle,
            })
          )
        )
      );
    } catch (err) {
      console.error("worker batch failed (messages will retry):", err);
    }
  }
}

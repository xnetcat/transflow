/*
  Provision a LocalStack environment so the rest of the stack (Next.js dev,
  the local worker) can talk to it. Idempotent.
*/
import path from "path";
import {
  CreateBucketCommand,
  HeadBucketCommand,
  PutBucketCorsCommand,
  PutBucketLifecycleConfigurationCommand,
  PutBucketNotificationConfigurationCommand,
  type NotificationConfiguration,
} from "@aws-sdk/client-s3";
import {
  CreateQueueCommand,
  GetQueueUrlCommand,
} from "@aws-sdk/client-sqs";
import {
  CreateTableCommand,
  DescribeTableCommand,
  UpdateTimeToLiveCommand,
} from "@aws-sdk/client-dynamodb";
import type { TransflowConfig } from "../../core/types";
import {
  computeTmpBucketName,
  isFifoQueue,
  resolveDlqName,
  resolveQueueName,
} from "../../core/config";
import {
  makeS3Client,
  makeSqsClient,
  makeDynamoClient,
  resolveEndpoint,
} from "../../core/awsClients";

export async function localStart({ cfg }: { cfg: TransflowConfig }) {
  const endpoint = resolveEndpoint(cfg);
  if (!endpoint) {
    throw new Error(
      "local:start requires a custom endpoint (set cfg.endpoint or TRANSFLOW_AWS_ENDPOINT, e.g. http://localhost:4566)"
    );
  }

  console.log(`🚀 Provisioning Transflow resources against ${endpoint}`);

  const s3 = makeS3Client(cfg);
  const sqs = makeSqsClient(cfg);
  const ddb = makeDynamoClient(cfg);

  // Buckets
  const tmpBucket = computeTmpBucketName(cfg.project, cfg.region);
  const buckets = [tmpBucket, ...(cfg.s3.exportBuckets || [])];
  for (const bucket of buckets) {
    try {
      await s3.send(new HeadBucketCommand({ Bucket: bucket }));
      console.log(`  ✓ bucket ${bucket}`);
    } catch {
      const params: any = { Bucket: bucket };
      if (cfg.region !== "us-east-1") {
        params.CreateBucketConfiguration = { LocationConstraint: cfg.region };
      }
      await s3.send(new CreateBucketCommand(params));
      console.log(`  + bucket ${bucket}`);
    }
  }

  // CORS
  await s3.send(
    new PutBucketCorsCommand({
      Bucket: tmpBucket,
      CORSConfiguration: {
        CORSRules: [
          {
            AllowedMethods: ["PUT", "POST", "GET", "HEAD"],
            AllowedOrigins: cfg.s3.corsAllowedOrigins ?? ["*"],
            AllowedHeaders: ["*"],
            ExposeHeaders: ["ETag"],
            MaxAgeSeconds: 3000,
          },
        ],
      },
    })
  );

  // Lifecycle: same defaults as deploy.ts. LocalStack accepts the call but
  // doesn't actually expire objects — we apply it for parity with prod.
  const tmpRetentionDays = cfg.s3.tmpRetentionDays ?? 7;
  if (tmpRetentionDays > 0) {
    try {
      await s3.send(
        new PutBucketLifecycleConfigurationCommand({
          Bucket: tmpBucket,
          LifecycleConfiguration: {
            Rules: [
              {
                ID: "transflow-uploads-expire",
                Status: "Enabled",
                Filter: { Prefix: "uploads/" },
                Expiration: { Days: tmpRetentionDays },
                AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
              },
              {
                ID: "transflow-outputs-expire",
                Status: "Enabled",
                Filter: { Prefix: "outputs/" },
                Expiration: { Days: tmpRetentionDays * 4 },
              },
            ],
          },
        })
      );
    } catch {
      // Older LocalStack versions reject this — non-fatal.
    }
  }

  // SQS queues. LocalStack doesn't enforce FIFO routing constraints with S3,
  // but we honor cfg.sqs.fifo for parity.
  const fifo = isFifoQueue(cfg);
  const dlqName = resolveDlqName(cfg);
  const queueName = resolveQueueName(cfg);

  await sqs
    .send(
      new CreateQueueCommand({
        QueueName: dlqName,
        Attributes: fifo
          ? { FifoQueue: "true", ContentBasedDeduplication: "true" }
          : {},
      })
    )
    .catch((e) => {
      if (e?.name !== "QueueAlreadyExists") throw e;
    });

  await sqs
    .send(
      new CreateQueueCommand({
        QueueName: queueName,
        Attributes: {
          ...(fifo
            ? { FifoQueue: "true", ContentBasedDeduplication: "true" }
            : {}),
          VisibilityTimeout: cfg.sqs.visibilityTimeoutSec?.toString() || "960",
        },
      })
    )
    .catch((e) => {
      if (e?.name !== "QueueAlreadyExists") throw e;
    });
  const queueUrl = (
    await sqs.send(new GetQueueUrlCommand({ QueueName: queueName }))
  ).QueueUrl as string;
  console.log(`  ✓ sqs ${queueName}`);

  // DynamoDB table
  try {
    await ddb.send(
      new DescribeTableCommand({ TableName: cfg.dynamoDb.tableName })
    );
    console.log(`  ✓ table ${cfg.dynamoDb.tableName}`);
  } catch {
    await ddb.send(
      new CreateTableCommand({
        TableName: cfg.dynamoDb.tableName,
        AttributeDefinitions: [
          { AttributeName: "assembly_id", AttributeType: "S" },
        ],
        KeySchema: [{ AttributeName: "assembly_id", KeyType: "HASH" }],
        BillingMode: "PAY_PER_REQUEST",
      })
    );
    console.log(`  + table ${cfg.dynamoDb.tableName}`);

    if ((cfg.dynamoDb.ttlDays ?? 30) > 0) {
      try {
        await ddb.send(
          new UpdateTimeToLiveCommand({
            TableName: cfg.dynamoDb.tableName,
            TimeToLiveSpecification: { Enabled: true, AttributeName: "ttl" },
          })
        );
      } catch {
        // LocalStack may not support TTL — non-fatal
      }
    }
  }

  // S3 → SQS notification: tmp bucket / uploads/ → SQS queue. In LocalStack we
  // can route directly to SQS (no Lambda hop) for simpler dev flows.
  // For real AWS this requires a non-FIFO queue; the cfg.sqs.fifo=false case.
  const queueArn = `arn:aws:sqs:${cfg.region}:000000000000:${queueName}`;
  if (!fifo) {
    const notif: NotificationConfiguration = {
      QueueConfigurations: [
        {
          Events: ["s3:ObjectCreated:*"],
          QueueArn: queueArn,
          Filter: {
            Key: { FilterRules: [{ Name: "prefix", Value: "uploads/" }] },
          },
        },
      ],
    };
    await s3.send(
      new PutBucketNotificationConfigurationCommand({
        Bucket: tmpBucket,
        NotificationConfiguration: notif,
      })
    );
    console.log(`  ✓ s3:${tmpBucket}/uploads → sqs:${queueName}`);
  } else {
    console.log(
      `  ⚠ FIFO queue: skipping S3→SQS direct notification (run "transflow local:worker" instead)`
    );
  }

  console.log(`\n✅ LocalStack ready. Queue: ${queueUrl}`);
  console.log(
    `   Run "transflow local:worker" in another terminal to process uploads.`
  );

  return { queueUrl };
}

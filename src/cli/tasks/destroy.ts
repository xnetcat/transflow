import { DeleteFunctionCommand } from "@aws-sdk/client-lambda";
import {
  S3Client,
  DeleteBucketCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";
import {
  DeleteQueueCommand,
  GetQueueUrlCommand,
} from "@aws-sdk/client-sqs";
import { DeleteTableCommand } from "@aws-sdk/client-dynamodb";
import { DeleteRepositoryCommand } from "@aws-sdk/client-ecr";
import type { TransflowConfig } from "../../core/types";
import { computeTmpBucketName, resolveQueueName } from "../../core/config";
import {
  makeLambdaClient,
  makeS3Client,
  makeSqsClient,
  makeDynamoClient,
  makeEcrClient,
} from "../../core/awsClients";

interface DestroyArgs {
  cfg: TransflowConfig;
  force: boolean;
  nonInteractive: boolean;
}

/**
 * Completely destroy all Transflow AWS resources for a project
 * WARNING: This is destructive and will delete all data!
 */
export async function destroy(args: DestroyArgs) {
  const { cfg, force, nonInteractive } = args;
  const region = cfg.region;
  const queueName = resolveQueueName(cfg);

  if (!force && !nonInteractive) {
    console.log(
      "⚠️  WARNING: This will destroy ALL Transflow resources for this project!"
    );
    console.log("Resources to be deleted:");
    console.log(`  - Lambda: ${cfg.lambdaPrefix}${cfg.project}`);
    console.log(`  - Lambda: ${cfg.project}-status`);
    console.log(`  - DynamoDB: ${cfg.dynamoDb.tableName}`);
    console.log(`  - SQS: ${queueName}`);
    console.log(
      `  - S3: ${computeTmpBucketName(cfg.project, region)} (and all objects)`
    );
    console.log(`  - S3: ${cfg.s3.exportBuckets?.join(", ")} (if managed)`);
    console.log(`  - ECR: ${cfg.ecrRepo}`);

    const readline = await import("readline");
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const answer = await new Promise<string>((resolve) => {
      rl.question("Type 'DESTROY' to confirm: ", resolve);
    });
    rl.close();

    if (answer !== "DESTROY") {
      console.log("❌ Destruction cancelled");
      return;
    }
  }

  console.log("🗑️  Starting destruction of Transflow resources...");

  const lambda = makeLambdaClient(cfg);
  const s3 = makeS3Client(cfg);
  const sqs = makeSqsClient(cfg);
  const dynamodb = makeDynamoClient(cfg);
  const ecr = makeEcrClient(cfg);

  // Delete Lambda functions
  const functionName = `${cfg.lambdaPrefix}${cfg.project}`;
  const statusFunctionName = `${cfg.project}-status`;

  for (const fn of [functionName, statusFunctionName]) {
    try {
      await lambda.send(new DeleteFunctionCommand({ FunctionName: fn }));
      console.log(`✅ Deleted Lambda: ${fn}`);
    } catch (error: any) {
      if (error.name !== "ResourceNotFoundException") {
        console.warn(`⚠️  Failed to delete Lambda ${fn}: ${error.message}`);
      }
    }
  }

  // Delete SQS queue
  try {
    const { QueueUrl } = await sqs.send(
      new GetQueueUrlCommand({ QueueName: queueName })
    );
    if (QueueUrl) {
      await sqs.send(new DeleteQueueCommand({ QueueUrl }));
      console.log(`✅ Deleted SQS queue: ${queueName}`);
    }
  } catch (error: any) {
    if (error.name !== "QueueDoesNotExist") {
      console.warn(`⚠️  Failed to delete SQS queue: ${error.message}`);
    }
  }

  // Delete DynamoDB table
  try {
    await dynamodb.send(
      new DeleteTableCommand({ TableName: cfg.dynamoDb.tableName })
    );
    console.log(`✅ Deleted DynamoDB table: ${cfg.dynamoDb.tableName}`);
  } catch (error: any) {
    if (error.name !== "ResourceNotFoundException") {
      console.warn(`⚠️  Failed to delete DynamoDB table: ${error.message}`);
    }
  }

  // Delete S3 buckets (empty them first)
  const tmpBucket = computeTmpBucketName(cfg.project, region);
  const bucketsToDelete = [tmpBucket];

  // Only delete export buckets if explicitly managed by Transflow
  // (we don't want to accidentally delete user's existing buckets)

  for (const bucket of bucketsToDelete) {
    try {
      // Empty bucket first
      await emptyBucket(s3, bucket);

      // Delete bucket
      await s3.send(new DeleteBucketCommand({ Bucket: bucket }));
      console.log(`✅ Deleted S3 bucket: ${bucket}`);
    } catch (error: any) {
      if (error.name !== "NoSuchBucket") {
        console.warn(`⚠️  Failed to delete bucket ${bucket}: ${error.message}`);
      }
    }
  }

  // Delete ECR repository
  try {
    await ecr.send(
      new DeleteRepositoryCommand({
        repositoryName: cfg.ecrRepo,
        force: true, // Delete even if it contains images
      })
    );
    console.log(`✅ Deleted ECR repository: ${cfg.ecrRepo}`);
  } catch (error: any) {
    if (error.name !== "RepositoryNotFoundException") {
      console.warn(`⚠️  Failed to delete ECR repository: ${error.message}`);
    }
  }

  console.log("✅ Destruction complete!");
}

async function emptyBucket(s3: S3Client, bucket: string) {
  let token: string | undefined = undefined;
  do {
    const listed = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        ContinuationToken: token,
      })
    );

    if (listed.Contents && listed.Contents.length > 0) {
      await s3.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: {
            Objects: listed.Contents.map((o) => ({ Key: o.Key! })),
          },
        })
      );
    }

    token = listed.NextContinuationToken;
  } while (token);
}

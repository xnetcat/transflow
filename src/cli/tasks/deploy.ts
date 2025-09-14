import path from "path";
import { execa } from "execa";
import {
  LambdaClient,
  CreateFunctionCommand,
  UpdateFunctionCodeCommand,
  UpdateFunctionConfigurationCommand,
  GetFunctionCommand,
  AddPermissionCommand,
  PutFunctionConcurrencyCommand,
  CreateEventSourceMappingCommand,
  ListEventSourceMappingsCommand,
} from "@aws-sdk/client-lambda";
import {
  ECRClient,
  CreateRepositoryCommand,
  DescribeRepositoriesCommand,
} from "@aws-sdk/client-ecr";
import {
  S3Client,
  CreateBucketCommand,
  PutBucketNotificationConfigurationCommand,
  GetBucketNotificationConfigurationCommand,
  HeadBucketCommand,
  type LambdaFunctionConfiguration,
  type NotificationConfiguration,
} from "@aws-sdk/client-s3";
import {
  SQSClient,
  CreateQueueCommand,
  GetQueueAttributesCommand,
  SetQueueAttributesCommand,
} from "@aws-sdk/client-sqs";
// No IAM client required here; Lambda AddPermission is used for S3 invoke
import type { TransflowConfig } from "../../core/types";

interface DeployArgs {
  cfg: TransflowConfig;
  branch: string;
  sha: string;
  tag: string;
  nonInteractive: boolean;
}

function imageUri(
  accountId: string,
  region: string,
  repo: string,
  tag: string
) {
  return `${accountId}.dkr.ecr.${region}.amazonaws.com/${repo}:${tag}`;
}

export async function deploy(args: DeployArgs) {
  const { cfg, branch, sha, tag } = args;
  const region = cfg.region;
  const ecr = new ECRClient({ region });
  const lambda = new LambdaClient({ region });
  const s3 = new S3Client({ region });
  const sqs = new SQSClient({ region });

  // Ensure ECR repo
  try {
    await ecr.send(
      new DescribeRepositoriesCommand({ repositoryNames: [cfg.ecrRepo] })
    );
  } catch {
    await ecr.send(
      new CreateRepositoryCommand({ repositoryName: cfg.ecrRepo })
    );
  }

  // Get AWS account ID
  const { stdout }: { stdout: string } = await execa(
    "aws",
    ["sts", "get-caller-identity", "--query", "Account", "--output", "text"],
    { env: process.env }
  );
  const accountId = stdout.trim();

  // Docker build & push
  const contextDir = path.isAbsolute(cfg.lambdaBuildContext)
    ? cfg.lambdaBuildContext
    : path.resolve(process.cwd(), cfg.lambdaBuildContext);
  const imgUri = imageUri(accountId, region, cfg.ecrRepo, tag);
  await execa("aws", ["ecr", "get-login-password", "--region", region], {
    stdio: ["ignore", "pipe", "inherit"],
  })
    .then(({ stdout }) =>
      execa(
        "docker",
        [
          "login",
          "--username",
          "AWS",
          "--password-stdin",
          `${accountId}.dkr.ecr.${region}.amazonaws.com`,
        ],
        { input: stdout }
      )
    )
    .then(() =>
      execa("docker", ["build", "-t", imgUri, contextDir], { stdio: "inherit" })
    )
    .then(() => execa("docker", ["push", imgUri], { stdio: "inherit" }));

  // Setup SQS queues - shared for all branches (no per-branch suffix by default)
  let queueUrl: string | undefined;
  let progressQueueUrl: string | undefined;
  let dlqUrl: string | undefined;

  // SQS is now required - use shared names if provided
  const queueName = cfg.sqs.queueName || `${cfg.project}-processing.fifo`;
  // Progress queue removed (DynamoDB is the status store)
  const dlqName = `${cfg.project}-dlq.fifo`;

  // Create DLQ first
  try {
    const dlqResult = await sqs.send(
      new CreateQueueCommand({
        QueueName: dlqName,
        Attributes: {
          FifoQueue: "true",
          ContentBasedDeduplication: "true",
          MessageRetentionPeriod: "1209600", // 14 days
        },
      })
    );
    dlqUrl = dlqResult.QueueUrl;
  } catch (error: any) {
    if (error.name !== "QueueAlreadyExists") throw error;
    // Get existing DLQ URL
    const attrs = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: `https://sqs.${region}.amazonaws.com/${accountId}/${dlqName}`,
        AttributeNames: ["QueueArn"],
      })
    );
    dlqUrl = `https://sqs.${region}.amazonaws.com/${accountId}/${dlqName}`;
  }

  // Create main queue with DLQ
  try {
    const queueResult = await sqs.send(
      new CreateQueueCommand({
        QueueName: queueName,
        Attributes: {
          FifoQueue: "true",
          ContentBasedDeduplication: "true",
          VisibilityTimeout: cfg.sqs.visibilityTimeoutSec?.toString() || "960",
          RedrivePolicy: JSON.stringify({
            deadLetterTargetArn: `arn:aws:sqs:${region}:${accountId}:${dlqName}`,
            maxReceiveCount: cfg.sqs.maxReceiveCount || 3,
          }),
        },
      })
    );
    queueUrl = queueResult.QueueUrl;
  } catch (error: any) {
    if (error.name !== "QueueAlreadyExists") throw error;
    // Get existing queue URL
    queueUrl = `https://sqs.${region}.amazonaws.com/${accountId}/${queueName}`;
  }

  // No progress queue anymore (DDB is the source of truth)
  progressQueueUrl = undefined;

  // Create or update main processing Lambda
  const functionName = `${cfg.lambdaPrefix}${branch}`;
  const imageConfig = { ImageUri: imgUri };
  let exists = true;
  try {
    await lambda.send(new GetFunctionCommand({ FunctionName: functionName }));
  } catch {
    exists = false;
  }

  if (!exists) {
    const branchBucket = `${cfg.project}-${branch}`;
    const envVars: Record<string, string> = {
      TRANSFLOW_BRANCH: branch,
      AWS_REGION: region,
      MAX_BATCH_SIZE: cfg.lambda.maxBatchSize?.toString() || "10",
    };

    if (queueUrl) {
      envVars["SQS_QUEUE_URL"] = queueUrl;
    }
    // No progress queue env
    if (cfg.s3.mode === "prefix") {
      if (cfg.s3.uploadBucket) envVars["UPLOAD_BUCKET"] = cfg.s3.uploadBucket;
      if (cfg.s3.outputBucket) envVars["OUTPUT_BUCKET"] = cfg.s3.outputBucket;
    } else {
      envVars["UPLOAD_BUCKET"] = branchBucket;
      envVars["OUTPUT_BUCKET"] = branchBucket;
    }
    envVars["DYNAMODB_TABLE"] = cfg.dynamoDb.tableName;
    envVars["TRANSFLOW_PROJECT"] = cfg.project;
    await lambda.send(
      new CreateFunctionCommand({
        FunctionName: functionName,
        PackageType: "Image",
        Code: imageConfig,
        Role: cfg.lambda.roleArn!,
        MemorySize: cfg.lambda.memoryMb,
        Timeout: cfg.lambda.timeoutSec,
        Architectures: cfg.lambda.architecture
          ? [cfg.lambda.architecture]
          : undefined,
        Environment: { Variables: envVars },
      })
    );
  } else {
    await lambda.send(
      new UpdateFunctionCodeCommand({
        FunctionName: functionName,
        ImageUri: imgUri,
      })
    );
    const branchBucket = `${cfg.project}-${branch}`;
    const envVars: Record<string, string> = {
      TRANSFLOW_BRANCH: branch,
      AWS_REGION: region,
      MAX_BATCH_SIZE: cfg.lambda.maxBatchSize?.toString() || "10",
    };

    if (queueUrl) {
      envVars["SQS_QUEUE_URL"] = queueUrl;
    }
    // No progress queue env

    if (cfg.s3.mode === "prefix") {
      if (cfg.s3.uploadBucket) envVars["UPLOAD_BUCKET"] = cfg.s3.uploadBucket;
      if (cfg.s3.outputBucket) envVars["OUTPUT_BUCKET"] = cfg.s3.outputBucket;
    } else {
      envVars["UPLOAD_BUCKET"] = branchBucket;
      envVars["OUTPUT_BUCKET"] = branchBucket;
    }
    envVars["DYNAMODB_TABLE"] = cfg.dynamoDb.tableName;
    envVars["TRANSFLOW_PROJECT"] = cfg.project;
    await lambda.send(
      new UpdateFunctionConfigurationCommand({
        FunctionName: functionName,
        MemorySize: cfg.lambda.memoryMb,
        Timeout: cfg.lambda.timeoutSec,
        Environment: { Variables: envVars },
      })
    );
  }

  // Set reserved concurrency if specified
  if (cfg.lambda.reservedConcurrency) {
    try {
      await lambda.send(
        new PutFunctionConcurrencyCommand({
          FunctionName: functionName,
          ReservedConcurrentExecutions: cfg.lambda.reservedConcurrency,
        })
      );
    } catch (error) {
      console.warn(`Failed to set reserved concurrency: ${error}`);
    }
  }

  // Create SQS event source mapping - SQS is now required
  if (queueUrl) {
    const queueArn = `arn:aws:sqs:${region}:${accountId}:${queueName}`;

    // Check if event source mapping already exists
    const existingMappings = await lambda.send(
      new ListEventSourceMappingsCommand({
        FunctionName: functionName,
        EventSourceArn: queueArn,
      })
    );

    if (existingMappings.EventSourceMappings?.length === 0) {
      await lambda.send(
        new CreateEventSourceMappingCommand({
          FunctionName: functionName,
          EventSourceArn: queueArn,
          BatchSize: cfg.sqs.batchSize || 10,
          MaximumBatchingWindowInSeconds: 5, // Reduce latency
        })
      );
    }
  }

  // Remove separate bridge Lambda; main Lambda handles S3 events by enqueuing into SQS

  // S3 setup: Create only explicitly listed buckets and NEVER delete
  // Ensure DynamoDB table exists
  try {
    await execa(
      "aws",
      [
        "dynamodb",
        "describe-table",
        "--table-name",
        cfg.dynamoDb.tableName,
        "--region",
        region,
      ],
      { stdio: "ignore" }
    );
  } catch {
    await execa(
      "aws",
      [
        "dynamodb",
        "create-table",
        "--table-name",
        cfg.dynamoDb.tableName,
        "--attribute-definitions",
        "AttributeName=assembly_id,AttributeType=S",
        "--key-schema",
        "AttributeName=assembly_id,KeyType=HASH",
        "--billing-mode",
        "PAY_PER_REQUEST",
        "--region",
        region,
      ],
      { stdio: "inherit" }
    );
  }
  if (Array.isArray(cfg.s3.buckets) && cfg.s3.buckets.length > 0) {
    for (const bucket of cfg.s3.buckets) {
      try {
        await s3.send(new HeadBucketCommand({ Bucket: bucket }));
      } catch {
        const params: any = { Bucket: bucket };
        if (region !== "us-east-1")
          params.CreateBucketConfiguration = { LocationConstraint: region };
        await s3.send(new CreateBucketCommand(params));
      }
    }
  } else if (cfg.s3.mode === "prefix") {
    // Back-compat: ensure upload/output buckets if provided
    if (cfg.s3.uploadBucket) {
      try {
        await s3.send(new HeadBucketCommand({ Bucket: cfg.s3.uploadBucket }));
      } catch {
        const params: any = { Bucket: cfg.s3.uploadBucket };
        if (region !== "us-east-1")
          params.CreateBucketConfiguration = { LocationConstraint: region };
        await s3.send(new CreateBucketCommand(params));
      }
    }
    if (cfg.s3.outputBucket && cfg.s3.outputBucket !== cfg.s3.uploadBucket) {
      try {
        await s3.send(new HeadBucketCommand({ Bucket: cfg.s3.outputBucket }));
      } catch {
        const params: any = { Bucket: cfg.s3.outputBucket };
        if (region !== "us-east-1")
          params.CreateBucketConfiguration = { LocationConstraint: region };
        await s3.send(new CreateBucketCommand(params));
      }
    }
  }
  // Add PutBucketNotificationConfiguration scoped to uploads/ prefix (shared)
  if (cfg.s3.mode === "prefix" && cfg.s3.uploadBucket) {
    const bucket = cfg.s3.uploadBucket;
    const prefix = `uploads/`;
    const current = await s3.send(
      new GetBucketNotificationConfigurationCommand({ Bucket: bucket })
    );
    const lambdaConfigs: LambdaFunctionConfiguration[] =
      current.LambdaFunctionConfigurations ?? [];

    // Use main function; it will enqueue into SQS
    const targetFunctionName = functionName;
    const functionArn = `arn:aws:lambda:${region}:${accountId}:function:${targetFunctionName}`;

    const existing = lambdaConfigs.find(
      (c) =>
        c.LambdaFunctionArn === functionArn &&
        (c.Filter?.Key?.FilterRules ?? []).some(
          (r) => r.Name === "prefix" && r.Value === prefix
        )
    );
    if (!existing) {
      lambdaConfigs.push({
        Events: ["s3:ObjectCreated:*"],
        LambdaFunctionArn: functionArn,
        Filter: { Key: { FilterRules: [{ Name: "prefix", Value: prefix }] } },
      });
      const notif: NotificationConfiguration = {
        LambdaFunctionConfigurations: lambdaConfigs,
      };
      await s3.send(
        new PutBucketNotificationConfigurationCommand({
          Bucket: bucket,
          NotificationConfiguration: notif,
        })
      );
      // Allow S3 to invoke Lambda
      try {
        await lambda.send(
          new AddPermissionCommand({
            FunctionName: targetFunctionName,
            Action: "lambda:InvokeFunction",
            Principal: "s3.amazonaws.com",
            StatementId: `s3-invoke-${branch}`,
            SourceArn: `arn:aws:s3:::${bucket}`,
          })
        );
      } catch {}
    }
  }
  if (cfg.s3.mode === "bucket") {
    // Legacy: bucket-per-branch. If present, set uploads/ notifications.
    const bucket = `${cfg.project}-${branch}`;
    const prefix = `uploads/`;
    const current = await s3.send(
      new GetBucketNotificationConfigurationCommand({ Bucket: bucket })
    );
    const lambdaConfigs: LambdaFunctionConfiguration[] =
      current.LambdaFunctionConfigurations ?? [];

    const targetFunctionName = functionName;
    const functionArn = `arn:aws:lambda:${region}:${accountId}:function:${targetFunctionName}`;

    const existing = lambdaConfigs.find(
      (c) =>
        c.LambdaFunctionArn === functionArn &&
        (c.Filter?.Key?.FilterRules ?? []).some(
          (r) => r.Name === "prefix" && r.Value === prefix
        )
    );
    if (!existing) {
      lambdaConfigs.push({
        Events: ["s3:ObjectCreated:*"],
        LambdaFunctionArn: functionArn,
        Filter: { Key: { FilterRules: [{ Name: "prefix", Value: prefix }] } },
      });
      const notif: NotificationConfiguration = {
        LambdaFunctionConfigurations: lambdaConfigs,
      };
      await s3.send(
        new PutBucketNotificationConfigurationCommand({
          Bucket: bucket,
          NotificationConfiguration: notif,
        })
      );
      try {
        await lambda.send(
          new AddPermissionCommand({
            FunctionName: targetFunctionName,
            Action: "lambda:InvokeFunction",
            Principal: "s3.amazonaws.com",
            StatementId: `s3-invoke-${branch}`,
            SourceArn: `arn:aws:s3:::${bucket}`,
          })
        );
      } catch {}
    }
  }

  // Deploy status Lambda if enabled
  if (cfg.statusLambda?.enabled) {
    const statusFunctionName =
      cfg.statusLambda.functionName || `${cfg.project}-status`;

    console.log(`🚀 Deploying status Lambda: ${statusFunctionName}`);

    let statusExists = true;
    try {
      await lambda.send(
        new GetFunctionCommand({ FunctionName: statusFunctionName })
      );
    } catch {
      statusExists = false;
    }

    const statusEnvVars: Record<string, string> = {
      DYNAMODB_TABLE: cfg.dynamoDb.tableName,
      TRANSFLOW_PROJECT: cfg.project,
    };

    if (!statusExists) {
      // Create status Lambda function
      await lambda.send(
        new CreateFunctionCommand({
          FunctionName: statusFunctionName,
          Code: imageConfig,
          Role: cfg.statusLambda.roleArn || cfg.lambda.roleArn!,
          MemorySize: cfg.statusLambda.memoryMb || 512,
          Timeout: cfg.statusLambda.timeoutSec || 30,
          Architectures: cfg.lambda.architecture
            ? [cfg.lambda.architecture]
            : undefined,
          Environment: { Variables: statusEnvVars },
          Description: `Transflow status checker for ${cfg.project}`,
          Tags: {
            Project: cfg.project,
            Component: "status-lambda",
          },
        })
      );
      console.log(`✅ Created status Lambda: ${statusFunctionName}`);
    } else {
      // Update existing status Lambda
      await lambda.send(
        new UpdateFunctionCodeCommand({
          FunctionName: statusFunctionName,
          ImageUri: imgUri,
        })
      );

      await lambda.send(
        new UpdateFunctionConfigurationCommand({
          FunctionName: statusFunctionName,
          MemorySize: cfg.statusLambda.memoryMb || 512,
          Timeout: cfg.statusLambda.timeoutSec || 30,
          Environment: { Variables: statusEnvVars },
        })
      );
      console.log(`✅ Updated status Lambda: ${statusFunctionName}`);
    }
  }

  return {
    imageUri: imgUri,
    functionName,
    statusFunctionName: cfg.statusLambda?.enabled
      ? cfg.statusLambda.functionName || `${cfg.project}-status`
      : undefined,
  };
}

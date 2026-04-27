import path from "path";
import fs from "fs";
import { execa } from "execa";
import {
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
  CreateRepositoryCommand,
  DescribeRepositoriesCommand,
  GetAuthorizationTokenCommand,
  PutLifecyclePolicyCommand,
} from "@aws-sdk/client-ecr";
import {
  CreateBucketCommand,
  PutBucketNotificationConfigurationCommand,
  HeadBucketCommand,
  PutBucketCorsCommand,
  PutBucketLifecycleConfigurationCommand,
  type NotificationConfiguration,
} from "@aws-sdk/client-s3";
import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
} from "@aws-sdk/client-sqs";
import {
  GetRoleCommand,
  CreateRoleCommand,
  AttachRolePolicyCommand,
  PutRolePolicyCommand,
} from "@aws-sdk/client-iam";
import {
  CreateTableCommand,
  DescribeTableCommand,
  UpdateTimeToLiveCommand,
  DescribeTimeToLiveCommand,
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
  makeLambdaClient,
  makeEcrClient,
  makeIamClient,
  resolveEndpoint,
  LOCALSTACK_ACCOUNT_ID,
} from "../../core/awsClients";
import { bakeTemplates } from "../../core/bake";

interface DeployArgs {
  cfg: TransflowConfig;
  branch: string;
  sha: string;
  tag: string;
  nonInteractive: boolean;
  forceRebuild?: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function imageUri(
  accountId: string,
  region: string,
  repo: string,
  tag: string,
  endpoint?: string
) {
  if (endpoint) {
    // LocalStack ECR uses host-based addressing too, but the endpoint is mounted at port 4566.
    // We don't actually push images in LocalStack mode; this string is only used as the Lambda ImageUri.
    const host = endpoint.replace(/^https?:\/\//, "").replace(/\/+$/, "");
    return `${host}/${repo}:${tag}`;
  }
  return `${accountId}.dkr.ecr.${region}.amazonaws.com/${repo}:${tag}`;
}

async function getAccountId(cfg: TransflowConfig): Promise<string> {
  if (resolveEndpoint(cfg)) return LOCALSTACK_ACCOUNT_ID;
  const { stdout }: { stdout: string } = await execa(
    "aws",
    ["sts", "get-caller-identity", "--query", "Account", "--output", "text"],
    { env: process.env }
  );
  return stdout.trim();
}

export async function deploy(args: DeployArgs) {
  const { cfg, branch, sha, tag } = args;
  const region = cfg.region;
  const endpoint = resolveEndpoint(cfg);
  const isLocal = !!endpoint;

  const ecr = makeEcrClient(cfg);
  const lambda = makeLambdaClient(cfg);
  const s3 = makeS3Client(cfg);
  const sqs = makeSqsClient(cfg);
  const iam = makeIamClient(cfg);
  const ddb = makeDynamoClient(cfg);

  async function waitForLambdaUpdate(functionName: string) {
    const start = Date.now();
    const timeoutMs = 5 * 60 * 1000;
    while (true) {
      const { Configuration } = await lambda.send(
        new GetFunctionCommand({ FunctionName: functionName })
      );
      const status = (Configuration as any)?.LastUpdateStatus as
        | "Successful"
        | "InProgress"
        | "Failed"
        | undefined;
      if (status === "Successful" || status === undefined) return;
      if (status === "Failed")
        throw new Error(`Lambda update failed for ${functionName}`);
      if (Date.now() - start > timeoutMs) {
        throw new Error(
          `Timeout waiting for Lambda update for ${functionName}`
        );
      }
      await sleep(5000);
    }
  }

  const tmpBucket = computeTmpBucketName(cfg.project, cfg.region);

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

  // Apply ECR lifecycle policy (keep only N most recent images)
  const retainImages = cfg.ecr?.retainImages ?? 10;
  if (!isLocal) {
    try {
      await ecr.send(
        new PutLifecyclePolicyCommand({
          repositoryName: cfg.ecrRepo,
          lifecyclePolicyText: JSON.stringify({
            rules: [
              {
                rulePriority: 1,
                description: `Keep last ${retainImages} images`,
                selection: {
                  tagStatus: "any",
                  countType: "imageCountMoreThan",
                  countNumber: retainImages,
                },
                action: { type: "expire" },
              },
            ],
          }),
        })
      );
    } catch (err) {
      console.warn(`ECR lifecycle policy not applied: ${(err as Error).message}`);
    }
  }

  const accountId = await getAccountId(cfg);

  // Prepare Docker build context
  const contextDir = path.join(process.cwd(), ".transflow-build");
  if (fs.existsSync(contextDir)) {
    fs.rmSync(contextDir, { recursive: true, force: true });
  }
  fs.mkdirSync(contextDir, { recursive: true });

  await bakeTemplates({
    templatesDir: path.resolve(process.cwd(), cfg.templatesDir),
    outDir: contextDir,
  });

  const imgUri = imageUri(accountId, region, cfg.ecrRepo, tag, endpoint);

  if (!isLocal) {
    // Real ECR: docker login + buildx + push
    const tokenResp = await ecr.send(new GetAuthorizationTokenCommand({}));
    const auth = tokenResp.authorizationData?.[0];
    if (!auth?.authorizationToken || !auth.proxyEndpoint) {
      throw new Error("Failed to retrieve ECR authorization token");
    }
    const decoded = Buffer.from(auth.authorizationToken, "base64").toString();
    const password = decoded.split(":")[1];
    await execa(
      "docker",
      [
        "login",
        "--username",
        "AWS",
        "--password-stdin",
        auth.proxyEndpoint,
      ],
      { input: password }
    );

    const platformArg =
      cfg.lambda.architecture === "arm64" ? "linux/arm64" : "linux/amd64";
    await execa(
      "docker",
      [
        "buildx",
        "build",
        "--platform",
        platformArg,
        ...(args.forceRebuild ? ["--no-cache"] : []),
        "--provenance=false",
        "-t",
        imgUri,
        "--load",
        contextDir,
      ],
      { stdio: "inherit" }
    );
    await execa("docker", ["push", imgUri], { stdio: "inherit" });
  } else {
    console.log(
      `🐳 Skipping docker build/push in LocalStack mode (endpoint=${endpoint})`
    );
  }

  // ───── SQS ─────
  const fifo = isFifoQueue(cfg);
  const queueName = resolveQueueName(cfg);
  const dlqName = resolveDlqName(cfg);
  let queueUrl: string | undefined;
  let dlqUrl: string | undefined;

  try {
    const dlqResult = await sqs.send(
      new CreateQueueCommand({
        QueueName: dlqName,
        Attributes: {
          ...(fifo
            ? { FifoQueue: "true", ContentBasedDeduplication: "true" }
            : {}),
          MessageRetentionPeriod: "1209600",
        },
      })
    );
    dlqUrl = dlqResult.QueueUrl;
  } catch (error: any) {
    if (error.name !== "QueueAlreadyExists") throw error;
    dlqUrl = `https://sqs.${region}.amazonaws.com/${accountId}/${dlqName}`;
  }

  try {
    const queueResult = await sqs.send(
      new CreateQueueCommand({
        QueueName: queueName,
        Attributes: {
          ...(fifo
            ? { FifoQueue: "true", ContentBasedDeduplication: "true" }
            : {}),
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
    queueUrl = `https://sqs.${region}.amazonaws.com/${accountId}/${queueName}`;
  }

  // ───── IAM role ─────
  const providedRoleArn =
    process.env.TRANSFLOW_LAMBDA_ROLE_ARN || cfg.lambda.roleArn || "";
  let roleName: string;
  let executionRoleArn: string;
  if (providedRoleArn) {
    roleName = providedRoleArn.split("/").pop() as string;
    executionRoleArn = providedRoleArn;
  } else {
    roleName = `${cfg.project}-transflow-lambda-role`;
    executionRoleArn = `arn:aws:iam::${accountId}:role/${roleName}`;
  }

  try {
    await iam.send(new GetRoleCommand({ RoleName: roleName }));
  } catch {
    await iam.send(
      new CreateRoleCommand({
        RoleName: roleName,
        AssumeRolePolicyDocument: JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Principal: { Service: "lambda.amazonaws.com" },
              Action: "sts:AssumeRole",
            },
          ],
        }),
        Description: `Transflow execution role for project ${cfg.project}`,
        Tags: [
          { Key: "Project", Value: cfg.project },
          { Key: "Component", Value: "transflow" },
        ],
      })
    );
  }

  await iam.send(
    new AttachRolePolicyCommand({
      RoleName: roleName,
      PolicyArn:
        "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
    })
  );

  const queueArn = `arn:aws:sqs:${region}:${accountId}:${queueName}`;
  const allBuckets = [
    computeTmpBucketName(cfg.project, cfg.region),
    ...(cfg.s3.exportBuckets || []),
  ];
  const s3ResourceArns = allBuckets.flatMap((b) => [
    `arn:aws:s3:::${b}`,
    `arn:aws:s3:::${b}/*`,
  ]);
  const ddbTableArn = `arn:aws:dynamodb:${region}:${accountId}:table/${cfg.dynamoDb.tableName}`;
  const inlinePolicy = {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "SqsAccess",
        Effect: "Allow",
        Action: [
          "sqs:ReceiveMessage",
          "sqs:DeleteMessage",
          "sqs:GetQueueAttributes",
          "sqs:ChangeMessageVisibility",
          "sqs:SendMessage",
        ],
        Resource: queueArn,
      },
      {
        Sid: "S3Access",
        Effect: "Allow",
        Action: [
          "s3:GetObject",
          "s3:PutObject",
          "s3:DeleteObject",
          "s3:ListBucket",
        ],
        Resource: s3ResourceArns,
      },
      {
        Sid: "DynamoDbStatus",
        Effect: "Allow",
        Action: [
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:GetItem",
          "dynamodb:DescribeTable",
        ],
        Resource: ddbTableArn,
      },
      {
        Sid: "LogsCreate",
        Effect: "Allow",
        Action: [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
        ],
        Resource: "*",
      },
    ],
  };
  await iam.send(
    new PutRolePolicyCommand({
      RoleName: roleName,
      PolicyName: "transflow-inline",
      PolicyDocument: JSON.stringify(inlinePolicy),
    })
  );

  // ───── Lambda ─────
  const functionName = `${cfg.lambdaPrefix}${branch}`;
  const imageConfig = { ImageUri: imgUri };
  let exists = true;
  try {
    await lambda.send(new GetFunctionCommand({ FunctionName: functionName }));
  } catch {
    exists = false;
  }

  const ttlDays = cfg.dynamoDb.ttlDays ?? 30;
  const buildEnvVars = (): Record<string, string> => {
    const envVars: Record<string, string> = {
      TRANSFLOW_BRANCH: branch,
      MAX_BATCH_SIZE: cfg.lambda.maxBatchSize?.toString() || "10",
      DYNAMODB_TABLE: cfg.dynamoDb.tableName,
      TRANSFLOW_PROJECT: cfg.project,
      TRANSFLOW_TMP_BUCKET: tmpBucket,
      TRANSFLOW_ALLOWED_BUCKETS: JSON.stringify(cfg.s3.exportBuckets || []),
      TRANSFLOW_TTL_DAYS: String(ttlDays),
    };
    if (queueUrl) envVars["SQS_QUEUE_URL"] = queueUrl;
    if (endpoint) envVars["TRANSFLOW_AWS_ENDPOINT"] = endpoint;
    return envVars;
  };

  if (!exists) {
    await lambda.send(
      new CreateFunctionCommand({
        FunctionName: functionName,
        PackageType: "Image",
        Code: imageConfig,
        Role: executionRoleArn,
        MemorySize: cfg.lambda.memoryMb,
        Timeout: cfg.lambda.timeoutSec,
        Architectures: cfg.lambda.architecture
          ? [cfg.lambda.architecture]
          : undefined,
        Environment: { Variables: buildEnvVars() },
      })
    );
    await waitForLambdaUpdate(functionName);
  } else {
    await lambda.send(
      new UpdateFunctionCodeCommand({
        FunctionName: functionName,
        ImageUri: imgUri,
      })
    );
    await waitForLambdaUpdate(functionName);
    await lambda.send(
      new UpdateFunctionConfigurationCommand({
        FunctionName: functionName,
        Role: executionRoleArn,
        MemorySize: cfg.lambda.memoryMb,
        Timeout: cfg.lambda.timeoutSec,
        Environment: { Variables: buildEnvVars() },
      })
    );
    await waitForLambdaUpdate(functionName);
  }

  // Reserved concurrency: default to 10 to cap unbounded Lambda burn
  const reservedConcurrency = cfg.lambda.reservedConcurrency ?? 10;
  if (!isLocal) {
    try {
      await lambda.send(
        new PutFunctionConcurrencyCommand({
          FunctionName: functionName,
          ReservedConcurrentExecutions: reservedConcurrency,
        })
      );
    } catch (error) {
      console.warn(`Failed to set reserved concurrency: ${error}`);
    }
  }

  // SQS event source mapping
  if (queueUrl) {
    const existingMappings = await lambda.send(
      new ListEventSourceMappingsCommand({
        FunctionName: functionName,
        EventSourceArn: queueArn,
      })
    );

    if ((existingMappings.EventSourceMappings?.length ?? 0) === 0) {
      const maxAttempts = isLocal ? 1 : 6;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          await lambda.send(
            new CreateEventSourceMappingCommand({
              FunctionName: functionName,
              EventSourceArn: queueArn,
              BatchSize: cfg.sqs.batchSize || 10,
            })
          );
          break;
        } catch (err: any) {
          const msg = String(err?.message || err);
          const isPerm =
            msg.includes("ReceiveMessage") ||
            err?.name === "InvalidParameterValueException";
          if (attempt < maxAttempts && isPerm) {
            const waitMs = 5000 * attempt;
            console.warn(
              `Waiting for IAM policy propagation before creating SQS mapping (attempt ${attempt}/${maxAttempts})...`
            );
            await sleep(waitMs);
            continue;
          }
          throw err;
        }
      }
    }
  }

  // ───── DynamoDB table ─────
  try {
    await ddb.send(
      new DescribeTableCommand({ TableName: cfg.dynamoDb.tableName })
    );
  } catch (err: any) {
    if (err?.name !== "ResourceNotFoundException") throw err;
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
  }

  // Enable TTL on the table (idempotent)
  if (ttlDays > 0) {
    try {
      const ttlState = await ddb.send(
        new DescribeTimeToLiveCommand({ TableName: cfg.dynamoDb.tableName })
      );
      const status = ttlState.TimeToLiveDescription?.TimeToLiveStatus;
      if (status !== "ENABLED" && status !== "ENABLING") {
        await ddb.send(
          new UpdateTimeToLiveCommand({
            TableName: cfg.dynamoDb.tableName,
            TimeToLiveSpecification: {
              Enabled: true,
              AttributeName: "ttl",
            },
          })
        );
      }
    } catch (err) {
      console.warn(`Failed to enable DynamoDB TTL: ${(err as Error).message}`);
    }
  }

  // ───── S3 buckets ─────
  const bucketsToEnsure = [tmpBucket, ...(cfg.s3.exportBuckets || [])];
  for (const bucket of bucketsToEnsure) {
    try {
      await s3.send(new HeadBucketCommand({ Bucket: bucket }));
    } catch {
      const params: any = { Bucket: bucket };
      if (region !== "us-east-1")
        params.CreateBucketConfiguration = { LocationConstraint: region };
      await s3.send(new CreateBucketCommand(params));
    }
  }

  // CORS on tmp bucket
  const corsAllowedOrigins = cfg.s3.corsAllowedOrigins ?? ["*"];
  try {
    await s3.send(
      new PutBucketCorsCommand({
        Bucket: tmpBucket,
        CORSConfiguration: {
          CORSRules: [
            {
              AllowedMethods: ["PUT", "POST", "GET", "HEAD"],
              AllowedOrigins: corsAllowedOrigins,
              AllowedHeaders: ["*"],
              ExposeHeaders: ["ETag"],
              MaxAgeSeconds: 3000,
            },
          ],
        },
      })
    );
  } catch (err) {
    console.warn(`Failed to set CORS on tmp bucket ${tmpBucket}: ${err}`);
  }

  // Lifecycle: expire tmp uploads/ after configured days (default 7)
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
    } catch (err) {
      console.warn(
        `Failed to apply lifecycle on tmp bucket: ${(err as Error).message}`
      );
    }
  }

  // S3 → Lambda notification (still on tmp bucket)
  for (const bucket of [tmpBucket]) {
    const prefix = `uploads/`;
    const targetFunctionName = functionName;
    const functionArn = `arn:aws:lambda:${region}:${accountId}:function:${targetFunctionName}`;

    try {
      await lambda.send(
        new AddPermissionCommand({
          FunctionName: targetFunctionName,
          Action: "lambda:InvokeFunction",
          Principal: "s3.amazonaws.com",
          StatementId: `s3-invoke-${branch}-${bucket}`,
          SourceArn: `arn:aws:s3:::${bucket}`,
        })
      );
    } catch {}

    const notif: NotificationConfiguration = {
      LambdaFunctionConfigurations: [
        {
          Events: ["s3:ObjectCreated:*"],
          LambdaFunctionArn: functionArn,
          Filter: { Key: { FilterRules: [{ Name: "prefix", Value: prefix }] } },
        },
      ],
    };
    await s3.send(
      new PutBucketNotificationConfigurationCommand({
        Bucket: bucket,
        NotificationConfiguration: notif,
      })
    );
  }

  // ───── Status Lambda ─────
  const statusFunctionName = `${cfg.project}-status`;
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
    ...(endpoint ? { TRANSFLOW_AWS_ENDPOINT: endpoint } : {}),
  };

  if (!statusExists) {
    await lambda.send(
      new CreateFunctionCommand({
        FunctionName: statusFunctionName,
        PackageType: "Image",
        Code: imageConfig,
        Role: executionRoleArn,
        MemorySize: 512,
        Timeout: 30,
        Architectures: cfg.lambda.architecture
          ? [cfg.lambda.architecture]
          : undefined,
        Environment: { Variables: statusEnvVars },
        Description: `Transflow status checker for ${cfg.project}`,
        Tags: { Project: cfg.project, Component: "status-lambda" },
      })
    );
    await waitForLambdaUpdate(statusFunctionName);
    console.log(`✅ Created status Lambda: ${statusFunctionName}`);
  } else {
    await lambda.send(
      new UpdateFunctionCodeCommand({
        FunctionName: statusFunctionName,
        ImageUri: imgUri,
      })
    );
    await waitForLambdaUpdate(statusFunctionName);
    await lambda.send(
      new UpdateFunctionConfigurationCommand({
        FunctionName: statusFunctionName,
        Role: executionRoleArn,
        MemorySize: 512,
        Timeout: 30,
        Environment: { Variables: statusEnvVars },
      })
    );
    await waitForLambdaUpdate(statusFunctionName);
    console.log(`✅ Updated status Lambda: ${statusFunctionName}`);
  }

  return {
    imageUri: imgUri,
    functionName,
    statusFunctionName,
  };
}

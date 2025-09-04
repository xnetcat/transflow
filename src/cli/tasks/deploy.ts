import path from "path";
import { execa } from "execa";
import {
  LambdaClient,
  CreateFunctionCommand,
  UpdateFunctionCodeCommand,
  UpdateFunctionConfigurationCommand,
  GetFunctionCommand,
  AddPermissionCommand,
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

  // Create or update Lambda
  const functionName = `${cfg.lambdaPrefix}${branch}`;
  const imageConfig = { ImageUri: imgUri };
  let exists = true;
  try {
    await lambda.send(new GetFunctionCommand({ FunctionName: functionName }));
  } catch {
    exists = false;
  }

  // Use shared Redis configuration across all branches
  const redisUrl = cfg.redis.url ?? "";
  const redisRestUrl = cfg.redis.restUrl ?? "";
  const redisToken = cfg.redis.token ?? "";

  if (!exists) {
    const branchBucket = `${cfg.project}-${branch}`;
    const envVars: Record<string, string> = {
      TRANSFLOW_BRANCH: branch,
      AWS_REGION: region,
      // Shared Redis instance for all branches
      REDIS_URL: redisUrl,
      REDIS_REST_URL: redisRestUrl,
      REDIS_REST_TOKEN: redisToken,
    };
    if (cfg.s3.mode === "prefix") {
      if (cfg.s3.uploadBucket) envVars["UPLOAD_BUCKET"] = cfg.s3.uploadBucket;
      if (cfg.s3.outputBucket) envVars["OUTPUT_BUCKET"] = cfg.s3.outputBucket;
    } else {
      envVars["UPLOAD_BUCKET"] = branchBucket;
      envVars["OUTPUT_BUCKET"] = branchBucket;
    }
    if (cfg.dynamoDb?.enabled && cfg.dynamoDb.tableName)
      envVars["DYNAMODB_TABLE"] = cfg.dynamoDb.tableName;
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
      // Shared Redis instance for all branches
      REDIS_URL: redisUrl,
      REDIS_REST_URL: redisRestUrl,
      REDIS_REST_TOKEN: redisToken,
    };
    if (cfg.s3.mode === "prefix") {
      if (cfg.s3.uploadBucket) envVars["UPLOAD_BUCKET"] = cfg.s3.uploadBucket;
      if (cfg.s3.outputBucket) envVars["OUTPUT_BUCKET"] = cfg.s3.outputBucket;
    } else {
      envVars["UPLOAD_BUCKET"] = branchBucket;
      envVars["OUTPUT_BUCKET"] = branchBucket;
    }
    if (cfg.dynamoDb?.enabled && cfg.dynamoDb.tableName)
      envVars["DYNAMODB_TABLE"] = cfg.dynamoDb.tableName;
    await lambda.send(
      new UpdateFunctionConfigurationCommand({
        FunctionName: functionName,
        MemorySize: cfg.lambda.memoryMb,
        Timeout: cfg.lambda.timeoutSec,
        Environment: { Variables: envVars },
      })
    );
  }

  // S3 setup
  if (cfg.s3.mode === "bucket") {
    const bucket = `${cfg.project}-${branch}`;
    try {
      await s3.send(new HeadBucketCommand({ Bucket: bucket }));
    } catch {
      const params: any = { Bucket: bucket };
      if (region !== "us-east-1") {
        params.CreateBucketConfiguration = { LocationConstraint: region };
      }
      await s3.send(new CreateBucketCommand(params));
    }
  }
  if (cfg.s3.mode === "prefix") {
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
  // Add PutBucketNotificationConfiguration scoped to branch prefix
  if (cfg.s3.mode === "prefix" && cfg.s3.uploadBucket) {
    const bucket = cfg.s3.uploadBucket;
    const prefix = `uploads/${branch}/`;
    const current = await s3.send(
      new GetBucketNotificationConfigurationCommand({ Bucket: bucket })
    );
    const lambdaConfigs: LambdaFunctionConfiguration[] =
      current.LambdaFunctionConfigurations ?? [];
    const functionArn = `arn:aws:lambda:${region}:${accountId}:function:${functionName}`;
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
            FunctionName: functionName,
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
    const bucket = `${cfg.project}-${branch}`;
    const prefix = `uploads/`;
    const current = await s3.send(
      new GetBucketNotificationConfigurationCommand({ Bucket: bucket })
    );
    const lambdaConfigs: LambdaFunctionConfiguration[] =
      current.LambdaFunctionConfigurations ?? [];
    const functionArn = `arn:aws:lambda:${region}:${accountId}:function:${functionName}`;
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
            FunctionName: functionName,
            Action: "lambda:InvokeFunction",
            Principal: "s3.amazonaws.com",
            StatementId: `s3-invoke-${branch}`,
            SourceArn: `arn:aws:s3:::${bucket}`,
          })
        );
      } catch {}
    }
  }

  return { imageUri: imgUri, functionName };
}

/*
  Centralized AWS SDK client factory.

  Why: each handler/CLI task previously instantiated clients with only `region`,
  which made LocalStack (or any custom endpoint) impossible. This module reads
  endpoint/credentials from TransflowConfig and TRANSFLOW_AWS_* env vars and
  produces correctly configured clients.
*/
import {
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { SQSClient } from "@aws-sdk/client-sqs";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { LambdaClient } from "@aws-sdk/client-lambda";
import { ECRClient } from "@aws-sdk/client-ecr";
import { IAMClient } from "@aws-sdk/client-iam";
import type { TransflowConfig, TransflowAwsCredentials } from "./types";

export interface AwsClientOptions {
  region?: string;
  endpoint?: string;
  credentials?: TransflowAwsCredentials;
  forcePathStyle?: boolean;
}

/**
 * Resolve the effective endpoint for AWS calls. Precedence:
 * 1. explicit cfg.endpoint
 * 2. TRANSFLOW_AWS_ENDPOINT env var
 */
export function resolveEndpoint(cfg?: Pick<TransflowConfig, "endpoint">): string | undefined {
  return cfg?.endpoint || process.env.TRANSFLOW_AWS_ENDPOINT || undefined;
}

/**
 * Resolve credentials. Precedence:
 * 1. explicit cfg.credentials
 * 2. TRANSFLOW_AWS_ACCESS_KEY_ID + TRANSFLOW_AWS_SECRET_ACCESS_KEY env vars
 * 3. undefined → SDK default chain (env, profile, IAM role, etc.)
 */
export function resolveCredentials(
  cfg?: Pick<TransflowConfig, "credentials">
): TransflowAwsCredentials | undefined {
  if (cfg?.credentials) return cfg.credentials;
  const id = process.env.TRANSFLOW_AWS_ACCESS_KEY_ID;
  const secret = process.env.TRANSFLOW_AWS_SECRET_ACCESS_KEY;
  if (id && secret) {
    return {
      accessKeyId: id,
      secretAccessKey: secret,
      sessionToken: process.env.TRANSFLOW_AWS_SESSION_TOKEN,
    };
  }
  return undefined;
}

/**
 * Resolve region. Precedence: explicit → cfg.region → AWS_REGION → AWS_DEFAULT_REGION → us-east-1.
 */
export function resolveRegion(
  cfgOrRegion?: Pick<TransflowConfig, "region"> | string
): string {
  if (typeof cfgOrRegion === "string") return cfgOrRegion;
  if (cfgOrRegion?.region) return cfgOrRegion.region;
  return (
    process.env.AWS_REGION ||
    process.env.AWS_DEFAULT_REGION ||
    "us-east-1"
  );
}

function commonClientConfig(
  cfg?: Partial<TransflowConfig>,
  override?: AwsClientOptions
) {
  const region = override?.region || resolveRegion(cfg as any);
  const endpoint = override?.endpoint ?? resolveEndpoint(cfg as any);
  const credentials = override?.credentials ?? resolveCredentials(cfg as any);
  return {
    region,
    ...(endpoint ? { endpoint } : {}),
    ...(credentials ? { credentials } : {}),
  };
}

/**
 * Build an S3 client. Forces path-style addressing when an endpoint is
 * configured (LocalStack / MinIO need it) or when explicitly requested.
 *
 * Also opts out of the SDK's default flow-integrity checksum
 * (x-amz-checksum-crc32). The browser uploads we presign cannot compute that
 * header, and older LocalStack/MinIO releases reject it.
 */
export function makeS3Client(
  cfg?: Partial<TransflowConfig>,
  override?: AwsClientOptions
): S3Client {
  const base = commonClientConfig(cfg, override);
  const forcePathStyle =
    override?.forcePathStyle ??
    (cfg as TransflowConfig | undefined)?.s3?.forcePathStyle ??
    !!base.endpoint;
  const config: S3ClientConfig = {
    ...base,
    forcePathStyle,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  };
  return new S3Client(config);
}

export function makeSqsClient(
  cfg?: Partial<TransflowConfig>,
  override?: AwsClientOptions
): SQSClient {
  return new SQSClient(commonClientConfig(cfg, override));
}

export function makeDynamoClient(
  cfg?: Partial<TransflowConfig>,
  override?: AwsClientOptions
): DynamoDBClient {
  return new DynamoDBClient(commonClientConfig(cfg, override));
}

export function makeDynamoDocClient(
  cfg?: Partial<TransflowConfig>,
  override?: AwsClientOptions
): DynamoDBDocumentClient {
  return DynamoDBDocumentClient.from(makeDynamoClient(cfg, override));
}

export function makeLambdaClient(
  cfg?: Partial<TransflowConfig>,
  override?: AwsClientOptions
): LambdaClient {
  return new LambdaClient(commonClientConfig(cfg, override));
}

export function makeEcrClient(
  cfg?: Partial<TransflowConfig>,
  override?: AwsClientOptions
): ECRClient {
  return new ECRClient(commonClientConfig(cfg, override));
}

export function makeIamClient(
  cfg?: Partial<TransflowConfig>,
  override?: AwsClientOptions
): IAMClient {
  return new IAMClient(commonClientConfig(cfg, override));
}

/**
 * For non-AWS endpoints we can't query STS for the account id; fall back to a
 * stable placeholder used by LocalStack.
 */
export const LOCALSTACK_ACCOUNT_ID = "000000000000";

/**
 * Build the public download URL for an S3 object. Honors custom endpoints
 * (LocalStack/MinIO) so generated `ssl_url` values are reachable in dev.
 */
export function buildS3PublicUrl(
  bucket: string,
  key: string,
  region: string,
  endpoint?: string
): string {
  if (endpoint) {
    const trimmed = endpoint.replace(/\/+$/, "");
    return `${trimmed}/${bucket}/${encodeURI(key)}`;
  }
  return `https://${bucket}.s3.${region}.amazonaws.com/${encodeURI(key)}`;
}

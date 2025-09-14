module.exports = {
  project: "example",
  region: "us-east-1",

  // S3 buckets (created if missing, never deleted)
  s3: {
    buckets: ["example-uploads", "example-outputs"],
    mode: "prefix",
    uploadBucket: "example-uploads",
    outputBucket: "example-outputs",
    userIsolation: true,
  },

  // Container registry
  ecrRepo: "transflow-worker",
  lambdaPrefix: "transflow-worker-",
  templatesDir: "./templates",
  lambdaBuildContext: "./lambda",

  // DynamoDB (required for status tracking)
  dynamoDb: {
    tableName: "TransflowJobs",
  },

  // SQS (required for processing)
  sqs: {
    queueName: "example-processing.fifo",
    visibilityTimeoutSec: 960,
    maxReceiveCount: 3,
    batchSize: 10,
  },

  // Optional: Status Lambda for direct API calls
  statusLambda: {
    enabled: true,
    functionName: "example-status",
    memoryMb: 512,
    timeoutSec: 30,
  },

  // Authentication (optional for demo)
  auth: {
    requireAuth: false, // Set to true in production
    jwtSecret: process.env.JWT_SECRET,
    userIdClaim: "sub",
  },

  lambda: {
    memoryMb: 1024,
    timeoutSec: 300,
    roleArn:
      process.env.TRANSFLOW_LAMBDA_ROLE_ARN ||
      "arn:aws:iam::<ACCOUNT_ID>:role/transflow-lambda-role",
  },
};

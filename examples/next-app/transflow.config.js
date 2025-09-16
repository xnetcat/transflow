module.exports = {
  project: "example",
  region: "eu-north-1",

  // S3 export buckets (created if missing). Tmp bucket is automatic.
  s3: {
    exportBuckets: ["example-outputs"],
  },

  // Container registry
  ecrRepo: "transflow-worker",
  lambdaPrefix: "transflow-worker-",
  templatesDir: "./templates",

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

  // Status Lambda is automatically deployed as: example-status
  lambda: {
    memoryMb: 1024,
    timeoutSec: 300,
    roleArn:
      process.env.TRANSFLOW_LAMBDA_ROLE_ARN ||
      "arn:aws:iam::<YOUR_ACCOUNT_ID>:role/transflow-lambda-role",
  },
};

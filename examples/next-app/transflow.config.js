// Setting TRANSFLOW_AWS_ENDPOINT (e.g. http://localhost:4566) flips the whole
// stack into LocalStack mode. No AWS account, no docker push to ECR, no IAM
// policy propagation waits — just buckets/queues/tables created in-process.
const isLocal = !!process.env.TRANSFLOW_AWS_ENDPOINT;

module.exports = {
  project: "example",
  region: "eu-north-1",

  ...(isLocal
    ? {
        endpoint: process.env.TRANSFLOW_AWS_ENDPOINT,
        credentials: { accessKeyId: "test", secretAccessKey: "test" },
      }
    : {}),

  s3: {
    exportBuckets: ["example-outputs"],
    // Standard SQS lets S3 deliver events directly to the queue (cheaper),
    // FIFO requires a Lambda bridge invocation. LocalStack works with either.
    corsAllowedOrigins: ["http://localhost:3000"],
    tmpRetentionDays: 7,
  },

  ecrRepo: "transflow-worker",
  lambdaPrefix: "transflow-worker-",
  templatesDir: "./templates",
  ecr: { retainImages: 5 },

  dynamoDb: {
    tableName: "TransflowJobs",
    ttlDays: 30,
  },

  sqs: {
    // Use standard SQS (fifo: false) so LocalStack can route S3 events
    // straight to the queue without a Lambda bridge.
    fifo: !isLocal,
    queueName: isLocal ? "example-processing" : "example-processing.fifo",
    visibilityTimeoutSec: 960,
    maxReceiveCount: 3,
    batchSize: 10,
  },

  lambda: {
    memoryMb: 1024,
    timeoutSec: 300,
    reservedConcurrency: 10,
    ...(isLocal
      ? {}
      : {
          roleArn:
            process.env.TRANSFLOW_LAMBDA_ROLE_ARN ||
            "arn:aws:iam::<YOUR_ACCOUNT_ID>:role/transflow-lambda-role",
        }),
  },
};

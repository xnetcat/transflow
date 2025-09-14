# SQS-Based Architecture

Transflow now uses Amazon SQS exclusively for messaging, removing the Redis dependency. This simplifies deployment and leverages AWS-native services for both concurrency management and real-time progress updates.

## Architecture Overview

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   S3 Upload     │───▶│  SQS Bridge     │───▶│ Processing      │
│   Events        │    │  Lambda         │    │ Queue (FIFO)    │
└─────────────────┘    └─────────────────┘    └─────────────────┘
                                                       │
                                                       ▼
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Progress      │◀───│  Processing     │    │     Dead        │
│   Queue (FIFO)  │    │  Lambda         │───▶│   Letter        │
└─────────────────┘    └─────────────────┘    │   Queue         │
         │                                    └─────────────────┘
         ▼
┌─────────────────┐
│  Stream Handler │
│   (SSE Client)  │
└─────────────────┘
```

## Queue Architecture

### 1. Processing Queue (`{project}-{branch}-processing.fifo`)

- **Purpose**: Job processing with concurrency control
- **Type**: FIFO queue for ordered processing
- **Batch Size**: Configurable (1-10 messages)
- **DLQ**: Dead letter queue for failed jobs
- **Retention**: 14 days

### 2. Progress Queue (`{project}-{branch}-progress.fifo`)

- **Purpose**: Real-time progress updates
- **Type**: FIFO queue for ordered updates
- **Retention**: 14 days (configurable)
- **Consumers**: Stream handlers for SSE clients
- **Message Format**: JSON with channel, uploadId, branch, timestamp

### 3. Dead Letter Queue (`{project}-{branch}-dlq.fifo`)

- **Purpose**: Failed processing jobs
- **Max Receive Count**: 3 (configurable)
- **Manual Processing**: For debugging and recovery

## Message Flow

### Upload Processing Flow

1. **File Upload**

   ```javascript
   // User uploads file via pre-signed URL
   S3.putObject(bucket, key, file);
   ```

2. **S3 Event Trigger**

   ```json
   {
     "Records": [
       {
         "s3": {
           "bucket": { "name": "uploads" },
           "object": { "key": "uploads/main/users/user123/upload-abc/file.mp3" }
         }
       }
     ]
   }
   ```

3. **SQS Bridge Processing**

   ```javascript
   // Bridge Lambda groups files and creates processing jobs
   const job = {
     uploadId: "upload-abc",
     templateId: "audio-processing",
     objects: [{ bucket: "uploads", key: "..." }],
     branch: "main",
     user: { userId: "user123" },
   };
   sqs.sendMessage(processingQueue, job);
   ```

4. **Processing Lambda Execution**
   ```javascript
   // Main Lambda processes files and publishes progress
   await publishProgress(sqs, uploadId, branch, {
     type: "start",
     key: objects[0].key,
   });
   ```

### Progress Updates Flow

1. **Progress Publishing**

   ```javascript
   // Lambda publishes to progress queue
   await sqs.send(
     new SendMessageCommand({
       QueueUrl: progressQueueUrl,
       MessageBody: JSON.stringify({
         channel: `upload:${branch}:${uploadId}`,
         type: "step:start",
         step: "transcoding",
         uploadId,
         branch,
         timestamp: new Date().toISOString(),
       }),
       MessageGroupId: uploadId,
       MessageDeduplicationId: crypto.randomUUID(),
     })
   );
   ```

2. **Stream Handler Consumption**

   ```javascript
   // Stream handler polls progress queue
   const messages = await sqs.send(
     new ReceiveMessageCommand({
       QueueUrl: progressQueueUrl,
       MaxNumberOfMessages: 10,
       WaitTimeSeconds: 10, // Long polling
       VisibilityTimeout: 30,
     })
   );

   // Forward to SSE clients
   for (const message of messages) {
     const data = JSON.parse(message.Body);
     if (data.channel === clientChannel) {
       res.write(`data: ${JSON.stringify(data)}\\n\\n`);
     }
   }
   ```

## Configuration

### Required SQS Configuration

```json
{
  "sqs": {
    "queueName": "myapp-processing.fifo",
    "progressQueueName": "myapp-progress.fifo",
    "visibilityTimeoutSec": 960,
    "maxReceiveCount": 3,
    "batchSize": 10
  }
}
```

### Environment Variables

```bash
# Lambda environment
SQS_QUEUE_URL="https://sqs.region.amazonaws.com/account/processing.fifo"
SQS_PROGRESS_QUEUE_URL="https://sqs.region.amazonaws.com/account/progress.fifo"
MAX_BATCH_SIZE="10"
AWS_REGION="us-east-1"
```

## Benefits of SQS-Only Architecture

### 1. **Simplified Infrastructure**

- No Redis cluster management
- Single AWS service for messaging
- Native AWS monitoring and scaling

### 2. **Cost Optimization**

- Pay-per-use pricing model
- No idle Redis instances
- Integrated with AWS Free Tier

### 3. **High Availability**

- AWS-managed service reliability
- Built-in redundancy across AZs
- Automatic scaling and failover

### 4. **Security & Compliance**

- IAM-based access control
- VPC endpoint support
- Encryption at rest and in transit
- AWS CloudTrail audit logging

### 5. **Operational Simplicity**

- No Redis connection management
- Built-in dead letter queues
- AWS CloudWatch integration
- Standard AWS deployment patterns

## Deployment Considerations

### 1. **Queue Creation**

The deploy script automatically creates:

- Processing queue (FIFO)
- Progress queue (FIFO)
- Dead letter queue (FIFO)

### 2. **Lambda Configuration**

- Event source mapping from processing queue
- Batch size and timeout settings
- Reserved concurrency limits
- Progress queue URL environment variable

### 3. **IAM Permissions**

```json
{
  "Effect": "Allow",
  "Action": [
    "sqs:ReceiveMessage",
    "sqs:DeleteMessage",
    "sqs:SendMessage",
    "sqs:GetQueueAttributes"
  ],
  "Resource": ["arn:aws:sqs:*:*:*-processing*", "arn:aws:sqs:*:*:*-progress*"]
}
```

## Migration from Redis

### Breaking Changes

1. **Configuration**: Remove `redis` config, `sqs` is now required
2. **Environment**: Remove `REDIS_URL`, add SQS queue URLs
3. **Dependencies**: No more `ioredis` or Redis cluster

### Migration Steps

1. Update `transflow.config.json` to include required `sqs` configuration
2. Remove Redis environment variables
3. Deploy with new SQS-based configuration
4. Verify progress updates work via SSE streams

### Backward Compatibility

- File upload API remains unchanged
- Progress streaming API unchanged (SSE)
- Template definitions unchanged
- S3 bucket structure unchanged

## Monitoring & Troubleshooting

### CloudWatch Metrics

- Queue depth and age of oldest message
- Processing Lambda errors and duration
- Dead letter queue message count
- Stream handler connection count

### Common Issues

1. **Missing Progress Updates**

   - Check `SQS_PROGRESS_QUEUE_URL` environment variable
   - Verify IAM permissions for progress queue
   - Monitor CloudWatch for Lambda errors

2. **Processing Delays**

   - Check processing queue depth
   - Verify Lambda reserved concurrency settings
   - Review batch size configuration

3. **Dead Letter Queue Messages**
   - Investigate processing errors in CloudWatch
   - Check template errors and resource limits
   - Manually reprocess or analyze failed jobs

This SQS-based architecture provides a robust, scalable, and cost-effective solution for Transflow's messaging needs while maintaining all existing functionality and security features.


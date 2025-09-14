# Lambda Concurrency Management

This document explains how Transflow handles AWS Lambda concurrency limits when processing large batches of files (10,000+ files).

## The Problem

When uploading thousands of files simultaneously to S3, each file upload triggers a Lambda function invocation. This can quickly hit AWS Lambda's default account concurrency limit of 1,000 executions and cause throttling.

## Solution: SQS-Based Processing Queue

Transflow implements a two-tier Lambda architecture to handle concurrency gracefully:

1. **SQS Bridge Lambda**: Lightweight function that receives S3 events and queues them for processing
2. **Processing Lambda**: Heavy-duty function that processes media files from the SQS queue

## Architecture

```
S3 Upload Event → SQS Bridge Lambda → SQS Queue → Processing Lambda (with concurrency limits)
```

### Benefits

- **Throttle Protection**: SQS queue acts as a buffer, preventing Lambda concurrency overruns
- **Cost Optimization**: Fewer cold starts by batching processing
- **Error Handling**: Built-in DLQ support for failed processing jobs
- **Batch Processing**: Process multiple files per Lambda invocation

## Configuration

### Enable SQS Processing

```json
{
  "sqs": {
    "enabled": true,
    "queueName": "my-app-processing.fifo",
    "visibilityTimeoutSec": 960,
    "maxReceiveCount": 3,
    "batchSize": 10
  }
}
```

### Set Lambda Concurrency Limits

```json
{
  "lambda": {
    "reservedConcurrency": 50,
    "maxBatchSize": 5
  }
}
```

## Configuration Options

### SQS Settings

- `enabled`: Enable SQS-based processing (default: false)
- `queueName`: Name of the SQS FIFO queue (auto-generated if not specified)
- `visibilityTimeoutSec`: How long messages are hidden after being received (960s = 16 minutes)
- `maxReceiveCount`: Number of retries before sending to DLQ (default: 3)
- `batchSize`: How many messages to process per Lambda invocation (1-10)

### Lambda Concurrency Settings

- `reservedConcurrency`: Maximum concurrent executions for this function (1-1000)
- `maxBatchSize`: Maximum files to process per invocation (default: 10)

## How It Works

### With SQS Enabled

1. **File Upload**: Files uploaded to S3 trigger S3 events
2. **Bridge Processing**: SQS Bridge Lambda groups files by `uploadId` and sends to SQS queue
3. **Queued Processing**: Processing Lambda receives batched jobs from SQS
4. **Controlled Execution**: Reserved concurrency ensures Lambda doesn't exceed limits
5. **Progress Updates**: Real-time progress still published via Redis

### Legacy Mode (SQS Disabled)

Direct S3 → Lambda triggering (original behavior)

## Deployment

When SQS is enabled, deployment automatically creates:

- Main processing Lambda function with SQS event source mapping
- SQS Bridge Lambda function for S3 event handling
- FIFO SQS queue with dead letter queue
- Updated S3 notifications to trigger bridge function

## Monitoring

### CloudWatch Metrics to Monitor

- `AWS/Lambda/ConcurrentExecutions`: Verify concurrency stays under limits
- `AWS/SQS/ApproximateNumberOfVisibleMessages`: Queue backlog
- `AWS/SQS/ApproximateAgeOfOldestMessage`: Processing latency

### Typical Concurrency Settings

| File Volume      | Reserved Concurrency | Max Batch Size | Expected Processing Time |
| ---------------- | -------------------- | -------------- | ------------------------ |
| < 100 files      | Not needed           | 10             | 1-2 minutes              |
| 100-1000 files   | 20-50                | 5-10           | 5-10 minutes             |
| 1000-10000 files | 50-100               | 3-5            | 15-30 minutes            |
| 10000+ files     | 100-200              | 1-3            | 30+ minutes              |

## Error Handling

### Dead Letter Queue

Failed processing jobs are automatically sent to a DLQ after `maxReceiveCount` retries.

### Recovery

Jobs in the DLQ can be:

1. Re-queued after fixing issues
2. Processed manually via CLI tools
3. Analyzed for debugging

## Migration from Direct S3 Processing

Existing deployments can enable SQS processing by:

1. Adding SQS configuration to `transflow.config.json`
2. Running `transflow deploy` - automatically handles migration
3. S3 notifications will be updated to use bridge function

## Best Practices

1. **Start Conservative**: Begin with lower concurrency limits and increase based on monitoring
2. **Monitor Queue Depth**: High queue depth indicates need for more concurrency
3. **Batch Size Tuning**: Larger batches = fewer invocations but higher memory usage
4. **Test at Scale**: Validate configuration with realistic file volumes
5. **Set Alarms**: CloudWatch alarms for queue depth and processing delays

## Troubleshooting

### High Queue Backlog

- Increase `reservedConcurrency`
- Decrease `maxBatchSize` to process faster
- Check for processing errors in logs

### Frequent DLQ Messages

- Increase Lambda timeout
- Increase SQS `visibilityTimeoutSec`
- Check template logic for errors

### Slow Processing

- Increase Lambda memory allocation
- Optimize template processing logic
- Consider smaller batch sizes for faster feedback


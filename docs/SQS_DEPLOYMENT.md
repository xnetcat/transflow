# SQS Resource Management

Transflow automatically creates and manages SQS queues and IAM policies for each branch deployment, ensuring proper isolation and cleanup.

## Automated Resource Creation

During `transflow deploy`, the following resources are automatically created for each branch:

### 1. SQS Queues (Shared)

**Processing Queue** (`{project}-processing.fifo`)

- **Purpose**: Main job processing queue with concurrency control
- **Type**: FIFO queue for ordered processing
- **Visibility Timeout**: Configurable (default 960 seconds)
- **Dead Letter Queue**: Configured with max receive count

**Progress Queue** (`{project}-progress.fifo`)

- **Purpose**: Real-time progress updates for UI
- **Type**: FIFO queue for ordered progress messages
- **Visibility Timeout**: 30 seconds (shorter for real-time updates)
- **Retention**: 14 days

**Dead Letter Queue** (`{project}-dlq.fifo`)

- **Purpose**: Failed processing jobs for debugging
- **Type**: FIFO queue
- **Max Receive Count**: Configurable (default 3)

### 2. IAM Policies (Shared)

**SQS Access Policy** (`{project}-sqs-policy`)

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "sqs:ReceiveMessage",
        "sqs:DeleteMessage",
        "sqs:GetQueueAttributes",
        "sqs:GetQueueUrl"
      ],
      "Resource": [
        "arn:aws:sqs:region:account:project-branch-processing.fifo",
        "arn:aws:sqs:region:account:project-branch-progress.fifo"
      ]
    },
    {
      "Effect": "Allow",
      "Action": [
        "sqs:SendMessage",
        "sqs:GetQueueAttributes",
        "sqs:GetQueueUrl"
      ],
      "Resource": [
        "arn:aws:sqs:region:account:project-branch-processing.fifo",
        "arn:aws:sqs:region:account:project-branch-progress.fifo",
        "arn:aws:sqs:region:account:project-branch-dlq.fifo"
      ]
    }
  ]
}
```

### 3. Event Source Mappings

- **Processing Queue → Main Lambda**: Triggers processing function
- **Batch Size**: Configurable (default 10)
- **Visibility Timeout**: Matches queue configuration

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

### Lambda Role Requirements

Your Lambda execution roles must be named following the pattern:

- Main Lambda: `{project}-lambda-role`
- SQS Bridge Lambda: `{project}-bridge-lambda-role`

These roles will automatically have the SQS policies attached during deployment.

## Deployment Process

### 1. Deploy Command

```bash
transflow deploy --branch main --tag latest
```

**Automatic Steps:**

1. Create Dead Letter Queue
2. Create Processing Queue with DLQ redrive policy
3. Create Progress Queue for real-time updates
4. Generate branch-specific IAM policy
5. Attach policy to Lambda execution roles
6. Create SQS event source mapping
7. Deploy Lambda functions with queue URLs

### 2. Environment Variables

The following environment variables are automatically set on Lambda functions:

```bash
SQS_QUEUE_URL="https://sqs.region.amazonaws.com/account/project-branch-processing.fifo"
SQS_PROGRESS_QUEUE_URL="https://sqs.region.amazonaws.com/account/project-branch-progress.fifo"
MAX_BATCH_SIZE="10"
```

## Branch Isolation

Each branch gets completely isolated SQS resources:

**Branch: main**

- `myapp-main-processing.fifo`
- `myapp-main-progress.fifo`
- `myapp-main-dlq.fifo`
- `myapp-main-sqs-policy`

**Branch: develop**

- `myapp-develop-processing.fifo`
- `myapp-develop-progress.fifo`
- `myapp-develop-dlq.fifo`
- `myapp-develop-sqs-policy`

This ensures:

- No cross-branch message pollution
- Independent scaling and monitoring
- Safe testing in feature branches
- Clean separation of environments

## Cleanup Process

### Automatic Cleanup

```bash
transflow cleanup --branch feature-xyz
```

**Automatic Steps:**

1. Delete SQS event source mappings
2. Detach IAM policies from roles
3. Delete branch-specific IAM policy
4. Delete all SQS queues (processing, progress, DLQ)
5. Delete Lambda functions

### Manual Cleanup

If automatic cleanup fails, you can manually remove resources:

```bash
# Delete SQS queues
aws sqs delete-queue --queue-url "https://sqs.region.amazonaws.com/account/project-branch-processing.fifo"
aws sqs delete-queue --queue-url "https://sqs.region.amazonaws.com/account/project-branch-progress.fifo"
aws sqs delete-queue --queue-url "https://sqs.region.amazonaws.com/account/project-branch-dlq.fifo"

# Delete IAM policy
aws iam detach-role-policy --role-name project-lambda-role --policy-arn "arn:aws:iam::account:policy/project-branch-sqs-policy"
aws iam delete-policy --policy-arn "arn:aws:iam::account:policy/project-branch-sqs-policy"
```

## Monitoring and Troubleshooting

### CloudWatch Metrics

Monitor SQS performance with these key metrics:

- **ApproximateNumberOfMessages**: Queue depth
- **ApproximateAgeOfOldestMessage**: Processing latency
- **NumberOfMessagesSent**: Throughput
- **NumberOfMessagesReceived**: Processing rate

### Common Issues

**1. Policy Attachment Failures**

```
⚠️ Warning: Failed to attach policy to project-lambda-role
```

- Verify Lambda execution role exists
- Check role naming convention matches expected pattern
- Ensure IAM permissions for policy operations

**2. Queue Creation Failures**

```
⚠️ Failed to create SQS queue: project-main-processing.fifo
```

- Check AWS account SQS limits
- Verify region configuration
- Ensure unique queue names

**3. Event Source Mapping Issues**

```
⚠️ Failed to create SQS event source mapping
```

- Verify Lambda function exists
- Check SQS queue ARN
- Ensure Lambda has SQS receive permissions

### Best Practices

1. **Branch Naming**: Use descriptive branch names that result in valid SQS queue names
2. **Cleanup**: Always run cleanup for feature branches after merging
3. **Monitoring**: Set up CloudWatch alarms for queue depth and age
4. **Testing**: Test deployment/cleanup cycle in non-production accounts first

## Security Considerations

### Least Privilege Access

IAM policies are scoped to:

- Specific branch resources only
- Minimum required SQS actions
- No cross-branch access

### Queue Encryption

Consider enabling SQS encryption for sensitive workloads:

```json
{
  "sqs": {
    "queueName": "myapp-processing.fifo",
    "encryption": {
      "kmsKeyId": "alias/aws/sqs"
    }
  }
}
```

### Network Security

For VPC deployments:

- Configure VPC endpoints for SQS
- Use security groups to restrict Lambda access
- Consider private subnets for enhanced security

This automated SQS management ensures consistent, secure, and isolated resources for each branch while minimizing operational overhead.

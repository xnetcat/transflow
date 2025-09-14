# Status Lambda

The Status Lambda is a dedicated, user-facing Lambda function for checking job status by assembly ID. This provides a fast, direct way to query job status without going through your application servers.

## Overview

```
Client → Status Lambda → DynamoDB → Response
    ↓
Optional Webhook Trigger
```

## Features

- **Direct Status Lookup**: Query job status by assembly_id
- **User Authorization**: Ensures users can only access their own jobs
- **Optional Webhook Triggering**: Manually trigger webhooks on demand
- **Fast Response**: Lightweight Lambda optimized for status queries
- **Shared Resource**: One Lambda serves all branches/users

## Configuration

Add to your `transflow.config.js`:

```javascript
module.exports = {
  // ... other config
  statusLambda: {
    enabled: true,
    functionName: "myapp-status", // Optional, defaults to {project}-status
    memoryMb: 512, // Optional, defaults to 512MB
    timeoutSec: 30, // Optional, defaults to 30s
    roleArn: "arn:aws:iam::...", // Optional, defaults to same as main lambda
  },
};
```

## API

### Input Event

```typescript
interface StatusLambdaEvent {
  assemblyId: string; // Required: Job ID to look up
  userId?: string; // Optional: For authorization
  triggerWebhook?: boolean; // Optional: Trigger webhook after lookup
}
```

### Response

```typescript
interface StatusLambdaResponse {
  statusCode: number;
  body: string; // JSON-encoded AssemblyStatus or error
  headers?: Record<string, string>;
}
```

Success response body contains the full `AssemblyStatus`:

```json
{
  "assembly_id": "abc123...",
  "ok": "ASSEMBLY_COMPLETED",
  "message": "Processing completed",
  "uploads": [...],
  "results": {...},
  "execution_duration": 5.2,
  "created_at": "2023-...",
  "updated_at": "2023-..."
}
```

## Usage Examples

### Direct Lambda Invocation

```typescript
import { StatusLambdaClient } from "@xnetcat/transflow";

const client = new StatusLambdaClient({
  region: "us-east-1",
  functionName: "myapp-status",
});

// Get status only
const result = await client.getStatus("assembly_123", "user_456");

// Get status and trigger webhook
const result = await client.getStatusWithWebhook("assembly_123", "user_456");

if (result.success) {
  console.log("Job status:", result.status);
} else {
  console.error("Error:", result.error);
}
```

### Next.js API Route

```typescript
// pages/api/status-lambda.ts
import { StatusLambdaClient } from "@xnetcat/transflow";

const client = new StatusLambdaClient({
  region: process.env.AWS_REGION!,
  functionName: `${process.env.PROJECT_NAME}-status`,
});

export default async function handler(req, res) {
  const { assemblyId } = req.query;
  const userId = extractUserFromAuth(req); // Your auth logic

  const result = await client.getStatus(assemblyId, userId);

  if (result.success) {
    res.json(result.status);
  } else {
    res.status(result.statusCode || 500).json({ error: result.error });
  }
}
```

### cURL Examples

```bash
# Invoke Lambda directly (requires AWS credentials)
aws lambda invoke \
  --function-name myapp-status \
  --payload '{"assemblyId":"abc123","userId":"user456"}' \
  response.json

# Through your API Gateway/Next.js
curl "https://myapp.com/api/status-lambda?assemblyId=abc123"

# With webhook trigger
curl "https://myapp.com/api/status-lambda?assemblyId=abc123&triggerWebhook=true"
```

## Status Codes

| Code | Meaning                                    |
| ---- | ------------------------------------------ |
| 200  | Success - returns AssemblyStatus           |
| 400  | Bad Request - missing/invalid assemblyId   |
| 403  | Forbidden - user doesn't own this assembly |
| 404  | Not Found - assembly doesn't exist         |
| 500  | Internal Error - DynamoDB/Lambda error     |

## Authorization

The Status Lambda enforces ownership by comparing:

- `event.userId` (from request)
- `assembly.user.userId` (from DynamoDB)

If they don't match, returns 403 Forbidden.

**Security Note**: In production, extract `userId` from validated JWT tokens, not query parameters.

## Webhook Triggering

When `triggerWebhook: true`:

1. Lambda looks up the assembly
2. Loads the template configuration
3. If `template.webhookUrl` is configured, sends POST request
4. Uses same retry logic as processing Lambda
5. Includes HMAC signature if `template.webhookSecret` is set

This is useful for:

- Manual webhook retries
- On-demand notifications
- Debugging webhook delivery

## Deployment

The Status Lambda is deployed automatically when:

```bash
npm run deploy -- --branch main --sha abc123
```

If `statusLambda.enabled: true` in config, the deploy script will:

1. Create/update the status Lambda function
2. Set DynamoDB permissions
3. Configure environment variables
4. Use the same Docker image as processing Lambda

## Environment Variables

The Status Lambda uses these environment variables:

- `DYNAMODB_TABLE`: Table name for status lookup
- `TRANSFLOW_PROJECT`: Project identifier
- `AWS_REGION`: AWS region
- `TEMPLATES_INDEX_PATH`: Path to templates (for webhook config)

## Performance

**Cold Start**: ~500ms first request  
**Warm**: ~10-50ms subsequent requests  
**Memory**: 512MB default (configurable)  
**Timeout**: 30s default (configurable)

For high-frequency status checks, consider:

- Provisioned concurrency
- Increased memory for faster execution
- CloudFront caching for completed jobs

## Monitoring

Monitor these CloudWatch metrics:

- `Duration`: Response time
- `Errors`: Failed invocations
- `Throttles`: Concurrency limits hit
- `Invocations`: Total requests

Set up alarms for error rates > 1% or duration > 5s.

## Costs

Estimated costs (us-east-1):

- **Requests**: $0.20 per 1M requests
- **Duration**: $0.0000166667 per GB-second
- **512MB/30ms avg**: ~$0.25 per 1M requests

Total: ~$0.45 per 1M status checks.

## Troubleshooting

### Common Issues

**403 Forbidden**

- Check userId extraction logic
- Verify assembly ownership in DynamoDB

**404 Not Found**

- Confirm assembly_id is correct
- Check DynamoDB table name configuration

**500 Internal Error**

- Check Lambda logs in CloudWatch
- Verify DynamoDB permissions
- Confirm table exists

### Debug Commands

```bash
# Check function exists
aws lambda get-function --function-name myapp-status

# View recent logs
aws logs filter-log-events \
  --log-group-name /aws/lambda/myapp-status \
  --start-time $(date -d '1 hour ago' +%s)000

# Test with sample event
aws lambda invoke \
  --function-name myapp-status \
  --payload file://test-event.json \
  --log-type Tail \
  response.json
```

## Migration from Web Handler

If migrating from the web-based status handler:

1. Enable Status Lambda in config
2. Deploy with `npm run deploy`
3. Update clients to use Lambda endpoints
4. Remove web handler routes
5. Monitor for any missed traffic

The Status Lambda provides better performance and isolation compared to web handlers.

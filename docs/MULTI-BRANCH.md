# Multi-Branch Support Guide

Transflow uses **shared resources with branch isolation** - enabling cost-effective, scalable multi-branch workflows while maintaining complete data separation.

## Architecture

Transflow automatically provides:

- **Single Redis instance** serves all branches
- **Single DynamoDB table** with branch-isolated composite keys
- **Branch-aware Redis channels** (`upload:{branch}:{uploadId}`)
- **Centralized monitoring** with branch filtering capabilities

## Configuration

All branches share the same Redis and DynamoDB resources with automatic isolation:

```js
module.exports = {
  // ... other config

  // Single Redis instance serves all branches automatically
  redis: {
    provider: "upstash",
    restUrl: process.env.REDIS_REST_URL,
    token: process.env.REDIS_TOKEN,
  },

  // Single DynamoDB table with automatic branch isolation
  dynamoDb: {
    enabled: true,
    tableName: "TransflowJobs", // Shared table for all branches
  },
};
```

## Redis Channel Structure

### Branch-Aware Channels

All Redis channels now include the branch name:

```
Format: upload:{branch}:{uploadId}

Examples:
- upload:main:abc123-def456
- upload:feature-auth:xyz789-abc123
- upload:staging:def456-ghi789
```

### Benefits

1. **No Collisions**: Same uploadId on different branches won't interfere
2. **Branch Filtering**: Listen to all uploads for a specific branch
3. **Cost Efficiency**: Single Redis instance vs multiple
4. **Monitoring**: Centralized real-time monitoring across all branches

## SSE Stream Endpoints

### Listen to Specific Upload

```js
// Listen to a specific upload on main branch
const eventSource = new EventSource("/api/stream?channel=upload:main:abc123");

// Listen to a specific upload on feature branch
const eventSource = new EventSource(
  "/api/stream?channel=upload:feature-x:def456"
);
```

### Listen to All Uploads for a Branch

```js
// Monitor all uploads on main branch
const eventSource = new EventSource("/api/stream?branch=main");

// Monitor all uploads on staging branch
const eventSource = new EventSource("/api/stream?branch=staging");
```

### Real-time Branch Dashboard

```js
// Example: Multi-branch monitoring dashboard
function createBranchMonitor(branches) {
  const monitors = {};

  branches.forEach((branch) => {
    monitors[branch] = new EventSource(`/api/stream?branch=${branch}`);
    monitors[branch].onmessage = (event) => {
      const data = JSON.parse(event.data);
      updateBranchUI(branch, data);
    };
  });

  return monitors;
}

const monitors = createBranchMonitor(["main", "staging", "develop"]);
```

## DynamoDB Schema

### Composite Key Structure

```
Primary Key: branch#uploadId
Sort Key: uploadId (for queries)
Attributes:
- jobId: "main#abc123"
- uploadId: "abc123"
- branch: "main"
- status: "completed"
- templateId: "audio-preview"
- ... other job data
```

### Query Patterns

```js
// Get specific job
const job = await ddb.get({
  TableName: "TransflowJobs",
  Key: { jobId: "main#abc123" },
});

// Get all jobs for a branch
const branchJobs = await ddb.query({
  TableName: "TransflowJobs",
  IndexName: "BranchIndex", // GSI on branch
  KeyConditionExpression: "branch = :branch",
  ExpressionAttributeValues: { ":branch": "main" },
});

// Get recent jobs across all branches
const recentJobs = await ddb.scan({
  TableName: "TransflowJobs",
  FilterExpression: "updatedAt > :timestamp",
  ExpressionAttributeValues: { ":timestamp": Date.now() - 3600000 },
});
```

## Getting Started

### Deploy to Multiple Branches

Transflow automatically handles branch isolation - just deploy to any branch:

```bash
# Deploy to main branch
npx transflow bake --config transflow.config.js
npx transflow deploy --branch main --sha $(git rev-parse HEAD) --config transflow.config.js

# Deploy to feature branch
npx transflow deploy --branch feature-test --sha $(git rev-parse HEAD) --config transflow.config.js
```

### Verify Branch Isolation

Upload files to different branches and observe isolated channels:

```bash
# Main branch uploads use: upload:main:{uploadId}
# Feature branch uploads use: upload:feature-test:{uploadId}
```

All branches share the same Redis and DynamoDB infrastructure while maintaining complete data separation.

## Use Cases

### Development Teams

```js
// Development setup - each developer gets isolated branch
const devConfig = {
  redis: { shared: true },
  dynamoDb: { shared: true },
};

// Branch per developer: feature-alice, feature-bob
// No interference, shared costs
```

### CI/CD Pipelines

```js
// Monitor deployments across environments
const environments = ["develop", "staging", "main"];
const dashboard = environments.map((env) => ({
  branch: env,
  stream: new EventSource(`/api/stream?branch=${env}`),
}));
```

### Testing & QA

```js
// Run parallel tests across branches
async function testMultipleBranches() {
  const results = await Promise.all([
    testBranch("feature-a"),
    testBranch("feature-b"),
    testBranch("main"),
  ]);

  // All using same Redis/DynamoDB, isolated by branch prefix
  return results;
}
```

## Performance Impact

### Positive Effects

- **Reduced Costs**: Single Redis instance vs multiple
- **Better Caching**: Shared Redis connection pools
- **Centralized Monitoring**: Single dashboard for all branches
- **Simplified Infrastructure**: Fewer resources to manage

### Considerations

- **Redis Load**: More total traffic through single instance
- **DynamoDB Hot Keys**: Branch distribution affects performance
- **Channel Filtering**: Pattern subscriptions use more CPU

### Scaling Recommendations

```js
// For high-traffic scenarios
redis: {
  provider: "upstash",
  // Use Upstash Pro tier for higher throughput
  restUrl: process.env.REDIS_REST_URL,
  token: process.env.REDIS_TOKEN,
},

dynamoDb: {
  enabled: true,
  tableName: "TransflowJobs",
  // Enable auto-scaling and consider time-based GSI for hot key distribution
}
```

## Troubleshooting

### Common Issues

**Cross-branch message leakage**

- Verify channel format: `upload:{branch}:{uploadId}`
- Check SSE subscription patterns

**DynamoDB hot partitions**

- Use time prefix in composite keys if needed
- Monitor partition metrics in CloudWatch

**Redis connection limits**

- Monitor connection count in Upstash dashboard
- Consider connection pooling for high-volume branches

### Debug Commands

```bash
# Check Redis channels
redis-cli --scan --pattern "upload:*"

# Monitor specific branch
redis-cli psubscribe "upload:main:*"

# Query DynamoDB by branch
aws dynamodb query --table-name TransflowJobs \
  --index-name BranchIndex \
  --key-condition-expression "branch = :branch" \
  --expression-attribute-values '{":branch":{"S":"main"}}'
```

This shared resource architecture provides a robust foundation for multi-branch media processing workflows while maintaining isolation and cost efficiency.

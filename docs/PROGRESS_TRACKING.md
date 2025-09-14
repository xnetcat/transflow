# Real-Time Progress Tracking

Transflow provides comprehensive real-time progress tracking for file uploads and processing with detailed status information for each file.

## Overview

The progress tracking system consists of three main components:

1. **ProgressTracker**: Server-side service that polls SQS for progress updates
2. **ProgressProvider**: React context provider for state management
3. **UploadProgressList**: UI components for displaying progress

## Architecture

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Lambda        │───▶│  SQS Progress   │───▶│  Progress       │
│   Processing    │    │  Queue (FIFO)   │    │  Tracker        │
└─────────────────┘    └─────────────────┘    └─────────────────┘
                                                       │
                                                       ▼
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   React UI      │◀───│  SSE Stream     │◀───│  Progress       │
│   Components    │    │  Handler        │    │  Provider       │
└─────────────────┘    └─────────────────┘    └─────────────────┘
```

## Data Types

### UploadProgress

```typescript
interface UploadProgress {
  uploadId: string;
  templateId: string;
  branch: string;
  status: "uploading" | "queued" | "processing" | "completed" | "error";
  totalFiles: number;
  completedFiles: number;
  files: FileStatus[];
  user?: { userId: string };
  createdAt: string;
  updatedAt: string;
}
```

### FileStatus

```typescript
interface FileStatus {
  filename: string;
  key: string;
  status: "uploading" | "queued" | "processing" | "completed" | "error";
  progress: number; // 0-100
  message?: string;
  startTime?: string;
  endTime?: string;
  outputFiles?: Array<{
    name: string;
    key: string;
    bucket: string;
    url?: string;
  }>;
}
```

## Server-Side Implementation

### Progress Tracker Service

```typescript
import { ProgressTracker } from "@xnetcat/transflow/web/ProgressTracker";

// Initialize tracker
const tracker = new ProgressTracker(config);

// Start polling for updates
const stopPolling = tracker.startPolling(2000); // Poll every 2 seconds

// Track a new upload
const progress = tracker.startTracking(
  uploadId,
  templateId,
  [{ filename: "video.mp4", key: "uploads/main/user123/abc/video.mp4" }],
  "main",
  "user123"
);

// Subscribe to updates
const unsubscribe = tracker.subscribe(uploadId, (progress) => {
  console.log("Progress update:", progress);
});
```

### API Integration

```typescript
// In your upload handler
import { createUploadHandler } from "@xnetcat/transflow/web/createUploadHandler";

const handler = createUploadHandler(config);

// The handler automatically includes tracking information in responses
export default handler;
```

## Client-Side Implementation

### Progress Provider Setup

```tsx
import { ProgressProvider } from "@xnetcat/transflow/web/ProgressProvider";

function App() {
  return (
    <ProgressProvider pollInterval={1000}>
      <UploadDashboard />
    </ProgressProvider>
  );
}
```

### Using Progress Hooks

```tsx
import {
  useProgress,
  useUploadProgress,
} from "@xnetcat/transflow/web/ProgressProvider";

function UploadForm() {
  const { startTracking } = useProgress();

  const handleUpload = async (files: FileList) => {
    const uploadId = crypto.randomUUID();

    // Start tracking immediately
    startTracking(
      uploadId,
      "video_processing",
      Array.from(files).map((file) => ({
        filename: file.name,
        key: `uploads/main/${uploadId}/${file.name}`,
      })),
      "main",
      currentUserId
    );

    // Upload files...
  };
}

function ProgressDisplay({ uploadId }: { uploadId: string }) {
  const progress = useUploadProgress(uploadId);

  if (!progress) return <div>Loading...</div>;

  return (
    <div>
      <h3>Upload: {progress.uploadId}</h3>
      <p>Status: {progress.status}</p>
      <p>
        Progress: {progress.completedFiles}/{progress.totalFiles} files
      </p>

      {progress.files.map((file) => (
        <div key={file.key}>
          <span>{file.filename}</span>
          <ProgressBar progress={file.progress} status={file.status} />
          <span>{file.message}</span>
        </div>
      ))}
    </div>
  );
}
```

### Complete Progress List

```tsx
import { UploadProgressList } from "@xnetcat/transflow/web/UploadProgressList";

function Dashboard() {
  return (
    <div>
      <h1>File Processing Dashboard</h1>
      <UploadProgressList maxItems={10} />
    </div>
  );
}
```

## Progress States and Transitions

### File Status Flow

```
uploading ──▶ queued ──▶ processing ──▶ completed
    │                        │
    ▼                        ▼
  error ◀────────────────── error
```

### Progress Percentage Mapping

| Stage          | Progress Range | Description                         |
| -------------- | -------------- | ----------------------------------- |
| Upload         | 0-10%          | File being uploaded to S3           |
| Queue          | 10-20%         | Waiting in processing queue         |
| Download       | 20-30%         | Lambda downloading file             |
| Validation     | 30-40%         | File format validation              |
| Processing     | 40-80%         | Main processing (transcoding, etc.) |
| Thumbnails     | 80-90%         | Generating preview images           |
| Upload Results | 90-95%         | Uploading processed files           |
| Cleanup        | 95-99%         | Cleaning temporary files            |
| Complete       | 100%           | All processing finished             |

## Message Types

### Progress Messages (from Lambda)

```typescript
interface ProgressMessage {
  channel: string;
  type: "start" | "step:start" | "step:done" | "output" | "done" | "error";
  uploadId: string;
  branch: string;
  timestamp: string;
  key?: string;
  step?: string;
  message?: string;
  name?: string;
  bucket?: string;
  templateId?: string;
}
```

### Example Progress Flow

```json
// Processing starts
{
  "type": "start",
  "uploadId": "abc-123",
  "key": "uploads/main/user123/abc-123/video.mp4",
  "templateId": "video_processing"
}

// Step begins
{
  "type": "step:start",
  "step": "transcode",
  "message": "Starting video transcoding"
}

// Step completes
{
  "type": "step:done",
  "step": "transcode",
  "message": "Video transcoding completed"
}

// Output file created
{
  "type": "output",
  "name": "video_720p.mp4",
  "bucket": "outputs",
  "key": "outputs/main/user123/abc-123/video_720p.mp4"
}

// Processing complete
{
  "type": "done",
  "message": "All processing completed successfully"
}
```

## Error Handling

### Error Types

1. **Upload Errors**: File upload to S3 fails
2. **Processing Errors**: Lambda function errors during processing
3. **Timeout Errors**: Processing takes longer than configured timeout
4. **Validation Errors**: File format or content validation fails

### Error Response

```json
{
  "type": "error",
  "uploadId": "abc-123",
  "message": "Transcoding failed: Unsupported video format",
  "code": "TRANSCODE_ERROR",
  "details": {
    "step": "transcode",
    "file": "video.mp4"
  }
}
```

## Performance Considerations

### Polling Optimization

- **Client-side**: Use SSE for real-time updates instead of polling REST APIs
- **Server-side**: Batch SQS message processing to reduce API calls
- **Cleanup**: Automatically remove completed uploads after 24 hours

### Memory Management

```typescript
// Auto-cleanup old uploads
setInterval(() => {
  tracker.cleanup(24 * 60 * 60 * 1000); // 24 hours
}, 60 * 60 * 1000); // Check every hour
```

### Connection Management

```typescript
// Properly close SSE connections
useEffect(() => {
  const unsubscribe = subscribe(uploadId, handleProgress);

  return () => {
    unsubscribe(); // Closes SSE connection when component unmounts
  };
}, [uploadId]);
```

## Security Considerations

### Access Control

- Users can only subscribe to their own upload progress
- Server-side validation ensures user can only track uploads they initiated
- Progress messages include user context for validation

### Data Privacy

- File contents are never included in progress messages
- Only metadata (filename, size, status) is transmitted
- User IDs are sanitized and validated

## Deployment Configuration

### SQS Setup

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
SQS_PROGRESS_QUEUE_URL="https://sqs.region.amazonaws.com/account/progress.fifo"
AWS_REGION="us-east-1"
```

## Monitoring and Analytics

### CloudWatch Metrics

- Progress message throughput
- SSE connection count
- Error rates by processing step
- Average processing time per file type

### Custom Analytics

```typescript
// Track processing metrics
tracker.subscribe(uploadId, (progress) => {
  analytics.track("file_processing_progress", {
    uploadId: progress.uploadId,
    templateId: progress.templateId,
    status: progress.status,
    completedFiles: progress.completedFiles,
    totalFiles: progress.totalFiles,
    userId: progress.user?.userId,
  });
});
```

This progress tracking system provides comprehensive real-time visibility into file processing with secure multi-tenant isolation and scalable architecture.


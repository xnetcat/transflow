# Transflow Progress Tracking Demo

This Next.js demo application showcases the real-time file processing progress tracking capabilities of Transflow with multi-tenant security.

## Features

- **Real-time Progress Tracking**: Live updates via Server-Sent Events (SSE)
- **Multi-file Upload Support**: Upload and track multiple files simultaneously
- **Detailed File Status**: Individual progress bars and status for each file
- **Secure User Isolation**: Files are isolated by user with path-based security
- **Template Selection**: Choose different processing templates
- **Output File Management**: Download links for processed files
- **Responsive UI**: Mobile-friendly progress dashboard

## Demo Architecture

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   React UI      │───▶│  Upload API     │───▶│  S3 Bucket      │
│  (Progress)     │    │  (Secure)       │    │  (User Paths)   │
└─────────────────┘    └─────────────────┘    └─────────────────┘
         │                                              │
         ▼                                              ▼
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│  SSE Stream     │◀───│  Progress API   │◀───│  SQS Progress   │
│  (Real-time)    │    │  (Polling)      │    │  Queue          │
└─────────────────┘    └─────────────────┘    └─────────────────┘
```

## Getting Started

1. **Install Dependencies**

   ```bash
   cd examples/next-app
   npm install
   ```

2. **Configure Transflow**

   ```bash
   cp ../../assets/transflow.config.sqs-only.json ./transflow.config.json
   # Edit the config with your AWS settings
   ```

3. **Set Environment Variables**

   ```bash
   # In your environment or .env.local
   export SQS_PROGRESS_QUEUE_URL="https://sqs.region.amazonaws.com/account/progress.fifo"
   export AWS_REGION="us-east-1"
   ```

4. **Run the Demo**

   ```bash
   npm run dev
   ```

5. **Open Browser**
   Visit `http://localhost:3000` to see the progress tracking dashboard

## Demo Capabilities

### File Upload & Tracking

- Select multiple audio/video files
- Choose processing template
- Real-time upload progress
- Automatic tracking initialization

### Progress Dashboard

- Live status updates for all uploads
- Individual file progress bars with detailed status
- Processing step tracking (transcoding, thumbnails, etc.)
- Error handling and retry status
- Output file download links

### Security Demo

- User-isolated file paths (`uploads/main/users/{userId}/`)
- Secure pre-signed URL generation
- Path access validation
- Content type and file size restrictions

## File Processing Statuses

| Status         | Description                 | Progress Range |
| -------------- | --------------------------- | -------------- |
| **Uploading**  | File being uploaded to S3   | 0-10%          |
| **Queued**     | Waiting in processing queue | 10-20%         |
| **Processing** | Lambda function processing  | 20-90%         |
| **Completed**  | All processing finished     | 100%           |
| **Error**      | Processing failed           | N/A            |

## Processing Steps Tracked

1. **File Download** (10-20%): Lambda downloads from S3
2. **Validation** (20-30%): File format and content validation
3. **Transcoding** (30-70%): Main processing (audio/video conversion)
4. **Thumbnail Generation** (70-80%): Create preview images
5. **Upload Results** (80-90%): Upload processed files to S3
6. **Cleanup** (90-95%): Clean up temporary files
7. **Completion** (100%): Processing finished

## API Endpoints

### Upload API (`/api/create-upload`)

```typescript
POST /api/create-upload
{
  filename: string;
  contentType: string;
  template: string;
  fileSize?: number;
  // OR for batch:
  files: Array<{
    filename: string;
    contentType: string;
    fileSize?: number;
  }>;
}
```

### Progress API (`/api/progress`)

```typescript
GET /api/progress?uploadId=123        // Get specific upload
GET /api/progress                     // Get all uploads
POST /api/progress                    // Start tracking upload
```

### Streaming API (`/api/stream`)

```typescript
GET /api/stream?uploadId=123          // SSE progress updates
```

## Customization

### Adding New Templates

```typescript
// In pages/index.tsx
<option value="custom_template">Custom Processing</option>
```

### Custom Progress Steps

```typescript
// In src/web/ProgressProvider.tsx
const stepMap: Record<string, number> = {
  custom_step: completed ? 80 : 70,
  // ... other steps
};
```

### Styling Progress Bars

```css
/* In styles/globals.css */
.progress-bar-custom {
  background: linear-gradient(90deg, #667eea 0%, #764ba2 100%);
}
```

## Production Deployment

1. **AWS Infrastructure**: Deploy SQS queues and Lambda functions
2. **Authentication**: Enable JWT/session-based auth in config
3. **Monitoring**: Set up CloudWatch alarms for processing failures
4. **Scaling**: Configure Lambda reserved concurrency limits
5. **Security**: Apply S3 bucket policies and IAM least-privilege

## Troubleshooting

### No Progress Updates

- Check `SQS_PROGRESS_QUEUE_URL` environment variable
- Verify AWS credentials and region
- Confirm SQS queue exists and has correct permissions

### Files Not Processing

- Check processing queue for messages
- Verify Lambda function deployment
- Review CloudWatch logs for errors

### Upload Failures

- Confirm S3 bucket exists and is accessible
- Check file size limits and content type restrictions
- Verify pre-signed URL generation

This demo provides a complete example of real-time progress tracking with Transflow's secure, scalable architecture.

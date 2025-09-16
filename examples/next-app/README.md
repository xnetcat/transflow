# Transflow Example (Polling-based Status)

This Next.js demo shows Transflow's secure upload flow with DynamoDB-backed status polling (no SSE).

## Features

- **Polling-based Status**: Client polls a status endpoint every 2s
- **Multi-file Upload**: Batch presigned PUTs to S3
- **No Sessions/Auth**: Demo omits auth; assembly IDs are deterministic and unguessable
- **Download Results**: Links to output files in S3

## Architecture

```
React UI ──▶ Create Upload API ──▶ S3 (uploads/...)
   │                                 │
   ▼                                 ▼
Status API ◀── DynamoDB (status) ◀── Lambda (SQS-driven)
```

## Getting Started

1. Install

```bash
cd examples/next-app
npm install
```

2. Configure

Edit `transflow.config.js` with your AWS resources. Tmp bucket is automatic; set your export buckets under `s3.exportBuckets`.

3. Run

```bash
npm run dev
```

Open `http://localhost:3000`.

## Endpoints used

- `POST /api/create-upload` → returns presigned PUT URLs + upload info
- `GET /api/status?assemblyId=...` → returns `AssemblyStatus` from DynamoDB
- `POST /api/resolve-assembly` → computes `assembly_id` by streaming uploaded objects

## Client usage

The page uses `@xnetcat/transflow/web`:

```tsx
import { Uploader, TransflowProvider } from "@xnetcat/transflow/web";

<TransflowProvider
  endpoints={{
    action: "/api/create-upload",
    status: "/api/status",
    resolve: "/api/resolve-assembly",
  }}
>
  <Uploader template="tpl_basic_audio" onUpdate={handleUpdate} multiple />
</TransflowProvider>;
```

## Notes

- Status polling interval is 2s by default in the `Uploader`.
- Example templates include `tpl_basic_audio` and `tpl_export_example`.

# Transflow Next.js example

A minimal Next.js Pages-Router app that wires the React `<Uploader>` to your Transflow API routes. Includes shortcuts for running the entire pipeline locally against LocalStack.

## What's in here

- `pages/index.tsx` — the demo page with the uploader and a status table
- `pages/api/create-upload.ts` — wraps `createUploadHandler`
- `pages/api/status.ts` — wraps `createStatusHandler`
- `templates/` — example templates baked into the Lambda image
- `transflow.config.js` — single config that flips into LocalStack mode when `TRANSFLOW_AWS_ENDPOINT` is set
- `scripts/e2e.mjs` / `scripts/e2e-suite.mjs` — integration drivers used to verify the LocalStack flow

## Run locally with LocalStack

You'll need Docker + Node 18+. The first time:

```bash
npm install
npm run local:up        # docker compose up LocalStack
npm run bake            # bakes templates.index.cjs into .transflow-build/
npm run local:start     # provisions buckets/queue/table on LocalStack
```

Then in two terminals:

```bash
# terminal 1: long-lived worker (replaces the Lambda)
npm run local:worker

# terminal 2: Next.js dev server
TRANSFLOW_AWS_ENDPOINT=http://localhost:4566 npm run dev
```

Open <http://localhost:3000>, drop an audio file, watch the status update.

To tear down:

```bash
npm run local:down      # docker compose down -v
```

## Deploy to AWS

Drop the env var and run the regular deploy:

```bash
npm run deploy
```

This calls `transflow deploy --branch local --sha dev`. In production CI, run it with the actual branch/SHA — see the root README for the GitHub Actions setup.

## Endpoints

- `POST /api/create-upload` — `{ filename, contentType?, fileSize?, template, fields? }` → `{ assembly_id, upload_id, presigned_url }`. Pass `{ files: [...] }` instead for batch uploads.
- `GET /api/status?assemblyId=…` — full `AssemblyStatus`, polled by the `<Uploader>` component every 2s until terminal.

## Client usage

```tsx
import { TransflowProvider, Uploader } from "@xnetcat/transflow/web";

<TransflowProvider endpoints={{ action: "/api/create-upload", status: "/api/status" }}>
  <Uploader template="tpl_basic_audio" multiple onUpdate={(s) => console.log(s)} />
</TransflowProvider>;
```

## Run the integration suite

```bash
# uses your already-running LocalStack + provisioned resources
node scripts/e2e-suite.mjs                 # full multi-scenario suite
node scripts/e2e.mjs /tmp/test.mp3         # single-shot smoke test
```

The suite covers: lifecycle/CORS, status edge cases (404, missing param), single-file upload, batch upload (with assembly merge), failure path with tmp cleanup, webhook delivery + HMAC signature, and concurrent assemblies.

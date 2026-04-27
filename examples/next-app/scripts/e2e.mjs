// Drive the full LocalStack pipeline end-to-end:
// 1) createUploadHandler → presigned PUT
// 2) PUT a local file
// 3) start the worker, wait for ASSEMBLY_COMPLETED in DDB, stop
// Usage:
//   node scripts/e2e.mjs <local-file>
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  createUploadHandler,
  createStatusHandler,
} from "@xnetcat/transflow";
import cfg from "../transflow.config.js";
import { localWorker } from "../../../dist/cli/tasks/localWorker.js";

const filePath = path.resolve(process.argv[2] ?? "/tmp/transflow-e2e/test.mp3");
if (!fs.existsSync(filePath)) {
  console.error(`Input not found: ${filePath}`);
  process.exit(1);
}
const filename = path.basename(filePath);
const fileBytes = fs.readFileSync(filePath);
const contentType = "audio/mpeg";

function fakeRes() {
  let _status = 0;
  let _body;
  const res = {
    status(code) {
      _status = code;
      return res;
    },
    json(body) {
      _body = body;
    },
    setHeader() {},
    _result: () => ({ status: _status, body: _body }),
  };
  return res;
}

// 1) Issue presigned URL
const upload = createUploadHandler(cfg);
const res = fakeRes();
await upload(
  {
    method: "POST",
    body: { filename, contentType, template: "tpl_basic_audio", fileSize: fileBytes.length },
    headers: {},
  },
  res
);
const { status, body } = res._result();
if (status !== 200) {
  console.error("create-upload failed:", status, body);
  process.exit(1);
}
console.log(`📨 assembly_id=${body.assembly_id} (presigned in ${status})`);

// 2) PUT the file via the presigned URL
const putStart = performance.now();
const putResp = await fetch(body.presigned_url, {
  method: "PUT",
  headers: { "Content-Type": contentType },
  body: fileBytes,
});
if (!putResp.ok) {
  console.error("S3 PUT failed:", putResp.status, await putResp.text());
  process.exit(1);
}
console.log(
  `⬆️  PUT ${fileBytes.length} bytes in ${Math.round(
    performance.now() - putStart
  )}ms`
);

// 3) Start worker + poll status
const status_ = createStatusHandler(cfg);
const ac = new AbortController();
const workerPromise = localWorker({
  cfg,
  signal: ac.signal,
  templatesIndexPath: ".transflow-build/templates.index.cjs",
}).catch((err) => {
  console.error("worker crashed:", err);
});

const deadline = Date.now() + 60_000;
let final;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 1000));
  const r = fakeRes();
  await status_({ query: { assemblyId: body.assembly_id }, headers: {} }, r);
  const cur = r._result().body;
  if (!cur) continue;
  process.stdout.write(
    `\r⏱  ${cur.message ?? "?"} progress=${cur.progress_pct ?? 0}%`
  );
  if (cur.ok === "ASSEMBLY_COMPLETED" || cur.error) {
    final = cur;
    break;
  }
}
ac.abort();
await workerPromise;
process.stdout.write("\n");

if (!final) {
  console.error("timeout waiting for completion");
  process.exit(1);
}
if (final.error) {
  console.error("processing error:", final);
  process.exit(1);
}
console.log("✅ ASSEMBLY_COMPLETED");
console.log(JSON.stringify(final.results, null, 2));

// Full end-to-end suite against LocalStack. Drives every flow we care about
// in one process: single upload, batch upload, status edge cases, failure
// path, webhook + HMAC, lifecycle/CORS verification.
//
//   TRANSFLOW_AWS_ENDPOINT=http://localhost:4566 node scripts/e2e-suite.mjs
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import {
  createUploadHandler,
  createStatusHandler,
} from "@xnetcat/transflow";
import cfg from "../transflow.config.js";
import { localWorker } from "../../../dist/cli/tasks/localWorker.js";
import {
  S3Client,
  GetBucketCorsCommand,
  GetBucketLifecycleConfigurationCommand,
} from "@aws-sdk/client-s3";
import { execa } from "execa";

const ENDPOINT = process.env.TRANSFLOW_AWS_ENDPOINT ?? "http://localhost:4566";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeRes() {
  let _status = 0;
  let _body;
  const r = {
    status(code) {
      _status = code;
      return r;
    },
    json(body) {
      _body = body;
    },
    setHeader() {},
    _: () => ({ status: _status, body: _body }),
  };
  return r;
}

const failures = [];
const passes = [];
function check(name, ok, detail) {
  if (ok) {
    passes.push(name);
    console.log(`  ✓ ${name}`);
  } else {
    failures.push({ name, detail });
    console.log(`  ✗ ${name}`);
    if (detail !== undefined) console.log(`     ↳`, detail);
  }
}

const s3 = new S3Client({
  region: cfg.region,
  endpoint: ENDPOINT,
  forcePathStyle: true,
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
});
const upload = createUploadHandler(cfg);
const status = createStatusHandler(cfg);

async function reset() {
  // Empty buckets and queue between scenarios so assertions are clean.
  for (const bucket of [
    "example-eu-north-1-transflow-tmp",
    "example-outputs",
  ]) {
    try {
      await execa(
        "aws",
        [
          `--endpoint-url=${ENDPOINT}`,
          "--region",
          cfg.region,
          "s3",
          "rm",
          `s3://${bucket}`,
          "--recursive",
        ],
        { env: { ...process.env, AWS_ACCESS_KEY_ID: "test", AWS_SECRET_ACCESS_KEY: "test" } }
      );
    } catch {}
  }
  try {
    await execa(
      "aws",
      [
        `--endpoint-url=${ENDPOINT}`,
        "--region",
        cfg.region,
        "sqs",
        "purge-queue",
        "--queue-url",
        `${ENDPOINT}/000000000000/example-processing`,
      ],
      { env: { ...process.env, AWS_ACCESS_KEY_ID: "test", AWS_SECRET_ACCESS_KEY: "test" } }
    );
  } catch {}
}

async function pollStatus(assemblyId, predicate, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    await sleep(800);
    const r = fakeRes();
    await status({ query: { assemblyId }, headers: {} }, r);
    last = r._().body;
    if (last && predicate(last)) return last;
  }
  return last;
}

async function startWorker() {
  const ac = new AbortController();
  const promise = localWorker({
    cfg,
    signal: ac.signal,
    templatesIndexPath: ".transflow-build/templates.index.cjs",
  }).catch((err) => console.error("worker crash:", err));
  return { ac, promise };
}

async function withWorker(fn) {
  const { ac, promise } = await startWorker();
  try {
    return await fn();
  } finally {
    ac.abort();
    await promise;
  }
}

async function getStatusFor(assemblyId) {
  const r = fakeRes();
  await status({ query: { assemblyId }, headers: {} }, r);
  return r._();
}

async function presign({ filename = "test.mp3", batch, fields, template = "tpl_basic_audio" } = {}) {
  const r = fakeRes();
  await upload(
    {
      method: "POST",
      body: batch
        ? { template, fields, files: batch }
        : { template, filename, contentType: "audio/mpeg", fileSize: 40585, fields },
      headers: {},
    },
    r
  );
  return r._();
}

async function putFile(presigned_url, bytes, contentType = "audio/mpeg") {
  const resp = await fetch(presigned_url, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: bytes,
  });
  return resp;
}

const FILE = fs.readFileSync(process.argv[2] ?? "/tmp/transflow-e2e/test.mp3");
console.log(`Driver loaded ${FILE.length} bytes`);

// ─────────────────────── 1. lifecycle + cors verification ───────────────────────
console.log("\n[1] LocalStack-side bucket configuration");
{
  const cors = await s3.send(
    new GetBucketCorsCommand({ Bucket: "example-eu-north-1-transflow-tmp" })
  );
  check(
    "CORS rule has expected origins",
    JSON.stringify(cors.CORSRules?.[0]?.AllowedOrigins) ===
      JSON.stringify(cfg.s3.corsAllowedOrigins),
    cors.CORSRules
  );
  // LocalStack 3.x supports lifecycle config but the local:start path doesn't
  // currently apply it (deploy.ts does). Confirm absence is graceful.
  let lifecycleErr;
  try {
    await s3.send(
      new GetBucketLifecycleConfigurationCommand({
        Bucket: "example-eu-north-1-transflow-tmp",
      })
    );
  } catch (err) {
    lifecycleErr = err.name;
  }
  check(
    "Lifecycle either configured or NoSuchLifecycleConfiguration (local:start skips it)",
    !lifecycleErr || lifecycleErr === "NoSuchLifecycleConfiguration"
  );
}

// ─────────────────────── 2. status 404 ───────────────────────
console.log("\n[2] Status edge cases");
{
  const r404 = fakeRes();
  await status({ query: { assemblyId: "definitely-not-real" }, headers: {} }, r404);
  check("unknown assembly → 404", r404._().status === 404, r404._());

  const r400 = fakeRes();
  await status({ query: {}, headers: {} }, r400);
  check("missing assemblyId → 400", r400._().status === 400, r400._());
}

// ─────────────────────── 3. single-file happy path ───────────────────────
console.log("\n[3] Single-file happy path");
await reset();
{
  const r = await presign();
  check("create-upload returns 200", r.status === 200);
  const aid = r.body.assembly_id;

  const beforeWorker = await getStatusFor(aid);
  check(
    "DDB created with 'Upload pending' before worker",
    beforeWorker.status === 200 && beforeWorker.body.message === "Upload pending",
    beforeWorker
  );
  check(
    "DDB record has TTL",
    typeof beforeWorker.body.ttl === "number" && beforeWorker.body.ttl > Date.now() / 1000,
    beforeWorker.body.ttl
  );

  const putResp = await putFile(r.body.presigned_url, FILE);
  check("S3 PUT 200", putResp.ok, putResp.status);

  const final = await withWorker(() =>
    pollStatus(aid, (s) => s.ok === "ASSEMBLY_COMPLETED" || s.error)
  );
  check("ASSEMBLY_COMPLETED", final?.ok === "ASSEMBLY_COMPLETED", final?.message);
  check(
    "results populated with 2 entries (preview + master)",
    Array.isArray(final?.results?.preview) && final.results.preview.length === 2,
    final?.results
  );
  check(
    "ssl_url points at LocalStack endpoint",
    !!final?.results?.preview?.[0]?.ssl_url?.startsWith(ENDPOINT),
    final?.results?.preview?.[0]?.ssl_url
  );
  check(
    "execution_duration recorded",
    typeof final?.execution_duration === "number" && final.execution_duration >= 0
  );
}

// ─────────────────────── 4. batch upload (2 files) ───────────────────────
console.log("\n[4] Batch upload");
await reset();
{
  const r = await presign({
    batch: [
      { filename: "a.mp3", contentType: "audio/mpeg", fileSize: FILE.length },
      { filename: "b.mp3", contentType: "audio/mpeg", fileSize: FILE.length },
    ],
  });
  check("batch create-upload returns 200", r.status === 200, r);
  check("batch returns 2 presigned URLs", r.body.files?.length === 2);
  const aid = r.body.assembly_id;

  for (const f of r.body.files) {
    const ok = (await putFile(f.presigned_url, FILE)).ok;
    check(`PUT ${f.filename}`, ok);
  }

  const final = await withWorker(() =>
    pollStatus(aid, (s) => s.ok === "ASSEMBLY_COMPLETED" || s.error, 90_000)
  );
  check("batch ASSEMBLY_COMPLETED", final?.ok === "ASSEMBLY_COMPLETED", final?.message);
  check(
    "uploads array has 2 files",
    final?.uploads?.length === 2,
    final?.uploads?.map((u) => u.name)
  );
  // Template emits 2 results per input (preview + master) via exportToBucket.
  check(
    "preview results count equals 4 (preview+master × 2 inputs)",
    final?.results?.preview?.length === 4,
    final?.results?.preview?.length
  );
}

// ─────────────────────── 5. failure path: template throws ───────────────────────
console.log("\n[5] Failure path");
await reset();
{
  // Use the basic-audio template but with a non-audio body that ffmpeg will reject.
  const r = await presign({ filename: "broken.mp3" });
  check("presign 200", r.status === 200);
  const aid = r.body.assembly_id;
  const ok = (await putFile(r.body.presigned_url, Buffer.from("not actually audio"))).ok;
  check("PUT 200", ok);

  const final = await withWorker(() =>
    pollStatus(aid, (s) => s.ok === "ASSEMBLY_COMPLETED" || s.error, 30_000)
  );
  check("error recorded on assembly", final?.error === "PROCESSING_ERROR", final?.message);
  check(
    "tmp object cleaned up on failure",
    await (async () => {
      const r2 = await execa(
        "aws",
        [
          `--endpoint-url=${ENDPOINT}`,
          "--region",
          cfg.region,
          "s3",
          "ls",
          `s3://example-eu-north-1-transflow-tmp/uploads/main/${aid}/`,
        ],
        {
          env: { ...process.env, AWS_ACCESS_KEY_ID: "test", AWS_SECRET_ACCESS_KEY: "test" },
          reject: false,
        }
      );
      return r2.stdout.trim() === "";
    })()
  );
}

// ─────────────────────── 6. webhook + HMAC ───────────────────────
console.log("\n[6] Webhook delivery + HMAC");
await reset();
{
  const calls = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString();
      calls.push({ headers: req.headers, body });
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const webhookUrl = `http://127.0.0.1:${port}/hook`;
  const secret = "shhh";

  // Patch the baked template index on disk to add webhook config, and clear
  // the Node require cache so the worker picks up the new content.
  const tplIndexPath = path.resolve(".transflow-build/templates.index.cjs");
  const tplModulePath = path.resolve(
    ".transflow-build/templates/tpl_basic_audio.js"
  );
  const original = fs.readFileSync(tplIndexPath, "utf8");
  const patched = original.replace(
    /require\('\.\/templates\/tpl_basic_audio\.js'\)/,
    (m) =>
      `Object.assign({}, ${m}, { default: Object.assign({}, ${m}.default, { webhookUrl: ${JSON.stringify(
        webhookUrl
      )}, webhookSecret: ${JSON.stringify(secret)} }) })`
  );
  fs.writeFileSync(tplIndexPath, patched);
  // Drop cached require entries so the next loadTemplatesIndex re-reads.
  const { createRequire } = await import("node:module");
  const req = createRequire(import.meta.url);
  for (const p of [tplIndexPath, tplModulePath]) {
    try {
      delete req.cache[req.resolve(p)];
    } catch {}
  }

  try {
    const r = await presign({ filename: "wh.mp3" });
    const aid = r.body.assembly_id;
    await putFile(r.body.presigned_url, FILE);
    const final = await withWorker(() =>
      pollStatus(aid, (s) => s.ok === "ASSEMBLY_COMPLETED" || s.error)
    );
    check("ASSEMBLY_COMPLETED with webhook", final?.ok === "ASSEMBLY_COMPLETED");

    // Webhook should fire after final state.
    let attempts = 20;
    while (calls.length === 0 && attempts-- > 0) await sleep(200);
    check("webhook called once", calls.length === 1, calls.length);
    if (calls.length) {
      const got = calls[0];
      const expectedSig = `sha256=${crypto
        .createHmac("sha256", secret)
        .update(got.body)
        .digest("hex")}`;
      check(
        "X-Transflow-Signature matches HMAC",
        got.headers["x-transflow-signature"] === expectedSig,
        { got: got.headers["x-transflow-signature"], expected: expectedSig }
      );
      check(
        "webhook payload includes assembly_id and ok",
        (() => {
          const p = JSON.parse(got.body);
          return p.assembly_id === aid && p.ok === "ASSEMBLY_COMPLETED";
        })()
      );
    }
  } finally {
    fs.writeFileSync(tplIndexPath, original);
    server.close();
  }
}

// ─────────────────────── 7. concurrency: two assemblies in parallel ───────────────────────
console.log("\n[7] Concurrent assemblies");
await reset();
{
  const a = await presign({ filename: "p1.mp3" });
  const b = await presign({ filename: "p2.mp3" });
  await Promise.all([
    putFile(a.body.presigned_url, FILE),
    putFile(b.body.presigned_url, FILE),
  ]);
  const finalA = await withWorker(() =>
    pollStatus(a.body.assembly_id, (s) => s.ok === "ASSEMBLY_COMPLETED" || s.error, 90_000)
  );
  const finalB = await getStatusFor(b.body.assembly_id);
  check("assembly A completes", finalA?.ok === "ASSEMBLY_COMPLETED");
  check(
    "assembly B also completes (drained in same worker batch)",
    finalB.body?.ok === "ASSEMBLY_COMPLETED"
  );
}

// ─────────────────────── results ───────────────────────
console.log(`\n──── ${passes.length} passed, ${failures.length} failed ────`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  FAIL: ${f.name}`);
  process.exit(1);
}

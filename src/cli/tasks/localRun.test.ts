import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import { bakeTemplates } from "../../core/bake";
import { localRun } from "./localRun";

const root = path.join(process.cwd(), "tmp-local");
const templatesDir = path.join(root, "templates");
const lambdaCtx = path.join(root, "lambda");

beforeAll(async () => {
  fs.mkdirSync(templatesDir, { recursive: true });
  fs.mkdirSync(lambdaCtx, { recursive: true });
  const tpl = `export default { id: 't1', steps: [{ name: 'noop', run: async () => {} }] }`;
  fs.writeFileSync(path.join(templatesDir, "t1.ts"), tpl);
  await bakeTemplates({ templatesDir, outDir: lambdaCtx });
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("localRun", () => {
  it("runs template locally", async () => {
    const cfg = {
      project: "p",
      region: "us-east-1",
      s3: { exportBuckets: ["ob"] },
      ecrRepo: "repo",
      lambdaPrefix: "lp-",
      templatesDir,
      dynamoDb: { tableName: "test-table" },
      lambda: { memoryMb: 512, timeoutSec: 60 },
    } as const;
    const input = path.join(root, "input.txt");
    fs.writeFileSync(input, "hello");
    const res = await localRun({
      cfg: cfg as any,
      filePath: input,
      outDir: lambdaCtx,
    });
    expect(res.outputsDir).toBeDefined();
  });
});

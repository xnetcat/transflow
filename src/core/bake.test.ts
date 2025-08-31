import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import { bakeTemplates } from "./bake";

const tmp = path.join(process.cwd(), "tmp-bake");
const templatesDir = path.join(tmp, "templates");

beforeAll(() => {
  fs.mkdirSync(templatesDir, { recursive: true });
  const tpl = `export default { id: 't1', steps: [{ name: 'noop', run: async () => {} }] }`;
  fs.writeFileSync(path.join(templatesDir, "t1.ts"), tpl);
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("bakeTemplates", () => {
  it("builds templates and index", async () => {
    const outDir = path.join(tmp, "out");
    const result = await bakeTemplates({ templatesDir, outDir });
    expect(fs.existsSync(result.indexFile)).toBe(true);
    expect(result.entries.length).toBe(1);
    expect(fs.existsSync(path.join(outDir, "templates", "t1.js"))).toBe(true);
  });
});

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { loadConfigObject, sanitizeBranch } from "./config";

describe("config", () => {
  it("loads valid config", async () => {
    const tmp = path.join(process.cwd(), "tmp-config.json");
    const cfg = {
      project: "myapp",
      region: "us-east-1",
      s3: { exportBuckets: ["ub", "ob"] },
      ecrRepo: "repo",
      lambdaPrefix: "lp-",
      templatesDir: "./templates",
      dynamoDb: {
        tableName: "test-table",
      },
      lambda: { memoryMb: 512, timeoutSec: 60 },
      sqs: {
        queueName: "test-processing.fifo",
        visibilityTimeoutSec: 960,
        maxReceiveCount: 3,
        batchSize: 10,
      },
    };
    fs.writeFileSync(tmp, JSON.stringify(cfg));
    const loaded = loadConfigObject(JSON.parse(fs.readFileSync(tmp, "utf8")));
    fs.unlinkSync(tmp);
    expect(loaded.project).toBe("myapp");
    expect(Array.isArray(loaded.s3.exportBuckets)).toBe(true);
  });

  it("sanitizes branch names", () => {
    expect(sanitizeBranch("feature/test")).toBe("feature-test");
    expect(sanitizeBranch("UPPER$$$Case")).toBe("upper-case");
  });
});

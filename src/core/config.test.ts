import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { loadConfig, sanitizeBranch } from "./config";

describe("config", () => {
  it("loads valid config", async () => {
    const tmp = path.join(process.cwd(), "tmp-config.json");
    const cfg = {
      project: "myapp",
      region: "us-east-1",
      s3: { mode: "prefix", uploadBucket: "ub", outputBucket: "ob" },
      ecrRepo: "repo",
      lambdaPrefix: "lp-",
      templatesDir: "./templates",
      lambdaBuildContext: "./lambda",
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
    const loaded = await loadConfig(tmp);
    fs.unlinkSync(tmp);
    expect(loaded.project).toBe("myapp");
    expect(loaded.s3.mode).toBe("prefix");
  });

  it("sanitizes branch names", () => {
    expect(sanitizeBranch("feature/test")).toBe("feature-test");
    expect(sanitizeBranch("UPPER$$$Case")).toBe("upper-case");
  });
});

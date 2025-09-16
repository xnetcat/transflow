import fs from "fs";
import path from "path";
import type { TransflowConfig } from "../../core/types";
import { loadConfigObject } from "../../core/config";

export async function loadConfig(
  configPath?: string
): Promise<TransflowConfig> {
  const defaultCandidates = [
    "transflow.config.js",
    "transflow.config.cjs",
    "transflow.config.mjs",
    "transflow.config.json",
  ];
  let rel = configPath ?? "";
  if (!rel) {
    const found = defaultCandidates.find((p) =>
      fs.existsSync(path.resolve(process.cwd(), p))
    );
    if (!found) {
      throw new Error(
        `Config file not found. Looked for: ${defaultCandidates.join(", ")}`
      );
    }
    rel = found;
  }
  const abs = path.isAbsolute(rel) ? rel : path.resolve(process.cwd(), rel);
  if (!fs.existsSync(abs)) {
    throw new Error(`Config file not found: ${abs}`);
  }

  let rawConfig: unknown;
  if (abs.endsWith(".json")) {
    const raw = fs.readFileSync(abs, "utf8");
    rawConfig = JSON.parse(raw);
  } else if (abs.endsWith(".js") || abs.endsWith(".cjs")) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(abs);
    rawConfig = (mod && (mod.default ?? mod)) as unknown;
  } else if (abs.endsWith(".mjs")) {
    const mod = await import(abs);
    rawConfig = (mod && (mod.default ?? (mod as any))) as unknown;
  } else {
    throw new Error(`Unsupported config extension: ${path.extname(abs)}`);
  }

  return loadConfigObject(rawConfig);
}


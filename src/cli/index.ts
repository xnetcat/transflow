#!/usr/bin/env node
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import path from "path";
import fs from "fs";
import { loadConfigObject, sanitizeBranch } from "../core/config";
import { loadConfig } from "./util/loadConfig";

function resolveOutDir(cfgOut: string) {
  const abs = path.isAbsolute(cfgOut)
    ? cfgOut
    : path.resolve(process.cwd(), cfgOut);
  return abs;
}

void yargs(hideBin(process.argv))
  .scriptName("transflow")
  .command(
    "deploy",
    "Build/push Lambda image and configure AWS resources",
    (y) =>
      y
        .option("branch", { type: "string", demandOption: true })
        .option("sha", { type: "string", demandOption: true })
        .option("tag", { type: "string" })
        .option("yes", { type: "boolean", default: false })
        .option("force-rebuild", {
          type: "boolean",
          default: false,
          describe: "Force docker image rebuild (no cache)",
        })
        .option("config", { type: "string" }),
    async (argv) => {
      const cfg = await loadConfig(argv.config as string | undefined);
      const safeBranch = sanitizeBranch(String(argv.branch));
      const sha = String(argv.sha);
      const tag = (argv.tag as string | undefined) ?? `${safeBranch}-${sha}`;
      // No separate bake step required; deploy will prepare build context
      const { deploy } = await import("./tasks/deploy.js");
      await deploy({
        cfg,
        branch: safeBranch,
        sha,
        tag,
        nonInteractive: !!argv.yes,
        forceRebuild: !!argv["force-rebuild"],
      });
    }
  )
  .command(
    "cleanup",
    "Remove branch resources",
    (y) =>
      y
        .option("branch", { type: "string", demandOption: true })
        .option("yes", { type: "boolean", default: false })
        .option("delete-storage", { type: "boolean", default: false })
        .option("delete-ecr-images", { type: "boolean", default: false })
        .option("config", { type: "string" }),
    async (argv) => {
      const cfg = await loadConfig(argv.config as string | undefined);
      const safeBranch = sanitizeBranch(String(argv.branch));
      const { cleanup } = await import("./tasks/cleanup.js");
      await cleanup({
        cfg,
        branch: safeBranch,
        nonInteractive: !!argv.yes,
        deleteStorage: !!argv["delete-storage"],
        deleteEcrImages: !!argv["delete-ecr-images"],
      });
    }
  )
  .command(
    "destroy",
    "Destroy ALL Transflow AWS resources for this project (WARNING: destructive!)",
    (y) =>
      y
        .option("force", {
          type: "boolean",
          default: false,
          describe: "Skip confirmation",
        })
        .option("yes", { type: "boolean", default: false })
        .option("config", { type: "string" }),
    async (argv) => {
      const cfg = await loadConfig(argv.config as string | undefined);
      const { destroy } = await import("./tasks/destroy.js");
      await destroy({
        cfg,
        force: !!argv.force,
        nonInteractive: !!argv.yes,
      });
    }
  )
  .command(
    "local:run",
    "Simulate S3 event locally against baked templates",
    (y) =>
      y
        .option("config", { type: "string" })
        .option("file", {
          type: "string",
          demandOption: true,
          describe: "Path to input media file",
        })
        .option("template", { type: "string", describe: "Template ID to run" })
        .option("out", {
          type: "string",
          describe: "Output directory for results",
        }),
    async (argv) => {
      const cfg = await loadConfig(argv.config as string | undefined);
      const { localRun } = await import("./tasks/localRun.js");
      await localRun({
        cfg,
        filePath: String(argv.file),
        templateId: argv.template as string | undefined,
        outDir: argv.out as string | undefined,
      });
    }
  )
  .command(
    "check",
    "Check environment and config",
    (y) => y.option("config", { type: "string" }),
    async (argv) => {
      const { checkEnv } = await import("./tasks/check.js");
      await checkEnv();
    }
  )
  .demandCommand(1)
  .strict()
  .help().argv;

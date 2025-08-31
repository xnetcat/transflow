#!/usr/bin/env node
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import path from "path";
import fs from "fs";
import { bakeTemplates } from "../core/bake";
import { loadConfig, sanitizeBranch } from "../core/config";

function resolveOutDir(cfgOut: string) {
  const abs = path.isAbsolute(cfgOut)
    ? cfgOut
    : path.resolve(process.cwd(), cfgOut);
  return abs;
}

void yargs(hideBin(process.argv))
  .scriptName("transflow")
  .command(
    "bake",
    "Bundle templates to Docker build context",
    (y) =>
      y
        .option("config", {
          type: "string",
          describe: "Path to transflow.config.json",
        })
        .option("templates", {
          type: "string",
          describe: "Templates directory override",
        })
        .option("out", {
          type: "string",
          describe: "Output build context directory override",
        })
        .demandOption([], ""),
    async (argv) => {
      const cfg = loadConfig(argv.config as string | undefined);
      const templatesDir = argv.templates
        ? String(argv.templates)
        : cfg.templatesDir;
      const outDir = resolveOutDir(
        (argv.out as string | undefined) ?? cfg.lambdaBuildContext
      );
      const result = await bakeTemplates({ templatesDir, outDir });
      console.log(
        `Baked ${result.entries.length} templates to ${result.outDir}`
      );
      console.log(`Index: ${result.indexFile}`);
    }
  )
  .command(
    "deploy",
    "Build/push Lambda image and configure AWS resources",
    (y) =>
      y
        .option("branch", { type: "string", demandOption: true })
        .option("sha", { type: "string", demandOption: true })
        .option("tag", { type: "string" })
        .option("yes", { type: "boolean", default: false })
        .option("config", { type: "string" }),
    async (argv) => {
      const cfg = loadConfig(argv.config as string | undefined);
      const safeBranch = sanitizeBranch(String(argv.branch));
      const sha = String(argv.sha);
      const tag = (argv.tag as string | undefined) ?? `${safeBranch}-${sha}`;
      const buildContext = resolveOutDir(cfg.lambdaBuildContext);
      if (!fs.existsSync(path.join(buildContext, "templates.index.cjs"))) {
        throw new Error(
          `templates.index.cjs not found in ${buildContext}. Run 'transflow bake' first.`
        );
      }
      const { deploy } = await import("./tasks/deploy.js");
      await deploy({
        cfg,
        branch: safeBranch,
        sha,
        tag,
        nonInteractive: !!argv.yes,
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
      const cfg = loadConfig(argv.config as string | undefined);
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
      const cfg = loadConfig(argv.config as string | undefined);
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

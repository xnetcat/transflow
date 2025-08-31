import path from "path";
import fs from "fs";
import { spawn } from "child_process";
import type {
  TransflowConfig,
  StepContext,
  TemplateDefinition,
} from "../../core/types";

export async function localRun({
  cfg,
  templateId,
  filePath,
  outDir,
}: {
  cfg: TransflowConfig;
  templateId?: string;
  filePath: string;
  outDir?: string;
}) {
  const ctxDir = path.isAbsolute(cfg.lambdaBuildContext)
    ? cfg.lambdaBuildContext
    : path.resolve(process.cwd(), cfg.lambdaBuildContext);
  const indexPath = path.join(ctxDir, "templates.index.cjs");
  if (!fs.existsSync(indexPath))
    throw new Error(
      `Missing baked index at ${indexPath}. Run 'transflow bake'.`
    );
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const index = require(indexPath) as Record<
    string,
    { default: TemplateDefinition }
  >;
  const tplId = templateId || Object.keys(index)[0];
  if (!tplId) throw new Error("No templates found in index");
  const mod = index[tplId];
  if (!mod?.default) throw new Error(`Template not found: ${tplId}`);
  const tpl = mod.default;

  const uploadId = `local-${Date.now()}`;
  const branch = process.env.TRANSFLOW_BRANCH || "local";
  const outputBucket = "local";
  const outputsPrefix = `outputs/${branch}/${uploadId}/`;
  const tmpDir = fs.mkdtempSync(path.join(process.cwd(), ".transflow-local-"));
  const inputLocalPath = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(process.cwd(), filePath);
  const effectiveOutDir = outDir
    ? path.isAbsolute(outDir)
      ? outDir
      : path.resolve(process.cwd(), outDir)
    : path.join(process.cwd(), ".transflow-outputs");
  fs.mkdirSync(path.join(effectiveOutDir, outputsPrefix), { recursive: true });

  function exec(
    cmd: string,
    args: string[]
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      p.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
      p.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
      p.on("close", (code) =>
        resolve({ code: (code ?? 1) as number, stdout, stderr })
      );
    });
  }

  const ctx: StepContext = {
    uploadId,
    input: { bucket: "local", key: inputLocalPath },
    inputLocalPath,
    output: { bucket: outputBucket, prefix: outputsPrefix },
    branch,
    awsRegion: cfg.region,
    tmpDir,
    utils: {
      execFF: (args) => exec("ffmpeg", args),
      execProbe: (args) => exec("ffprobe", args),
      uploadResult: async (local, key, _ct) => {
        const dest = path
          .join(effectiveOutDir, outputsPrefix, key)
          .replace(/\\/g, "/");
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(local, dest);
        return { bucket: outputBucket, key: `${outputsPrefix}${key}` };
      },
      generateKey: (basename) => `${outputsPrefix}${basename}`,
      publish: async (message) => {
        // eslint-disable-next-line no-console
        console.log(`[local:run]`, JSON.stringify(message));
      },
    },
  };

  for (const step of tpl.steps) {
    // eslint-disable-next-line no-console
    console.log(`[local:run] step:start ${step.name}`);
    await step.run(ctx);
    // eslint-disable-next-line no-console
    console.log(`[local:run] step:done ${step.name}`);
  }

  return { outputsDir: path.join(effectiveOutDir, outputsPrefix) };
}

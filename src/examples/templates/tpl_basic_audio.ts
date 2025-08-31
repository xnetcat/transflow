import fs from "fs";
import path from "path";
import type { TemplateDefinition, StepContext } from "../../core/types";

async function runProbe(ctx: StepContext) {
  const { code, stdout } = await ctx.utils.execProbe(["-i", ctx.inputLocalPath, "-hide_banner", "-f", "ffmetadata", "-"]);
  if (code !== 0) throw new Error("ffprobe failed");
  await ctx.utils.publish({ type: "ffprobe", stdout });
}

async function makePreview(ctx: StepContext) {
  const out = path.join(ctx.tmpDir, "preview.mp3");
  const args = ["-i", ctx.inputLocalPath, "-t", "30", "-acodec", "libmp3lame", out];
  const { code, stderr } = await ctx.utils.execFF(args);
  if (code !== 0) throw new Error(`ffmpeg failed: ${stderr}`);
  await ctx.utils.uploadResult(out, "preview.mp3", "audio/mpeg");
}

const tpl: TemplateDefinition = {
  id: "tpl_basic_audio",
  steps: [
    { name: "ffprobe", run: runProbe },
    { name: "preview", run: makePreview }
  ]
};

export default tpl;


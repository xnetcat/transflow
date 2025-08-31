import path from "path";
import type { TemplateDefinition, StepContext } from "@xnetcat/transflow";

async function makePreview(ctx: StepContext) {
  const out = path.join(ctx.tmpDir, "preview.mp3");
  const args = [
    "-i",
    ctx.inputLocalPath,
    "-t",
    "30",
    "-acodec",
    "libmp3lame",
    "-y",
    out,
  ];
  const { code, stderr } = await ctx.utils.execFF(args);
  if (code !== 0) throw new Error(`ffmpeg failed: ${stderr}`);
  await ctx.utils.uploadResult(out, "preview.mp3", "audio/mpeg");
}

const tpl: TemplateDefinition = {
  id: "tpl_basic_audio",
  steps: [{ name: "preview", run: makePreview }],
};
export default tpl;

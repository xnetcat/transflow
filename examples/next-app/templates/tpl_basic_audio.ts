import path from "path";
import type { TemplateDefinition, StepContext } from "@xnetcat/transflow";
import config from "../transflow.config";

async function makePreview(ctx: StepContext) {
  const inputFiles = ctx.inputsLocalPaths;
  if (inputFiles.length < 1) throw new Error("Expected 1 or more input files");
  for (const inputFile of inputFiles) {
    const out = path.join(
      ctx.tmpDir,
      `preview_${path.basename(inputFile)}.mp3`
    );
    const args = [
      "-i",
      inputFile,
      "-t",
      "30",
      "-acodec",
      "libmp3lame",
      "-y",
      out,
    ];
    const { code, stderr } = await ctx.utils.execFF(args);
    if (code !== 0) throw new Error(`ffmpeg failed: ${stderr}`);
    console.log(
      "[template:tpl_basic_audio] uploading result to output bucket",
      ctx.output.bucket
    );

    // 30s preview saved to output bucket
    const preview = await ctx.utils.exportToBucket(
      out,
      `preview_${path.basename(inputFile)}.mp3`,
      config.s3.exportBuckets[0],
      "audio/mpeg"
    );

    // master file (original file) saved to output bucket (same file name)
    const masterFile = await ctx.utils.exportToBucket(
      inputFile,
      path.basename(inputFile),
      config.s3.exportBuckets[0],
      "audio/mpeg"
    );

    console.log(
      "[template:tpl_basic_audio] preview saved to output bucket",
      preview
    );

    console.log(
      "[template:tpl_basic_audio] master file saved to output bucket",
      masterFile
    );
  }
}

const tpl: TemplateDefinition = {
  id: "tpl_basic_audio",
  steps: [{ name: "preview", run: makePreview }],
};
export default tpl;

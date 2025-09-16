import path from "path";
import type { TemplateDefinition, StepContext } from "@xnetcat/transflow";
import config from "../transflow.config";

async function exportEcho(ctx: StepContext) {
  const out = path.join(ctx.tmpDir, `echo_${Date.now()}.txt`);
  await ctx.utils.execFF(["-version"]); // lightweight call to ensure ffmpeg exists
  await Bun.write(out, "Hello from Transflow!\n");
  await ctx.utils.exportToBucket(
    out,
    path.basename(out),
    config.s3.exportBuckets[0],
    "text/plain"
  );
}

const tpl: TemplateDefinition = {
  id: "tpl_export_example",
  steps: [{ name: "export", run: exportEcho }],
};
export default tpl;

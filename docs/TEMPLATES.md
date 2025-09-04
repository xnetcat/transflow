# Template Authoring Guide

Templates are the heart of Transflow - TypeScript files that define custom media processing pipelines using ffmpeg, ffprobe, and other tools.

## Template Structure

Every template exports a `TemplateDefinition` object:

```ts
import type { TemplateDefinition, StepContext } from "@xnetcat/transflow";

export default {
  id: "my-template",
  outputPrefix: "custom/path/", // optional
  outputBucket: "custom-bucket", // optional
  steps: [
    {
      name: "step1",
      run: async (ctx) => {
        /* ... */
      },
    },
    {
      name: "step2",
      run: async (ctx) => {
        /* ... */
      },
    },
  ],
} as TemplateDefinition;
```

## StepContext API

Each step function receives a `StepContext` with utilities and metadata:

### Input Information

```ts
interface StepContext {
  // Single file upload
  input: { bucket: string; key: string; contentType?: string };
  inputLocalPath: string; // /tmp/downloaded-file.ext

  // Multi-file uploads (when applicable)
  inputs?: Array<{ bucket: string; key: string; contentType?: string }>;
  inputsLocalPaths?: string[]; // ["/tmp/file1.ext", "/tmp/file2.ext"]

  // Output configuration
  output: { bucket: string; prefix: string }; // where results go

  // Context
  uploadId: string; // unique upload identifier
  branch: string; // git branch name
  awsRegion: string; // AWS region
  tmpDir: string; // /tmp/transflow-xxxxx/

  // Custom metadata from client
  fields?: Record<string, string>; // arbitrary key-value pairs

  utils: StepContextUtils; // utility functions
}
```

### Utility Functions

#### Media Processing

```ts
// Execute ffmpeg command
const { code, stdout, stderr } = await ctx.utils.execFF([
  "-i",
  ctx.inputLocalPath,
  "-t",
  "30",
  "-acodec",
  "libmp3lame",
  `${ctx.tmpDir}/output.mp3`,
]);

// Execute ffprobe command
const { code, stdout, stderr } = await ctx.utils.execProbe([
  "-i",
  ctx.inputLocalPath,
  "-hide_banner",
  "-print_format",
  "json",
  "-show_format",
]);
```

#### File Output

```ts
// Upload single result file
await ctx.utils.uploadResult(
  `${ctx.tmpDir}/output.mp3`, // local file path
  "preview.mp3", // destination key (relative to output prefix)
  "audio/mpeg" // content type (optional)
);

// Upload multiple results (if available)
await ctx.utils.uploadResults?.([
  {
    localPath: `${ctx.tmpDir}/thumb.jpg`,
    key: "thumbnail.jpg",
    contentType: "image/jpeg",
  },
  {
    localPath: `${ctx.tmpDir}/preview.mp4`,
    key: "preview.mp4",
    contentType: "video/mp4",
  },
]);
```

#### Progress & Communication

```ts
// Publish custom progress message
await ctx.utils.publish({
  type: "progress",
  message: "Starting video analysis...",
  percent: 25,
});

// Generate output key with prefix
const outputKey = ctx.utils.generateKey("thumbnail.jpg");
// Returns: "outputs/branch/uploadId/thumbnail.jpg"
```

## Example Templates

### Basic Audio Preview

```ts
import type { TemplateDefinition, StepContext } from "@xnetcat/transflow";

async function runProbe(ctx: StepContext) {
  const { code, stdout } = await ctx.utils.execProbe([
    "-i",
    ctx.inputLocalPath,
    "-hide_banner",
    "-f",
    "ffmetadata",
    "-",
  ]);
  if (code !== 0) throw new Error("ffprobe failed");
  await ctx.utils.publish({ type: "ffprobe", stdout });
}

async function makePreview(ctx: StepContext) {
  const outputPath = `${ctx.tmpDir}/preview.mp3`;
  const args = [
    "-i",
    ctx.inputLocalPath,
    "-t",
    "30", // 30 second preview
    "-acodec",
    "libmp3lame",
    "-ab",
    "128k", // 128kbps bitrate
    "-y", // overwrite output
    outputPath,
  ];

  const { code, stderr } = await ctx.utils.execFF(args);
  if (code !== 0) throw new Error(`ffmpeg failed: ${stderr}`);

  await ctx.utils.uploadResult(outputPath, "preview.mp3", "audio/mpeg");
}

export default {
  id: "tpl_basic_audio",
  steps: [
    { name: "ffprobe", run: runProbe },
    { name: "preview", run: makePreview },
  ],
} as TemplateDefinition;
```

### Video Transcoding with Thumbnails

```ts
import type { TemplateDefinition, StepContext } from "@xnetcat/transflow";

async function generateThumbnail(ctx: StepContext) {
  // Extract thumbnail at 10% into the video
  const thumbnailPath = `${ctx.tmpDir}/thumbnail.jpg`;
  const { code, stderr } = await ctx.utils.execFF([
    "-i",
    ctx.inputLocalPath,
    "-ss",
    "00:00:05", // seek to 5 seconds
    "-vframes",
    "1", // extract 1 frame
    "-q:v",
    "2", // high quality
    "-y",
    thumbnailPath,
  ]);

  if (code !== 0) throw new Error(`Thumbnail failed: ${stderr}`);
  await ctx.utils.uploadResult(thumbnailPath, "thumbnail.jpg", "image/jpeg");
}

async function transcodeVideo(ctx: StepContext) {
  const outputPath = `${ctx.tmpDir}/compressed.mp4`;
  const { code, stderr } = await ctx.utils.execFF([
    "-i",
    ctx.inputLocalPath,
    "-c:v",
    "libx264", // H.264 codec
    "-preset",
    "medium", // encoding speed
    "-crf",
    "23", // quality (lower = better)
    "-c:a",
    "aac", // audio codec
    "-b:a",
    "128k", // audio bitrate
    "-movflags",
    "+faststart", // web optimization
    "-y",
    outputPath,
  ]);

  if (code !== 0) throw new Error(`Transcode failed: ${stderr}`);
  await ctx.utils.uploadResult(outputPath, "compressed.mp4", "video/mp4");
}

export default {
  id: "video-compress",
  steps: [
    { name: "thumbnail", run: generateThumbnail },
    { name: "transcode", run: transcodeVideo },
  ],
} as TemplateDefinition;
```

### Multi-file Processing

```ts
import type { TemplateDefinition, StepContext } from "@xnetcat/transflow";

async function combineAudio(ctx: StepContext) {
  if (!ctx.inputsLocalPaths || ctx.inputsLocalPaths.length < 2) {
    throw new Error("At least 2 audio files required");
  }

  // Create filter complex for mixing multiple audio inputs
  const inputs = ctx.inputsLocalPaths
    .map((_, i) => `-i "${ctx.inputsLocalPaths![i]}"`)
    .join(" ");
  const filterComplex =
    ctx.inputsLocalPaths.map((_, i) => `[${i}:a]`).join("") +
    `amix=inputs=${ctx.inputsLocalPaths.length}:duration=longest[out]`;

  const outputPath = `${ctx.tmpDir}/mixed.mp3`;
  const { code, stderr } = await ctx.utils.execFF([
    ...ctx.inputsLocalPaths.flatMap((path) => ["-i", path]),
    "-filter_complex",
    filterComplex,
    "-map",
    "[out]",
    "-acodec",
    "libmp3lame",
    "-y",
    outputPath,
  ]);

  if (code !== 0) throw new Error(`Mix failed: ${stderr}`);
  await ctx.utils.uploadResult(outputPath, "mixed.mp3", "audio/mpeg");
}

export default {
  id: "audio-mixer",
  steps: [{ name: "mix", run: combineAudio }],
} as TemplateDefinition;
```

### Using Custom Fields

```ts
import type { TemplateDefinition, StepContext } from "@xnetcat/transflow";

async function customPreview(ctx: StepContext) {
  // Extract custom parameters from client
  const startTime = ctx.fields?.startTime || "0";
  const duration = ctx.fields?.duration || "30";
  const quality = ctx.fields?.quality || "medium";

  const preset = quality === "high" ? "slow" : "medium";
  const crf = quality === "high" ? "18" : "23";

  const outputPath = `${ctx.tmpDir}/preview.mp4`;
  const { code, stderr } = await ctx.utils.execFF([
    "-ss",
    startTime, // start time from client
    "-i",
    ctx.inputLocalPath,
    "-t",
    duration, // duration from client
    "-c:v",
    "libx264",
    "-preset",
    preset, // quality-based preset
    "-crf",
    crf, // quality-based CRF
    "-c:a",
    "aac",
    "-y",
    outputPath,
  ]);

  if (code !== 0) throw new Error(`Preview failed: ${stderr}`);
  await ctx.utils.uploadResult(outputPath, "preview.mp4", "video/mp4");
}

export default {
  id: "custom-preview",
  steps: [{ name: "preview", run: customPreview }],
} as TemplateDefinition;
```

## Best Practices

### Error Handling

```ts
async function robustStep(ctx: StepContext) {
  try {
    const { code, stderr } = await ctx.utils.execFF([
      /* args */
    ]);
    if (code !== 0) {
      throw new Error(`ffmpeg failed with code ${code}: ${stderr}`);
    }
  } catch (error) {
    // Log additional context before re-throwing
    await ctx.utils.publish({
      type: "error",
      step: "robustStep",
      message: error.message,
      input: ctx.input.key,
    });
    throw error;
  }
}
```

### Progress Reporting

```ts
async function longRunningStep(ctx: StepContext) {
  await ctx.utils.publish({
    type: "progress",
    message: "Starting analysis...",
    percent: 0,
  });

  // Step 1
  await someOperation();
  await ctx.utils.publish({
    type: "progress",
    message: "Analysis complete",
    percent: 33,
  });

  // Step 2
  await anotherOperation();
  await ctx.utils.publish({
    type: "progress",
    message: "Processing video...",
    percent: 66,
  });

  // Step 3
  await finalOperation();
  await ctx.utils.publish({
    type: "progress",
    message: "Upload complete",
    percent: 100,
  });
}
```

### File Management

```ts
async function cleanStep(ctx: StepContext) {
  const tempFiles: string[] = [];

  try {
    // Create temp files
    const temp1 = `${ctx.tmpDir}/intermediate1.mp4`;
    const temp2 = `${ctx.tmpDir}/intermediate2.mp4`;
    tempFiles.push(temp1, temp2);

    // Process...

    // Upload final result
    await ctx.utils.uploadResult(temp2, "final.mp4", "video/mp4");
  } finally {
    // Cleanup temp files (optional - Lambda cleans /tmp automatically)
    tempFiles.forEach((file) => {
      try {
        fs.unlinkSync(file);
      } catch {}
    });
  }
}
```

### Dynamic Output Paths

```ts
async function organizerStep(ctx: StepContext) {
  const timestamp = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const baseName = path.basename(ctx.input.key, path.extname(ctx.input.key));

  // Organize outputs by date and original filename
  await ctx.utils.uploadResult(
    `${ctx.tmpDir}/processed.mp4`,
    `${timestamp}/${baseName}/processed.mp4`,
    "video/mp4"
  );
}
```

## Available Tools

Templates run in a Lambda container with:

- **Node.js 20** - Latest LTS runtime
- **ffmpeg/ffprobe** - Static builds with full codec support
- **libvips** - Image processing library (for sharp)
- **AWS SDK v3** - S3, DynamoDB clients pre-installed
- **ioredis** - Redis client for progress publishing

## Template Organization

```
templates/
├── audio/
│   ├── preview.ts
│   ├── normalize.ts
│   └── transcribe.ts
├── video/
│   ├── compress.ts
│   ├── thumbnail.ts
│   └── watermark.ts
└── image/
    ├── resize.ts
    ├── optimize.ts
    └── convert.ts
```

Templates are automatically discovered by filename and compiled during the bake process. Use descriptive names and organize by media type or use case.

## Local Testing

Test templates locally before deployment:

```bash
# Bake templates first
npx transflow bake --config transflow.config.js

# Run specific template on local file
npx transflow local:run \
  --config transflow.config.js \
  --file ./test-media/sample.mp4 \
  --template video-compress \
  --out ./local-outputs

# Results written to ./local-outputs/
```

Local testing requires `ffmpeg` and `ffprobe` installed on your system. The runtime environment matches the Lambda container as closely as possible.

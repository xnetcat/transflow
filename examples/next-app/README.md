### Transflow Next.js example — minimal deploy steps

Prereqs:

- Docker and AWS CLI installed and logged in (env vars or profile)
- An IAM role for the Lambda function (set its ARN in `transflow.config.json`)

1. Install deps

```bash
npm install
```

2. Configure `transflow.config.json`

- Set your `region`
- Set `lambda.roleArn` (Lambda execution role)
- Optionally adjust `s3.uploadBucket` and `s3.outputBucket`
- Set Redis connection (`redis.restUrl`/`token` or `REDIS_URL` at runtime)

3. Bake templates

```bash
npm run bake
```

4. Deploy per branch (example uses a local tag)

```bash
npm run deploy
# or directly
npx transflow deploy --branch feature-demo --sha $(git rev-parse --short HEAD) --config transflow.config.json --yes
```

Notes:

- The deploy step builds a Lambda container image, pushes to ECR, creates/updates the branch Lambda, ensures S3 buckets/notifications, and sets env vars.
- Use `npx transflow cleanup --branch <branch> --config transflow.config.json --yes` to remove the Lambda and notifications when done.

Optional (local run):

```bash
npx transflow bake --config transflow.config.json
npx transflow local:run --config transflow.config.json --file ./path/to/media.wav --template tpl_basic_audio --out ./local-out
```

App usage:

- Start Next.js: `npm run dev`
- Open `http://localhost:3000` and upload a file; the app uses `/api/create-upload` for a presigned URL and subscribes to `/api/stream` for progress.

import { LambdaClient, DeleteFunctionCommand } from "@aws-sdk/client-lambda";
import {
  ECRClient,
  DescribeImagesCommand,
  BatchDeleteImageCommand,
} from "@aws-sdk/client-ecr";
import {
  S3Client,
  PutBucketNotificationConfigurationCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";
import type { TransflowConfig } from "../../core/types";

interface CleanupArgs {
  cfg: TransflowConfig;
  branch: string;
  nonInteractive: boolean;
  deleteStorage: boolean;
  deleteEcrImages: boolean;
}

export async function cleanup(args: CleanupArgs) {
  const { cfg, branch, deleteStorage, deleteEcrImages } = args;
  const region = cfg.region;
  const lambda = new LambdaClient({ region });
  const ecr = new ECRClient({ region });
  const s3 = new S3Client({ region });

  const functionName = `${cfg.lambdaPrefix}${branch}`;
  try {
    await lambda.send(
      new DeleteFunctionCommand({ FunctionName: functionName })
    );
  } catch {}

  // Remove S3 notifications (idempotent) - setting empty configuration
  if (cfg.s3.mode === "prefix" && cfg.s3.uploadBucket) {
    try {
      await s3.send(
        new PutBucketNotificationConfigurationCommand({
          Bucket: cfg.s3.uploadBucket,
          NotificationConfiguration: {},
        })
      );
    } catch {}
  }

  if (deleteStorage) {
    if (cfg.s3.mode === "prefix" && cfg.s3.uploadBucket) {
      const prefix = `uploads/${branch}/`;
      let token: string | undefined = undefined;
      do {
        const listed: {
          Contents?: { Key?: string }[];
          IsTruncated?: boolean;
          NextContinuationToken?: string;
        } = await s3.send(
          new ListObjectsV2Command({
            Bucket: cfg.s3.uploadBucket,
            Prefix: prefix,
            ContinuationToken: token,
          })
        );
        const objects = (listed.Contents ?? []).map((o: { Key?: string }) => ({
          Key: o.Key!,
        }));
        if (objects.length > 0) {
          await s3.send(
            new DeleteObjectsCommand({
              Bucket: cfg.s3.uploadBucket,
              Delete: { Objects: objects },
            })
          );
        }
        token = listed.IsTruncated ? listed.NextContinuationToken : undefined;
      } while (token);
    }
  }

  if (deleteEcrImages) {
    try {
      const desc = await ecr.send(
        new DescribeImagesCommand({ repositoryName: cfg.ecrRepo })
      );
      const images = (desc.imageDetails ?? []).flatMap((d) =>
        (d.imageTags ?? [])
          .filter((t) => t.startsWith(`${branch}-`))
          .map((t) => ({ imageTag: t }))
      );
      if (images.length) {
        await ecr.send(
          new BatchDeleteImageCommand({
            repositoryName: cfg.ecrRepo,
            imageIds: images,
          })
        );
      }
    } catch {}
  }
}

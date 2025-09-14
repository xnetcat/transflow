import { LambdaClient, DeleteFunctionCommand } from "@aws-sdk/client-lambda";
import {
  ECRClient,
  DescribeImagesCommand,
  BatchDeleteImageCommand,
} from "@aws-sdk/client-ecr";
import {
  S3Client,
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

  // Note: We're using shared Lambda functions now, so we don't delete per-branch Lambda functions
  // The main Lambda function is shared across all branches and should not be deleted during branch cleanup
  console.log(`🧹 Cleaning up branch: ${branch}`);
  console.log(
    "ℹ️  Note: Lambda functions (processing & status), SQS queues, and DynamoDB table are shared resources and won't be deleted"
  );

  // Only clean up S3 objects by prefix if requested
  if (deleteStorage) {
    console.log("🗑️  Cleaning up S3 objects...");

    if (cfg.s3.mode === "prefix" && cfg.s3.uploadBucket) {
      const prefix = `uploads/${branch}/`;
      await cleanupS3Prefix(s3, cfg.s3.uploadBucket, prefix);
      console.log(`🗑️  Cleaned upload objects for branch ${branch}`);
    }

    if (cfg.s3.mode === "prefix" && cfg.s3.outputBucket) {
      const prefix = `outputs/${branch}/`;
      await cleanupS3Prefix(s3, cfg.s3.outputBucket, prefix);
      console.log(`🗑️  Cleaned output objects for branch ${branch}`);
    }

    // For explicit bucket mode, clean up all buckets listed in config
    if (cfg.s3.buckets) {
      for (const bucket of cfg.s3.buckets) {
        try {
          const uploadPrefix = `uploads/${branch}/`;
          const outputPrefix = `outputs/${branch}/`;

          // Clean upload prefix
          await cleanupS3Prefix(s3, bucket, uploadPrefix);
          // Clean output prefix
          await cleanupS3Prefix(s3, bucket, outputPrefix);

          console.log(
            `🗑️  Cleaned branch ${branch} objects from bucket ${bucket}`
          );
        } catch (error) {
          console.warn(`⚠️  Failed to clean bucket ${bucket}: ${error}`);
        }
      }
    }
  }

  // Clean up ECR images for this branch if requested
  if (deleteEcrImages) {
    console.log("🗑️  Cleaning up ECR images...");
    try {
      const images = await ecr.send(
        new DescribeImagesCommand({
          repositoryName: cfg.ecrRepo,
          imageIds: [{ imageTag: branch }],
        })
      );

      if (images.imageDetails && images.imageDetails.length > 0) {
        await ecr.send(
          new BatchDeleteImageCommand({
            repositoryName: cfg.ecrRepo,
            imageIds: [{ imageTag: branch }],
          })
        );
        console.log(`🗑️  Deleted ECR image with tag: ${branch}`);
      }
    } catch (error) {
      console.warn(`⚠️  ECR image cleanup failed: ${error}`);
    }
  }

  console.log(`✅ Branch cleanup complete for: ${branch}`);
}

async function cleanupS3Prefix(s3: S3Client, bucket: string, prefix: string) {
  let token: string | undefined = undefined;
  do {
    const listed: {
      Contents?: { Key?: string }[];
      IsTruncated?: boolean;
      NextContinuationToken?: string;
    } = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: token,
      })
    );
    if (listed.Contents && listed.Contents.length > 0) {
      await s3.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: {
            Objects: listed.Contents.map((o) => ({ Key: o.Key! })),
          },
        })
      );
    }
    token = listed.NextContinuationToken;
  } while (token);
}

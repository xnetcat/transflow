/*
  IAM policy management for Transflow SQS resources
*/

import {
  IAMClient,
  CreatePolicyCommand,
  AttachRolePolicyCommand,
  DetachRolePolicyCommand,
  DeletePolicyCommand,
  GetPolicyCommand,
} from "@aws-sdk/client-iam";

export interface SQSPolicyConfig {
  accountId: string;
  region: string;
  project: string;
  branch: string;
  lambdaRoleName: string;
  bridgeRoleName: string;
}

export function generateSQSPolicy(config: SQSPolicyConfig) {
  const { accountId, region, project, branch } = config;

  return {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: [
          "sqs:ReceiveMessage",
          "sqs:DeleteMessage",
          "sqs:GetQueueAttributes",
          "sqs:GetQueueUrl",
        ],
        Resource: [
          `arn:aws:sqs:${region}:${accountId}:${project}-${branch}-processing.fifo`,
          `arn:aws:sqs:${region}:${accountId}:${project}-${branch}-progress.fifo`,
        ],
      },
      {
        Effect: "Allow",
        Action: [
          "sqs:SendMessage",
          "sqs:GetQueueAttributes",
          "sqs:GetQueueUrl",
        ],
        Resource: [
          `arn:aws:sqs:${region}:${accountId}:${project}-${branch}-processing.fifo`,
          `arn:aws:sqs:${region}:${accountId}:${project}-${branch}-progress.fifo`,
          `arn:aws:sqs:${region}:${accountId}:${project}-${branch}-dlq.fifo`,
        ],
      },
    ],
  };
}

export async function createSQSPolicy(
  iam: IAMClient,
  config: SQSPolicyConfig
): Promise<string> {
  const policyName = `${config.project}-${config.branch}-sqs-policy`;
  const policyDocument = JSON.stringify(generateSQSPolicy(config));

  try {
    // Try to create the policy
    const result = await iam.send(
      new CreatePolicyCommand({
        PolicyName: policyName,
        PolicyDocument: policyDocument,
        Description: `SQS access policy for Transflow ${config.project} branch ${config.branch}`,
      })
    );

    const policyArn = result.Policy?.Arn;
    if (!policyArn) {
      throw new Error("Failed to get policy ARN");
    }

    console.log(`✅ Created SQS policy: ${policyName}`);
    return policyArn;
  } catch (error: any) {
    if (error.name === "EntityAlreadyExistsException") {
      // Policy already exists, get its ARN
      const policyArn = `arn:aws:iam::${config.accountId}:policy/${policyName}`;
      console.log(`✅ Using existing SQS policy: ${policyName}`);
      return policyArn;
    }
    throw error;
  }
}

export async function attachSQSPolicy(
  iam: IAMClient,
  policyArn: string,
  roleName: string
): Promise<void> {
  try {
    await iam.send(
      new AttachRolePolicyCommand({
        RoleName: roleName,
        PolicyArn: policyArn,
      })
    );
    console.log(`✅ Attached SQS policy to role: ${roleName}`);
  } catch (error: any) {
    if (error.name !== "EntityAlreadyExistsException") {
      console.warn(
        `⚠️  Warning: Failed to attach policy to ${roleName}: ${error.message}`
      );
    }
  }
}

export async function detachSQSPolicy(
  iam: IAMClient,
  policyArn: string,
  roleName: string
): Promise<void> {
  try {
    await iam.send(
      new DetachRolePolicyCommand({
        RoleName: roleName,
        PolicyArn: policyArn,
      })
    );
    console.log(`✅ Detached SQS policy from role: ${roleName}`);
  } catch (error: any) {
    if (error.name !== "NoSuchEntityException") {
      console.warn(
        `⚠️  Warning: Failed to detach policy from ${roleName}: ${error.message}`
      );
    }
  }
}

export async function deleteSQSPolicy(
  iam: IAMClient,
  config: SQSPolicyConfig
): Promise<void> {
  const policyName = `${config.project}-${config.branch}-sqs-policy`;
  const policyArn = `arn:aws:iam::${config.accountId}:policy/${policyName}`;

  try {
    // First detach from all roles
    await detachSQSPolicy(iam, policyArn, config.lambdaRoleName);
    await detachSQSPolicy(iam, policyArn, config.bridgeRoleName);

    // Then delete the policy
    await iam.send(
      new DeletePolicyCommand({
        PolicyArn: policyArn,
      })
    );
    console.log(`✅ Deleted SQS policy: ${policyName}`);
  } catch (error: any) {
    if (error.name !== "NoSuchEntityException") {
      console.warn(
        `⚠️  Warning: Failed to delete SQS policy ${policyName}: ${error.message}`
      );
    }
  }
}

export async function policyExists(
  iam: IAMClient,
  config: SQSPolicyConfig
): Promise<boolean> {
  const policyArn = `arn:aws:iam::${config.accountId}:policy/${config.project}-${config.branch}-sqs-policy`;

  try {
    await iam.send(new GetPolicyCommand({ PolicyArn: policyArn }));
    return true;
  } catch {
    return false;
  }
}



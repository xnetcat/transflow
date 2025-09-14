import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import type {
  StatusLambdaEvent,
  StatusLambdaResponse,
} from "../lambda/statusHandler";
import type { AssemblyStatus } from "../core/types";

export interface StatusClientConfig {
  region: string;
  functionName: string;
  awsProfile?: string;
}

export interface StatusCheckOptions {
  assemblyId: string;
  userId?: string;
  triggerWebhook?: boolean;
}

export interface StatusCheckResult {
  success: boolean;
  status?: AssemblyStatus;
  error?: string;
  statusCode?: number;
}

export class StatusLambdaClient {
  private lambda: LambdaClient;
  private functionName: string;

  constructor(config: StatusClientConfig) {
    this.lambda = new LambdaClient({
      region: config.region,
      ...(config.awsProfile && { profile: config.awsProfile }),
    });
    this.functionName = config.functionName;
  }

  async checkStatus(options: StatusCheckOptions): Promise<StatusCheckResult> {
    const event: StatusLambdaEvent = {
      assemblyId: options.assemblyId,
      userId: options.userId,
      triggerWebhook: options.triggerWebhook,
    };

    try {
      const response = await this.lambda.send(
        new InvokeCommand({
          FunctionName: this.functionName,
          Payload: JSON.stringify(event),
          InvocationType: "RequestResponse",
        })
      );

      if (!response.Payload) {
        return {
          success: false,
          error: "No response payload from Lambda",
        };
      }

      const payloadString = Buffer.from(response.Payload).toString();
      const lambdaResponse: StatusLambdaResponse = JSON.parse(payloadString);

      if (lambdaResponse.statusCode === 200) {
        const status: AssemblyStatus = JSON.parse(lambdaResponse.body);
        return {
          success: true,
          status,
          statusCode: lambdaResponse.statusCode,
        };
      } else {
        const errorBody = JSON.parse(lambdaResponse.body);
        return {
          success: false,
          error: errorBody.error || "Unknown error",
          statusCode: lambdaResponse.statusCode,
        };
      }
    } catch (error) {
      return {
        success: false,
        error:
          error instanceof Error ? error.message : "Unknown error occurred",
      };
    }
  }

  /**
   * Convenience method to just get the status without webhook trigger
   */
  async getStatus(
    assemblyId: string,
    userId?: string
  ): Promise<StatusCheckResult> {
    return this.checkStatus({ assemblyId, userId, triggerWebhook: false });
  }

  /**
   * Convenience method to get status and trigger webhook
   */
  async getStatusWithWebhook(
    assemblyId: string,
    userId?: string
  ): Promise<StatusCheckResult> {
    return this.checkStatus({ assemblyId, userId, triggerWebhook: true });
  }
}

/**
 * Factory function to create a status client from Transflow config
 */
export function createStatusClient(config: {
  region: string;
  project: string;
  statusLambda?: { functionName?: string };
  awsProfile?: string;
}): StatusLambdaClient | null {
  if (!config.statusLambda) {
    return null;
  }

  const functionName =
    config.statusLambda.functionName || `${config.project}-status`;

  return new StatusLambdaClient({
    region: config.region,
    functionName,
    awsProfile: config.awsProfile,
  });
}

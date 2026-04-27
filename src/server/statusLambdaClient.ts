import { InvokeCommand } from "@aws-sdk/client-lambda";
import type {
  StatusLambdaEvent,
  StatusLambdaResponse,
} from "../lambda/statusHandler";
import type { AssemblyStatus, TransflowConfig } from "../core/types";
import { makeLambdaClient } from "../core/awsClients";

export interface StatusClientConfig {
  region: string;
  functionName: string;
  awsProfile?: string;
  endpoint?: string;
  credentials?: TransflowConfig["credentials"];
}

export interface StatusCheckOptions {
  assemblyId: string;
  triggerWebhook?: boolean;
}

export interface StatusCheckResult {
  success: boolean;
  status?: AssemblyStatus;
  error?: string;
  statusCode?: number;
}

export class StatusLambdaClient {
  private lambda;
  private functionName: string;

  constructor(config: StatusClientConfig) {
    this.lambda = makeLambdaClient(
      { region: config.region, endpoint: config.endpoint, credentials: config.credentials } as Partial<TransflowConfig>
    );
    this.functionName = config.functionName;
  }

  async checkStatus(options: StatusCheckOptions): Promise<StatusCheckResult> {
    const event: StatusLambdaEvent = {
      assemblyId: options.assemblyId,
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
        return { success: false, error: "No response payload from Lambda" };
      }

      const payloadString = Buffer.from(response.Payload).toString();
      const lambdaResponse: StatusLambdaResponse = JSON.parse(payloadString);

      if (lambdaResponse.statusCode === 200) {
        return {
          success: true,
          status: JSON.parse(lambdaResponse.body) as AssemblyStatus,
          statusCode: lambdaResponse.statusCode,
        };
      }
      const errorBody = JSON.parse(lambdaResponse.body);
      return {
        success: false,
        error: errorBody.error || "Unknown error",
        statusCode: lambdaResponse.statusCode,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error occurred",
      };
    }
  }

  async getStatus(assemblyId: string): Promise<StatusCheckResult> {
    return this.checkStatus({ assemblyId, triggerWebhook: false });
  }

  async getStatusWithWebhook(assemblyId: string): Promise<StatusCheckResult> {
    return this.checkStatus({ assemblyId, triggerWebhook: true });
  }
}

/**
 * Build a status client from a TransflowConfig.
 * Status Lambda is always deployed with predictable name: {project}-status.
 */
export function createStatusClient(config: {
  region: string;
  project: string;
  awsProfile?: string;
  endpoint?: string;
  credentials?: TransflowConfig["credentials"];
}): StatusLambdaClient {
  return new StatusLambdaClient({
    region: config.region,
    functionName: `${config.project}-status`,
    awsProfile: config.awsProfile,
    endpoint: config.endpoint,
    credentials: config.credentials,
  });
}

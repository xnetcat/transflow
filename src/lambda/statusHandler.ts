import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { createHmac } from "crypto";
import type { AssemblyStatus, TemplateDefinition } from "../core/types";

export interface StatusLambdaEvent {
  assemblyId: string;
  userId?: string; // For authorization
  triggerWebhook?: boolean; // Optional webhook trigger
}

export interface StatusLambdaResponse {
  statusCode: number;
  body: string;
  headers?: Record<string, string>;
}

async function sendWebhookWithRetries(
  webhookUrl: string,
  payload: any,
  secret?: string,
  maxRetries = 3
): Promise<void> {
  const body = JSON.stringify(payload);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "Transflow-Status/1.0",
  };

  // Add HMAC signature if secret provided
  if (secret) {
    const signature = createHmac("sha256", secret).update(body).digest("hex");
    headers["X-Transflow-Signature"] = `sha256=${signature}`;
  }

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(webhookUrl, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(30000), // 30s timeout
      });

      if (response.ok) {
        console.log(`Status webhook sent successfully to ${webhookUrl}`);
        return;
      }

      if (response.status >= 400 && response.status < 500) {
        // Client error - don't retry
        throw new Error(
          `Webhook failed with client error: ${response.status} ${response.statusText}`
        );
      }

      // Server error - will retry
      throw new Error(
        `Webhook failed with server error: ${response.status} ${response.statusText}`
      );
    } catch (error) {
      console.error(`Webhook attempt ${attempt + 1} failed:`, error);

      if (attempt === maxRetries) {
        throw error; // Final attempt failed
      }

      // Exponential backoff: 1s, 2s, 4s
      const delay = Math.pow(2, attempt) * 1000;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

export const handler = async (
  event: StatusLambdaEvent
): Promise<StatusLambdaResponse> => {
  const region =
    process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";
  const tableName = process.env.DYNAMODB_TABLE;

  if (!tableName) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "DYNAMODB_TABLE not configured" }),
    };
  }

  if (!event.assemblyId) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "assemblyId is required" }),
    };
  }

  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));

  try {
    // Get assembly status from DynamoDB
    const result = await ddb.send(
      new GetCommand({
        TableName: tableName,
        Key: { assembly_id: event.assemblyId },
      })
    );

    if (!result.Item) {
      return {
        statusCode: 404,
        body: JSON.stringify({
          error: "Assembly not found",
          assembly_id: event.assemblyId,
        }),
      };
    }

    const assembly = result.Item as AssemblyStatus;

    // Authorization check - user can only access their own assemblies
    if (event.userId && assembly.user?.userId !== event.userId) {
      return {
        statusCode: 403,
        body: JSON.stringify({
          error: "Access denied: You don't own this assembly",
        }),
      };
    }

    // Trigger webhook if requested and configured
    if (event.triggerWebhook && assembly.template_id) {
      try {
        // Load template to get webhook configuration (path-agnostic)
        const candidates = [
          process.env.TEMPLATES_INDEX_PATH,
          "/var/task/templates.index.cjs",
          require("path").resolve(__dirname, "../../templates.index.cjs"),
          require("path").resolve(process.cwd(), "templates.index.cjs"),
        ].filter(Boolean) as string[];
        let index: any | undefined;
        for (const candidate of candidates) {
          try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            index = require(candidate);
            break;
          } catch {}
        }
        if (!index) throw new Error("Templates index not found");
        const mod = index[assembly.template_id];
        const template: TemplateDefinition | undefined = mod?.default;

        if (template?.webhookUrl) {
          console.log(`Triggering webhook for assembly ${event.assemblyId}`);
          await sendWebhookWithRetries(
            template.webhookUrl,
            assembly,
            template.webhookSecret
          );
        } else {
          console.log(
            `No webhook configured for template ${assembly.template_id}`
          );
        }
      } catch (webhookError) {
        console.error("Failed to send status webhook:", webhookError);
        // Don't fail the status request if webhook fails
      }
    }

    return {
      statusCode: 200,
      body: JSON.stringify(assembly),
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-cache",
      },
    };
  } catch (error) {
    console.error("Status lookup error:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "Failed to fetch assembly status",
        message: error instanceof Error ? error.message : "Unknown error",
      }),
    };
  }
};

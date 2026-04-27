import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { makeDynamoDocClient } from "../core/awsClients";
import { sendWebhookWithRetries } from "../core/webhook";
import type { AssemblyStatus, TemplateDefinition } from "../core/types";

export interface StatusLambdaEvent {
  assemblyId: string;
  triggerWebhook?: boolean;
}

export interface StatusLambdaResponse {
  statusCode: number;
  body: string;
  headers?: Record<string, string>;
}

export const handler = async (
  event: StatusLambdaEvent
): Promise<StatusLambdaResponse> => {
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

  const ddb = makeDynamoDocClient();

  try {
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

    if (event.triggerWebhook && assembly.template_id) {
      try {
        const candidates = [
          process.env.TEMPLATES_INDEX_PATH,
          "/var/task/templates.index.cjs",
          require("path").resolve(__dirname, "../../templates.index.cjs"),
          require("path").resolve(process.cwd(), "templates.index.cjs"),
        ].filter(Boolean) as string[];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const reqFunc: any = (globalThis as any).require || require;
        let index: any | undefined;
        for (const candidate of candidates) {
          try {
            index = reqFunc(candidate);
            break;
          } catch {}
        }
        if (!index) throw new Error("Templates index not found");
        const mod = index[assembly.template_id];
        const template: TemplateDefinition | undefined = mod?.default;

        if (template?.webhookUrl) {
          console.log(`Triggering webhook for assembly ${event.assemblyId}`);
          await sendWebhookWithRetries({
            url: template.webhookUrl,
            payload: assembly,
            secret: template.webhookSecret,
            userAgent: "Transflow-Status/1.0",
          });
        } else {
          console.log(
            `No webhook configured for template ${assembly.template_id}`
          );
        }
      } catch (webhookError) {
        console.error("Failed to send status webhook:", webhookError);
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

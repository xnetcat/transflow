import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import type { TransflowConfig, AssemblyStatus } from "../core/types";

export interface StatusRequest {
  query?: Record<string, string | string[]>;
  headers?: Record<string, string | string[] | undefined>;
  cookies?: Record<string, string>;
}

export interface StatusResponse {
  status: (code: number) => StatusResponse;
  json: (body: unknown) => void;
}

export function createStatusHandler(cfg: TransflowConfig) {
  const region =
    cfg.region ||
    process.env.AWS_REGION ||
    process.env.AWS_DEFAULT_REGION ||
    "us-east-1";
  const tableName = cfg.dynamoDb.tableName || process.env.DYNAMODB_TABLE || "";
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));

  return async function handler(req: StatusRequest, res: StatusResponse) {
    if (!tableName) {
      res
        .status(500)
        .json({ error: "Server not configured: DYNAMODB_TABLE missing" });
      return;
    }

    // No auth/ownership checks in no-auth mode

    const q = req.query || {};
    const idParam = q["assemblyId"] ?? q["assembly_id"];
    const assemblyId = Array.isArray(idParam)
      ? idParam[0]
      : (idParam as string | undefined);
    if (!assemblyId) {
      res.status(400).json({ error: "assemblyId required" });
      return;
    }

    try {
      const resp = await ddb.send(
        new GetCommand({
          TableName: tableName,
          Key: { assembly_id: assemblyId },
        })
      );
      if (!resp.Item) {
        res.status(404).json({ error: "Not found", assembly_id: assemblyId });
        return;
      }

      const assembly = resp.Item as AssemblyStatus;

      // No ownership enforcement

      res.status(200).json(assembly);
    } catch (error: any) {
      res
        .status(500)
        .json({ error: error?.message || "Failed to read status" });
    }
  };
}

import { GetCommand } from "@aws-sdk/lib-dynamodb";
import type { TransflowConfig, AssemblyStatus } from "../core/types";
import { makeDynamoDocClient } from "../core/awsClients";

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
  const tableName = cfg.dynamoDb.tableName || process.env.DYNAMODB_TABLE || "";
  const ddb = makeDynamoDocClient(cfg);

  return async function handler(req: StatusRequest, res: StatusResponse) {
    if (!tableName) {
      res
        .status(500)
        .json({ error: "Server not configured: DYNAMODB_TABLE missing" });
      return;
    }

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

      res.status(200).json(resp.Item as AssemblyStatus);
    } catch (error: any) {
      res
        .status(500)
        .json({ error: error?.message || "Failed to read status" });
    }
  };
}

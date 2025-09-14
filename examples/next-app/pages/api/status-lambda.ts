import type { NextApiRequest, NextApiResponse } from "next";
import { StatusLambdaClient } from "@xnetcat/transflow";
import config from "../../transflow.config";

// Create status Lambda client if enabled
const statusClient = config.statusLambda?.enabled
  ? new StatusLambdaClient({
      region: config.region,
      functionName:
        config.statusLambda.functionName || `${config.project}-status`,
    })
  : null;

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!statusClient) {
    return res.status(501).json({ error: "Status Lambda not enabled" });
  }

  const { assemblyId, triggerWebhook } = req.query;

  if (!assemblyId || typeof assemblyId !== "string") {
    return res.status(400).json({ error: "assemblyId is required" });
  }

  // In a real app, you'd extract userId from JWT/session
  // For demo purposes, we'll use a mock user
  const userId = "demo-user"; // TODO: Extract from authentication

  try {
    const result = await statusClient.checkStatus({
      assemblyId,
      userId,
      triggerWebhook: triggerWebhook === "true",
    });

    if (result.success) {
      res.status(200).json(result.status);
    } else {
      res.status(result.statusCode || 500).json({
        error: result.error || "Unknown error",
      });
    }
  } catch (error) {
    console.error("Status Lambda error:", error);
    res.status(500).json({
      error: "Failed to check status",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

export const config = {
  api: {
    bodyParser: false,
  },
};

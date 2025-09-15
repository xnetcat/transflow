import type { NextApiRequest, NextApiResponse } from "next";
import { createStatusHandler, type TransflowConfig } from "@xnetcat/transflow";
import transflowConfig from "../../transflow.config.js";

const handler = createStatusHandler(transflowConfig as TransflowConfig);

export default function api(req: NextApiRequest, res: NextApiResponse) {
  return handler(req as any, res as any);
}

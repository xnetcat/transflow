import type { NextApiRequest, NextApiResponse } from "next";
import { createStatusHandler } from "../../../src/web/createStatusHandler";
import config from "../../transflow.config.json";

const handler = createStatusHandler(config as any);

export default function api(req: NextApiRequest, res: NextApiResponse) {
  return handler(req as any, res as any);
}

import type { NextApiRequest, NextApiResponse } from "next";
import { createStatusHandler, type TransflowConfig } from "@xnetcat/transflow";
import cfg from "../../transflow.config";

const handler = createStatusHandler(cfg as TransflowConfig);

export default function api(req: NextApiRequest, res: NextApiResponse) {
  const t0 = Date.now();
  console.log("[status] incoming", { query: req.query });
  return handler(
    {
      query: req.query as any,
      headers: req.headers as any,
    } as any,
    {
      status(code: number) {
        res.status(code);
        return this as any;
      },
      json(body: unknown) {
        res.json(body);
        console.log("[status] response", {
          status: res.statusCode,
          elapsedMs: Date.now() - t0,
        });
      },
    } as any
  );
}

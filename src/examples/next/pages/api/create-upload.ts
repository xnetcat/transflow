import type { NextApiRequest, NextApiResponse } from "next";
import { createUploadHandler } from "../../../web/createUploadHandler";
import cfgJson from "../../../../assets/transflow.config.sample.json";
import type { TransflowConfig } from "../../../core/types";

const handler = createUploadHandler(cfgJson as TransflowConfig);
export default async function api(req: NextApiRequest, res: NextApiResponse) {
  return handler(req as unknown as any, {
    status(code: number) {
      res.status(code);
      return this as any;
    },
    json(body: unknown) {
      res.json(body);
    },
    setHeader(name: string, value: string) {
      res.setHeader(name, value);
    },
  });
}

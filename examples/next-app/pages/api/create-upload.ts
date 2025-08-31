import type { NextApiRequest, NextApiResponse } from "next";
import {
  createUploadHandler,
  type ApiRequest,
  type ApiResponse,
  type TransflowConfig,
} from "@xnetcat/transflow";
import cfg from "../../transflow.config.json";

const uploadHandler = createUploadHandler(cfg as TransflowConfig);

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const apiReq: ApiRequest = {
    method: req.method,
    body: req.body as Record<string, unknown>,
    headers: req.headers as Record<string, string | string[] | undefined>,
  };
  let apiRes: ApiResponse;
  apiRes = {
    status(code: number) {
      res.status(code);
      return apiRes;
    },
    json(body: unknown) {
      res.json(body);
    },
    setHeader(name: string, value: string) {
      res.setHeader(name, value);
    },
  };
  return uploadHandler(apiReq, apiRes);
}

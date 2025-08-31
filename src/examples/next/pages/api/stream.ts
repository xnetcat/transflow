import type { NextApiRequest, NextApiResponse } from "next";
import { createStreamHandler } from "../../../web/createStreamHandler";

const handler = createStreamHandler(
  process.env.REDIS_URL || "redis://localhost:6379"
);
export default async function api(req: NextApiRequest, res: NextApiResponse) {
  return handler(
    req as unknown as Parameters<typeof handler>[0],
    res as unknown as Parameters<typeof handler>[1]
  );
}

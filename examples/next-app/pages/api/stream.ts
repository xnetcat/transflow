import type { NextApiRequest, NextApiResponse } from "next";
import {
  createStreamHandler,
  type StreamRequest,
  type StreamResponse,
} from "@xnetcat/transflow";

const h = createStreamHandler(
  process.env.REDIS_URL || "redis://localhost:6379"
);
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const sreq: StreamRequest = {
    url: req.url || undefined,
    query: (req.query as Record<string, string | string[]>) || {},
    on: (event: string, cb: () => void) => {
      if (event === "close") {
        // Next.js closes automatically; this is a no-op binder
      }
    },
  };
  const sres: StreamResponse = {
    setHeader: (name: string, value: string) => res.setHeader(name, value),
    flushHeaders: () => {},
    write: (chunk: string) => {
      res.write(chunk);
    },
    end: () => res.end(),
    status: (code: number) => {
      res.status(code);
      return sres;
    },
  };
  return h(sreq, sres);
}

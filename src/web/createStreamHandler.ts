import Redis from "ioredis";

export interface StreamRequest {
  url?: string;
  query?: Record<string, string | string[]>;
  on: (event: string, cb: () => void) => void;
}

export interface StreamResponse {
  setHeader: (name: string, value: string) => void;
  flushHeaders?: () => void;
  write: (chunk: string) => void;
  end: () => void;
  status?: (code: number) => StreamResponse;
}

export function createStreamHandler(redisUrlOrFactory: string | (() => Redis)) {
  const factory =
    typeof redisUrlOrFactory === "string"
      ? () => new Redis(redisUrlOrFactory)
      : redisUrlOrFactory;
  return async function handler(req: StreamRequest, res: StreamResponse) {
    const q = req.query || {};
    const channelParam = q["channel"];
    const channel = Array.isArray(channelParam)
      ? channelParam[0]
      : channelParam || (req.url?.split("channel=")[1] ?? "");
    if (!channel) {
      res.status?.(400);
      res.end();
      return;
    }
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    const redis = factory();
    const sub = redis.duplicate();
    await sub.subscribe(channel);
    const heartbeat = setInterval(() => {
      res.write(`: ping\n\n`);
    }, 15000);
    sub.on("message", (_chan: string, message: string) => {
      res.write(`data: ${message}\n\n`);
    });
    req.on("close", async () => {
      clearInterval(heartbeat);
      try {
        await sub.unsubscribe(channel);
      } catch {}
      try {
        sub.disconnect();
      } catch {}
      try {
        redis.disconnect();
      } catch {}
      res.end();
    });
  };
}

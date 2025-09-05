import { describe, it, expect, vi } from "vitest";
import { createStreamHandler } from "./createStreamHandler";

describe("createStreamHandler", () => {
  it("writes SSE messages on Redis publish", async () => {
    const listeners: Record<string, Function[]> = {};
    const sub = {
      subscribe: vi.fn().mockResolvedValue(1),
      psubscribe: vi.fn().mockResolvedValue(1),
      on: vi.fn((event: string, cb: Function) => {
        listeners[event] = listeners[event] || [];
        listeners[event].push(cb);
      }),
      unsubscribe: vi.fn().mockResolvedValue(1),
      punsubscribe: vi.fn().mockResolvedValue(1),
      disconnect: vi.fn(),
    };
    const redis = {
      duplicate: () => sub,
      disconnect: vi.fn(),
    } as any;
    const handler = createStreamHandler(() => redis);
    let output = "";
    const req: any = {
      url: "/api/stream?channel=upload:main:1",
      query: { channel: "upload:main:1" },
      on: (ev: string, cb: Function) => {
        if (ev === "close") {
          setTimeout(() => cb(), 10);
        }
      },
    };
    const res: any = {
      setHeader: vi.fn(),
      flushHeaders: vi.fn(),
      write: (chunk: string) => {
        output += chunk;
      },
      end: vi.fn(),
      status: vi.fn().mockReturnThis(),
    };
    const p = handler(req, res);
    await new Promise((r) => setTimeout(r, 5));
    // simulate redis publish
    listeners["message"][0]("upload:main:1", JSON.stringify({ a: 1 }));
    await p;
    expect(output).toContain("data: ");
    expect(sub.subscribe).toHaveBeenCalledWith("upload:main:1");
  });

  it("subscribes to branch pattern when only branch provided", async () => {
    const listeners: Record<string, Function[]> = {};
    const sub = {
      subscribe: vi.fn().mockResolvedValue(1),
      psubscribe: vi.fn().mockResolvedValue(1),
      on: vi.fn((event: string, cb: Function) => {
        listeners[event] = listeners[event] || [];
        listeners[event].push(cb);
      }),
      unsubscribe: vi.fn().mockResolvedValue(1),
      punsubscribe: vi.fn().mockResolvedValue(1),
      disconnect: vi.fn(),
    };
    const redis = {
      duplicate: () => sub,
      disconnect: vi.fn(),
    } as any;
    const handler = createStreamHandler(() => redis);
    let output = "";
    const req: any = {
      url: "/api/stream?branch=feature-x",
      query: { branch: "feature-x" },
      on: (ev: string, cb: Function) => {
        if (ev === "close") {
          setTimeout(() => cb(), 10);
        }
      },
    };
    const res: any = {
      setHeader: vi.fn(),
      flushHeaders: vi.fn(),
      write: (chunk: string) => {
        output += chunk;
      },
      end: vi.fn(),
      status: vi.fn().mockReturnThis(),
    };
    const p = handler(req, res);
    await new Promise((r) => setTimeout(r, 5));
    // simulate redis pattern publish
    listeners["pmessage"][0](
      "upload:feature-x:*",
      "upload:feature-x:123",
      JSON.stringify({ b: 2 })
    );
    await p;
    expect(output).toContain("data: ");
    expect(sub.psubscribe).toHaveBeenCalledWith("upload:feature-x:*");
  });

  it("returns 400 when no channel or branch provided", async () => {
    const sub = {
      subscribe: vi.fn().mockResolvedValue(1),
      psubscribe: vi.fn().mockResolvedValue(1),
      on: vi.fn(),
      unsubscribe: vi.fn().mockResolvedValue(1),
      punsubscribe: vi.fn().mockResolvedValue(1),
      disconnect: vi.fn(),
    };
    const redis = {
      duplicate: () => sub,
      disconnect: vi.fn(),
    } as any;
    const handler = createStreamHandler(() => redis);
    const req: any = {
      url: "/api/stream",
      query: {},
      on: vi.fn(),
    };
    const res: any = {
      setHeader: vi.fn(),
      flushHeaders: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
      status: vi.fn().mockReturnThis(),
    };
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.end).toHaveBeenCalled();
  });
});

import { describe, it, expect, vi } from "vitest";
import { createStreamHandler } from "./createStreamHandler";

describe("createStreamHandler", () => {
  it("writes SSE messages on Redis publish", async () => {
    const listeners: Record<string, Function[]> = {};
    const sub = {
      subscribe: vi.fn().mockResolvedValue(1),
      on: vi.fn((event: string, cb: Function) => {
        listeners[event] = listeners[event] || [];
        listeners[event].push(cb);
      }),
      unsubscribe: vi.fn().mockResolvedValue(1),
      disconnect: vi.fn(),
    };
    const redis = {
      duplicate: () => sub,
      disconnect: vi.fn(),
    } as any;
    const handler = createStreamHandler(() => redis);
    let output = "";
    const req: any = {
      url: "/api/stream?channel=upload:1",
      query: { channel: "upload:1" },
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
    listeners["message"][0]("upload:1", JSON.stringify({ a: 1 }));
    await p;
    expect(output).toContain("data: ");
  });
});


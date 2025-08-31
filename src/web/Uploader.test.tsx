import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/react";
import React from "react";
import { Uploader } from "./Uploader";

describe("Uploader", () => {
  beforeEach(() => {
    // mock EventSource
    (global as any).EventSource = class {
      url: string;
      onmessage: any;
      onerror: any;
      constructor(url: string) {
        this.url = url;
      }
      close() {}
    };
  });

  it("requests presigned URL and uploads", async () => {
    const fetchMock = vi.spyOn(global, "fetch" as any);
    fetchMock
      .mockResolvedValueOnce({
        json: async () => ({
          presignedUrl: "https://s3/put",
          channel: "upload:1",
        }),
        ok: true,
      } as any)
      .mockResolvedValueOnce({ ok: true } as any);
    const onUpdate = vi.fn();
    const { getByText, container } = render(
      <Uploader action="/api/create-upload" onUpdate={onUpdate} />
    );
    const input = container.querySelector(
      'input[type="file"]'
    ) as HTMLInputElement;
    const file = new File(["hello"], "a.txt", { type: "text/plain" });
    await fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  });
});

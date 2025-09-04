import React, { useState } from "react";
import { useTransflowEndpoints } from "./TransflowProvider";

export interface UploaderProps {
  action?: string; // POST API route for create-upload (optional if using provider)
  template?: string; // template id/name
  fields?: Record<string, string | number | boolean>;
  onUpdate?: (evt: unknown) => void;
  multiple?: boolean;
}

export function Uploader({
  action,
  template,
  fields,
  onUpdate,
  multiple,
}: UploaderProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endpoints = useTransflowEndpoints?.() as
    | { action: string; stream: string }
    | undefined;
  const actionUrl = action || endpoints?.action || "/api/transflow/create-upload";
  const streamUrl = endpoints?.stream || "/api/transflow/stream";

  async function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const list = e.target?.files;
    if (!list || list.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      if (!multiple || list.length === 1) {
        const file = list[0];
        const resp = await fetch(actionUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            filename: file.name,
            contentType: file.type,
            template,
            fields,
          }),
        });
        const data = (await resp.json()) as {
          presignedUrl: string;
          channel: string;
        };
        const { presignedUrl, channel } = data;
        const put = await fetch(presignedUrl, {
          method: "PUT",
          body: file,
          headers: { "Content-Type": file.type },
        });
        if (!put.ok) throw new Error(`Upload failed: ${put.status}`);
        const es = new EventSource(`${streamUrl}?channel=${encodeURIComponent(channel)}`);
        es.onmessage = (evt) => onUpdate?.(JSON.parse(evt.data));
        es.onerror = () => es.close();
      } else {
        const files = Array.from(list).map((f) => ({ filename: f.name, contentType: f.type }));
        const resp = await fetch(actionUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ files, template, fields }),
        });
        const data = (await resp.json()) as {
          uploadId: string;
          channel: string;
          baseKey: string;
          bucket: string;
          files: Array<{ filename: string; key: string; presignedUrl: string; bucket: string }>;
        };
        for (let i = 0; i < data.files.length; i++) {
          const f = list[i];
          const dest = data.files[i];
          const put = await fetch(dest.presignedUrl, {
            method: "PUT",
            body: f,
            headers: { "Content-Type": f.type },
          });
          if (!put.ok) throw new Error(`Upload failed for ${f.name}: ${put.status}`);
        }
        const es = new EventSource(`${streamUrl}?channel=${encodeURIComponent(data.channel)}`);
        es.onmessage = (evt) => onUpdate?.(JSON.parse(evt.data));
        es.onerror = () => es.close();
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <input type="file" disabled={busy} onChange={onFileChange} multiple={!!multiple} />
      {busy ? <p>Uploading...</p> : null}
      {error ? <p style={{ color: "red" }}>{error}</p> : null}
    </div>
  );
}

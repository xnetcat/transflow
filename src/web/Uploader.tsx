import React, { useState } from "react";

export interface UploaderProps {
  action: string; // POST API route for create-upload
  onUpdate?: (evt: unknown) => void;
}

export function Uploader({ action, onUpdate }: UploaderProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target?.files?.[0];
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const resp = await fetch(action, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: file.name, contentType: file.type }),
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
      const es = new EventSource(
        `/api/stream?channel=${encodeURIComponent(channel)}`
      );
      es.onmessage = (evt) => onUpdate?.(JSON.parse(evt.data));
      es.onerror = () => es.close();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <input type="file" disabled={busy} onChange={onFileChange} />
      {busy ? <p>Uploading...</p> : null}
      {error ? <p style={{ color: "red" }}>{error}</p> : null}
    </div>
  );
}

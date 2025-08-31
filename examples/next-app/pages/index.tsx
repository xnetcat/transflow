import React, { useState } from "react";
import { Uploader } from "@xnetcat/transflow/browser";

type UploadEvent = unknown;

export default function Home() {
  const [events, setEvents] = useState<UploadEvent[]>([]);
  return (
    <main style={{ padding: 24 }}>
      <h1>Transflow Example</h1>
      <Uploader
        action="/api/create-upload"
        onUpdate={(m: UploadEvent) => setEvents((e) => [...e, m])}
      />
      <pre>{JSON.stringify(events, null, 2)}</pre>
    </main>
  );
}

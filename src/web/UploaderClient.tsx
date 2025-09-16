"use client";

import React, { useState } from "react";
import { useTransflowEndpoints } from "./TransflowProviderClient";

export interface UploaderProps {
  action?: string; // POST API route for create-upload (optional if using provider)
  template?: string; // template id/name
  fields?: Record<string, string | number | boolean>;
  onUpdate?: (evt: unknown) => void;
  onAssembly?: (assemblyId: string) => void; // called immediately after create-upload
  onUploadProgress?: (
    assemblyId: string,
    update: { fileName: string; index: number; pct: number }
  ) => void; // client PUT progress per file
  multiple?: boolean;
}

export function Uploader({
  action,
  template,
  fields,
  onUpdate,
  onAssembly,
  onUploadProgress,
  multiple,
}: UploaderProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endpoints = useTransflowEndpoints?.();
  const actionUrl =
    action || endpoints?.action || "/api/transflow/create-upload";
  const statusUrl = endpoints?.status || "/api/transflow/status";

  async function putWithProgress(
    url: string,
    file: File,
    contentType: string,
    onProgress?: (pct: number) => void
  ): Promise<Response> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", url, true);
      xhr.setRequestHeader("Content-Type", contentType);
      xhr.upload.onprogress = (evt) => {
        if (!evt.lengthComputable) return;
        const pct = Math.floor((evt.loaded / evt.total) * 100);
        try {
          onProgress?.(pct);
        } catch {}
      };
      xhr.onload = () => {
        const status = xhr.status;
        const headers = new Headers();
        xhr
          .getAllResponseHeaders()
          .trim()
          .split(/\r?\n/)
          .forEach((line) => {
            const parts = line.split(": ");
            const key = parts.shift();
            if (key) headers.append(key, parts.join(": "));
          });
        resolve(new Response(xhr.response, { status, headers }));
      };
      xhr.onerror = () => reject(new TypeError("Network request failed"));
      xhr.ontimeout = () => reject(new TypeError("Network request failed"));
      xhr.send(file);
    });
  }

  const startPollingStatus = (
    assemblyId: string,
    onUpdate?: (evt: unknown) => void
  ) => {
    const pollInterval = setInterval(async () => {
      try {
        const response = await fetch(
          `${statusUrl}?assemblyId=${encodeURIComponent(assemblyId)}`
        );
        if (!response.ok) {
          if (response.status === 404) {
            return; // Assembly not ready yet, continue polling
          }
          throw new Error(`Status request failed: ${response.status}`);
        }
        const assembly = await response.json();
        onUpdate?.(assembly);
        // Stop polling if completed or error
        if (assembly.ok === "ASSEMBLY_COMPLETED" || assembly.error) {
          clearInterval(pollInterval);
        }
      } catch (error) {
        console.error("Status polling error:", error);
      }
    }, 2000); // Poll every 2 seconds

    // Clean up polling after 10 minutes max
    setTimeout(() => clearInterval(pollInterval), 10 * 60 * 1000);
  };

  async function uploadFiles(fileList: FileList) {
    setBusy(true);
    setError(null);

    try {
      const files = Array.from(fileList);
      console.log(
        "[UploaderClient] uploadFiles called with",
        files.length,
        "files:",
        files.map((f) => f.name)
      );

      if (files.length === 1) {
        // Single file upload (no client-side hashing; server-side logic preferred)
        const file = files[0];
        const body = {
          filename: file.name,
          contentType: file.type,
          template,
          fields,
        } as any;

        const response = await fetch(actionUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(
            errorData.error || `Upload failed: ${response.status}`
          );
        }

        const result = await response.json();
        const { assembly_id, presigned_url } = result;
        onAssembly?.(assembly_id);

        // Upload to S3
        // initial 0%
        try {
          onUploadProgress?.(assembly_id, {
            fileName: file.name,
            index: 0,
            pct: 0,
          });
        } catch {}
        const uploadResponse = await putWithProgress(
          presigned_url,
          file,
          file.type,
          (pct) => {
            try {
              onUploadProgress?.(assembly_id, {
                fileName: file.name,
                index: 0,
                pct,
              });
            } catch {}
          }
        );

        if (!uploadResponse.ok) {
          throw new Error(`S3 upload failed: ${uploadResponse.status}`);
        }

        // Ensure 100% and start polling for status immediately
        try {
          onUploadProgress?.(assembly_id, {
            fileName: file.name,
            index: 0,
            pct: 100,
          });
        } catch {}
        startPollingStatus(assembly_id, onUpdate);
      } else {
        // Batch upload
        const fileDetails = files.map((file) => ({
          filename: file.name,
          contentType: file.type,
          fileSize: file.size,
        }));

        const body = {
          template,
          files: fileDetails,
          fields,
        } as any;

        const response = await fetch(actionUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(
            errorData.error || `Upload failed: ${response.status}`
          );
        }

        const result = await response.json();
        const { assembly_id, files: uploadFiles } = result;
        onAssembly?.(assembly_id);

        // Upload each file to S3
        await Promise.all(
          files.map(async (file, index) => {
            const uploadFile = uploadFiles[index];
            if (!uploadFile) return;

            // initial 0%
            try {
              onUploadProgress?.(assembly_id, {
                fileName: file.name,
                index,
                pct: 0,
              });
            } catch {}
            const uploadResponse = await putWithProgress(
              uploadFile.presigned_url,
              file,
              file.type,
              (pct) => {
                try {
                  onUploadProgress?.(assembly_id, {
                    fileName: file.name,
                    index,
                    pct,
                  });
                } catch {}
              }
            );

            if (!uploadResponse.ok) {
              throw new Error(
                `S3 upload failed for ${file.name}: ${uploadResponse.status}`
              );
            }
            try {
              onUploadProgress?.(assembly_id, {
                fileName: file.name,
                index,
                pct: 100,
              });
            } catch {}
          })
        );

        // Start polling for status immediately
        startPollingStatus(assembly_id, onUpdate);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Upload failed";
      setError(message);
      console.error("Upload error:", err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        border: "1px dashed #ccc",
        padding: "20px",
        textAlign: "center",
      }}
    >
      <input
        type="file"
        multiple={multiple}
        onChange={(e) => {
          if (e.target.files && e.target.files.length > 0) {
            uploadFiles(e.target.files);
          }
        }}
        disabled={busy}
        style={{ marginBottom: "10px" }}
      />
      <div>
        {busy && <p>Uploading...</p>}
        {error && <p style={{ color: "red" }}>Error: {error}</p>}
        {!busy && !error && (
          <p>
            {multiple ? "Select files" : "Select a file"} to upload
            {template && ` (Template: ${template})`}
          </p>
        )}
      </div>
    </div>
  );
}

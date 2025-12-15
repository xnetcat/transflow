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
        onProgress?.(pct);
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
        };

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
        onUploadProgress?.(assembly_id, {
          fileName: file.name,
          index: 0,
          pct: 0,
        });
        const uploadResponse = await putWithProgress(
          presigned_url,
          file,
          file.type,
          (pct) => {
            onUploadProgress?.(assembly_id, {
              fileName: file.name,
              index: 0,
              pct,
            });
          }
        );

        if (!uploadResponse.ok) {
          throw new Error(`S3 upload failed: ${uploadResponse.status}`);
        }

        // Ensure 100% and start polling for status immediately
        onUploadProgress?.(assembly_id, {
          fileName: file.name,
          index: 0,
          pct: 100,
        });
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
        };

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
            onUploadProgress?.(assembly_id, {
              fileName: file.name,
              index,
              pct: 0,
            });
            const uploadResponse = await putWithProgress(
              uploadFile.presigned_url,
              file,
              file.type,
              (pct) => {
                onUploadProgress?.(assembly_id, {
                  fileName: file.name,
                  index,
                  pct,
                });
              }
            );

            if (!uploadResponse.ok) {
              throw new Error(
                `S3 upload failed for ${file.name}: ${uploadResponse.status}`
              );
            }
            onUploadProgress?.(assembly_id, {
              fileName: file.name,
              index,
              pct: 100,
            });
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
    <div className="relative group">
      <div
        className={`
          relative border-2 border-dashed border-gray-700 bg-gray-900/50 rounded-xl p-8 
          text-center transition-all duration-200 ease-in-out
          hover:border-indigo-500/50 hover:bg-gray-800/80
          ${busy ? "opacity-50 cursor-wait" : "cursor-pointer"}
        `}
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
          className="absolute inset-0 w-full h-full opacity-0 cursor-pointer disabled:cursor-not-allowed"
        />
        <div className="flex flex-col items-center justify-center gap-3">
          <div className="p-3 bg-indigo-500/10 rounded-full text-indigo-400 group-hover:bg-indigo-500/20 transition-colors">
            <svg
              className="w-6 h-6"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
              />
            </svg>
          </div>
          <div className="space-y-1">
            <p className="font-medium text-gray-200">
              {busy
                ? "Uploading files..."
                : multiple
                ? "Drop files here or click to upload"
                : "Drop a file here or click to upload"}
            </p>
            {template && (
              <p className="text-xs text-gray-500 font-mono">
                Template: {template}
              </p>
            )}
            {error && <p className="text-sm text-red-400">{error}</p>}
          </div>
        </div>
      </div>
    </div>
  );
}

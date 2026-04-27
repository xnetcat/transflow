"use client";

import React, { useCallback, useId, useRef, useState } from "react";
import { useTransflowEndpoints } from "./TransflowProviderClient";

export interface UploaderProps {
  /** POST endpoint for create-upload. Falls back to TransflowProvider's `endpoints.action`. */
  action?: string;
  /** Template ID/name. */
  template?: string;
  /** Arbitrary metadata forwarded to the server (and templates via ctx.fields). */
  fields?: Record<string, string | number | boolean>;
  /** Called whenever the assembly status updates (during upload + processing). */
  onUpdate?: (evt: unknown) => void;
  /** Called immediately after create-upload returns, before the S3 PUTs begin. */
  onAssembly?: (assemblyId: string) => void;
  /** Per-file PUT progress. */
  onUploadProgress?: (
    assemblyId: string,
    update: { fileName: string; index: number; pct: number }
  ) => void;
  /** Allow multiple file selection / drop. */
  multiple?: boolean;
  /** HTML accept attribute (e.g. "audio/*,.mp3"). Also enforced by the browser file picker. */
  accept?: string;
  /** Disable the input. */
  disabled?: boolean;
  /** Client-side max file size (bytes). Server still has the final say. */
  maxFileSize?: number;
  /** Override copy. */
  label?: string;
  hint?: string;
  /** Extra Tailwind classes for the outer wrapper. */
  className?: string;
}

const formatBytes = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
};

export function Uploader({
  action,
  template,
  fields,
  onUpdate,
  onAssembly,
  onUploadProgress,
  multiple,
  accept,
  disabled,
  maxFileSize,
  label,
  hint,
  className = "",
}: UploaderProps) {
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const endpoints = useTransflowEndpoints?.();
  const actionUrl =
    action || endpoints?.action || "/api/transflow/create-upload";
  const statusUrl = endpoints?.status || "/api/transflow/status";

  const isDisabled = disabled || busy;

  const pushError = (msg: string) =>
    setErrors((prev) => (prev.includes(msg) ? prev : [...prev, msg]));
  const dismissError = (msg: string) =>
    setErrors((prev) => prev.filter((e) => e !== msg));

  const validateFiles = (list: File[]): File[] => {
    if (!maxFileSize) return list;
    const ok: File[] = [];
    for (const f of list) {
      if (f.size > maxFileSize) {
        pushError(`${f.name} is ${formatBytes(f.size)} — max ${formatBytes(maxFileSize)}`);
      } else {
        ok.push(f);
      }
    }
    return ok;
  };

  const putWithProgress = (
    url: string,
    file: File,
    contentType: string,
    onProgress?: (pct: number) => void
  ): Promise<Response> =>
    new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", url, true);
      xhr.setRequestHeader("Content-Type", contentType);
      xhr.upload.onprogress = (evt) => {
        if (!evt.lengthComputable) return;
        onProgress?.(Math.floor((evt.loaded / evt.total) * 100));
      };
      xhr.onload = () => {
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
        resolve(new Response(xhr.response, { status: xhr.status, headers }));
      };
      xhr.onerror = () => reject(new TypeError("Network request failed"));
      xhr.ontimeout = () => reject(new TypeError("Network request failed"));
      xhr.send(file);
    });

  const startPollingStatus = useCallback(
    (assemblyId: string, cb?: (evt: unknown) => void) => {
      const interval = setInterval(async () => {
        try {
          const response = await fetch(
            `${statusUrl}?assemblyId=${encodeURIComponent(assemblyId)}`
          );
          if (!response.ok) {
            if (response.status === 404) return;
            throw new Error(`Status request failed: ${response.status}`);
          }
          const assembly = await response.json();
          cb?.(assembly);
          if (assembly.ok === "ASSEMBLY_COMPLETED" || assembly.error) {
            clearInterval(interval);
          }
        } catch (err) {
          console.error("Status polling error:", err);
        }
      }, 2000);
      // safety cap — 10 minutes
      setTimeout(() => clearInterval(interval), 10 * 60 * 1000);
    },
    [statusUrl]
  );

  const uploadFiles = async (raw: FileList | File[]) => {
    setBusy(true);
    setErrors([]);
    try {
      const files = validateFiles(Array.from(raw));
      if (files.length === 0) return;

      if (files.length === 1) {
        const file = files[0];
        const response = await fetch(actionUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            filename: file.name,
            contentType: file.type,
            template,
            fields,
            fileSize: file.size,
          }),
        });
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(errorData.error || `Upload failed: ${response.status}`);
        }
        const { assembly_id, presigned_url } = await response.json();
        onAssembly?.(assembly_id);
        onUploadProgress?.(assembly_id, { fileName: file.name, index: 0, pct: 0 });
        const uploadResponse = await putWithProgress(
          presigned_url,
          file,
          file.type,
          (pct) =>
            onUploadProgress?.(assembly_id, {
              fileName: file.name,
              index: 0,
              pct,
            })
        );
        if (!uploadResponse.ok)
          throw new Error(`S3 upload failed: ${uploadResponse.status}`);
        onUploadProgress?.(assembly_id, { fileName: file.name, index: 0, pct: 100 });
        startPollingStatus(assembly_id, onUpdate);
      } else {
        const response = await fetch(actionUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            template,
            fields,
            files: files.map((f) => ({
              filename: f.name,
              contentType: f.type,
              fileSize: f.size,
            })),
          }),
        });
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(errorData.error || `Upload failed: ${response.status}`);
        }
        const { assembly_id, files: presigned } = await response.json();
        onAssembly?.(assembly_id);
        await Promise.all(
          files.map(async (file, index) => {
            const target = presigned[index];
            if (!target) return;
            onUploadProgress?.(assembly_id, { fileName: file.name, index, pct: 0 });
            const uploadResponse = await putWithProgress(
              target.presigned_url,
              file,
              file.type,
              (pct) =>
                onUploadProgress?.(assembly_id, {
                  fileName: file.name,
                  index,
                  pct,
                })
            );
            if (!uploadResponse.ok)
              throw new Error(
                `S3 upload failed for ${file.name}: ${uploadResponse.status}`
              );
            onUploadProgress?.(assembly_id, {
              fileName: file.name,
              index,
              pct: 100,
            });
          })
        );
        startPollingStatus(assembly_id, onUpdate);
      }
    } catch (err) {
      pushError(err instanceof Error ? err.message : "Upload failed");
      console.error("Upload error:", err);
    } finally {
      setBusy(false);
    }
  };

  const onPickerChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      uploadFiles(e.target.files);
      // reset so picking the same file twice still triggers change
      e.target.value = "";
    }
  };

  const onDrop = (e: React.DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    setDragging(false);
    if (isDisabled) return;
    const files = e.dataTransfer.files;
    if (!files || files.length === 0) return;
    const list = multiple ? Array.from(files) : [files[0]];
    uploadFiles(list);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLLabelElement>) => {
    if (isDisabled) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      inputRef.current?.click();
    }
  };

  const heading =
    label ??
    (busy
      ? "Uploading…"
      : multiple
      ? "Drop files here or click to browse"
      : "Drop a file here or click to browse");

  return (
    <div className={`relative ${className}`}>
      <label
        htmlFor={inputId}
        onDragOver={(e) => {
          e.preventDefault();
          if (!isDisabled) setDragging(true);
        }}
        onDragEnter={(e) => {
          e.preventDefault();
          if (!isDisabled) setDragging(true);
        }}
        onDragLeave={(e) => {
          e.preventDefault();
          // only flip off when actually leaving the box
          if (e.currentTarget === e.target) setDragging(false);
        }}
        onDrop={onDrop}
        onKeyDown={onKeyDown}
        role="button"
        tabIndex={isDisabled ? -1 : 0}
        aria-label={heading}
        aria-busy={busy}
        aria-disabled={isDisabled}
        className={`
          group relative flex flex-col items-center justify-center gap-3
          border-2 border-dashed rounded-2xl px-6 py-10 text-center
          transition-all duration-200 ease-out
          focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/60
          ${
            isDisabled
              ? "cursor-wait border-gray-700/60 bg-gray-900/40 text-gray-500"
              : dragging
              ? "cursor-copy border-indigo-400 bg-indigo-500/10 ring-4 ring-indigo-500/10 scale-[1.01]"
              : "cursor-pointer border-gray-700 bg-gray-900/40 hover:border-indigo-500/60 hover:bg-gray-800/60"
          }
        `}
      >
        <input
          ref={inputRef}
          id={inputId}
          type="file"
          multiple={multiple}
          accept={accept}
          onChange={onPickerChange}
          disabled={isDisabled}
          className="sr-only"
        />

        <div
          className={`
            flex h-12 w-12 items-center justify-center rounded-full transition-colors
            ${
              dragging
                ? "bg-indigo-500/20 text-indigo-300"
                : "bg-indigo-500/10 text-indigo-400 group-hover:bg-indigo-500/20"
            }
          `}
          aria-hidden="true"
        >
          {busy ? (
            <svg
              className="h-6 w-6 animate-spin"
              fill="none"
              viewBox="0 0 24 24"
            >
              <circle
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="3"
                opacity="0.25"
              />
              <path
                fill="currentColor"
                d="M4 12a8 8 0 0 1 8-8v3a5 5 0 0 0-5 5H4z"
              />
            </svg>
          ) : (
            <svg
              className="h-6 w-6"
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
          )}
        </div>

        <div className="space-y-1">
          <p className="text-sm font-medium text-gray-200">{heading}</p>
          {hint ? (
            <p className="text-xs text-gray-500">{hint}</p>
          ) : (
            <p className="text-xs text-gray-500">
              {accept ? `${accept}` : "Any file type"}
              {maxFileSize ? ` · up to ${formatBytes(maxFileSize)}` : ""}
              {template ? ` · template ${template}` : ""}
            </p>
          )}
        </div>
      </label>

      {errors.length > 0 && (
        <ul className="mt-3 space-y-1.5" aria-live="polite">
          {errors.map((msg) => (
            <li
              key={msg}
              className="flex items-start justify-between gap-3 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-300"
            >
              <span className="break-all">{msg}</span>
              <button
                type="button"
                onClick={() => dismissError(msg)}
                className="shrink-0 text-red-400/70 hover:text-red-200 transition-colors"
                aria-label="Dismiss"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

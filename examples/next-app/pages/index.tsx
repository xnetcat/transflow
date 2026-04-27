import React, { useMemo, useState } from "react";
import dynamic from "next/dynamic";
import Head from "next/head";

const TransflowProvider = dynamic(
  () => import("@xnetcat/transflow/web").then((m) => m.TransflowProvider),
  { ssr: false }
);
const Uploader = dynamic(
  () => import("@xnetcat/transflow/web").then((m) => m.Uploader),
  { ssr: false }
);
import type { AssemblyStatus } from "@xnetcat/transflow";

// ─────────────────────────────────────────── primitives ───────────────────────

function ProgressBar({ value, tone = "indigo" }: { value: number; tone?: "indigo" | "emerald" | "red" }) {
  const clamped = Math.max(0, Math.min(100, value));
  const gradient =
    tone === "emerald"
      ? "from-emerald-500 to-teal-500"
      : tone === "red"
      ? "from-red-500 to-rose-500"
      : "from-indigo-500 to-blue-500";
  return (
    <div className="w-full h-2 bg-gray-800/80 rounded-full overflow-hidden">
      <div
        className={`h-full bg-gradient-to-r ${gradient} transition-all duration-300 ease-out`}
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}

function Card({
  children,
  className = "",
  glow = false,
}: {
  children: React.ReactNode;
  className?: string;
  glow?: boolean;
}) {
  return (
    <div
      className={`
        relative overflow-hidden rounded-2xl border border-white/10 bg-white/5 p-6 backdrop-blur-xl
        ${glow ? "shadow-[0_0_40px_-10px_rgba(79,70,229,0.15)]" : ""}
        ${className}
      `}
    >
      {children}
    </div>
  );
}

function StatusBadge({ status, error }: { status: string; error?: string }) {
  if (error) {
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-red-500/10 text-red-400 border border-red-500/20">
        <span className="h-1.5 w-1.5 rounded-full bg-red-400" />
        Error
      </span>
    );
  }
  if (status === "ASSEMBLY_COMPLETED") {
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
        Completed
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-500/10 text-blue-400 border border-blue-500/20">
      <span className="h-1.5 w-1.5 rounded-full bg-blue-400 animate-pulse" />
      Processing
    </span>
  );
}

function StatCard({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: number;
  tone?: "neutral" | "success" | "error";
}) {
  const colors = {
    neutral: "text-gray-200",
    success: "text-emerald-400",
    error: "text-red-400",
  };
  return (
    <div className="flex flex-col items-center justify-center min-w-[88px] rounded-xl border border-white/10 bg-white/5 px-4 py-3 backdrop-blur-xl">
      <div className="text-[10px] text-gray-500 uppercase tracking-wider font-semibold">
        {label}
      </div>
      <div className={`text-2xl font-bold ${colors[tone]}`}>{value}</div>
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async (e) => {
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {}
      }}
      className="text-gray-500 hover:text-gray-300 transition-colors"
      aria-label="Copy assembly id"
      title="Copy assembly id"
    >
      {copied ? (
        <svg className="w-3.5 h-3.5 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
        </svg>
      ) : (
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 5H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-1m-6-9h6a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z" />
        </svg>
      )}
    </button>
  );
}

// ─────────────────────────────────────────── page ────────────────────────────

export default function Home() {
  const [assemblies, setAssemblies] = useState<AssemblyStatus[]>([]);
  const [templateId, setTemplateId] = useState<string>("tpl_basic_audio");
  const [fileProgress, setFileProgress] = useState<
    Record<string, Array<{ name: string; pct: number }>>
  >({});

  const upsertAssembly = (
    partial: Partial<AssemblyStatus> & { assembly_id: string }
  ) => {
    setAssemblies((prev) => {
      const idx = prev.findIndex((a) => a.assembly_id === partial.assembly_id);
      if (idx >= 0) {
        const copy = [...prev];
        copy[idx] = { ...copy[idx], ...partial } as AssemblyStatus;
        return copy;
      }
      return [
        {
          assembly_id: partial.assembly_id,
          message: "Upload pending",
          ...partial,
        } as AssemblyStatus,
        ...prev,
      ];
    });
  };

  const handleUpdate = (assembly: AssemblyStatus) => upsertAssembly(assembly);

  const handleAssembly = (assemblyId: string) =>
    upsertAssembly({
      assembly_id: assemblyId,
      message: "Uploading...",
      progress_pct: 0,
    });

  const handleUploadProgress = (
    assemblyId: string,
    update: { fileName: string; index: number; pct: number }
  ) => {
    setFileProgress((prev) => {
      const list = prev[assemblyId] ? [...prev[assemblyId]] : [];
      list[update.index] = { name: update.fileName, pct: update.pct };
      const avg =
        list.length > 0
          ? Math.round(list.reduce((s, f) => s + (f?.pct ?? 0), 0) / list.length)
          : update.pct;
      upsertAssembly({
        assembly_id: assemblyId,
        upload_progress_pct: avg,
        message: "Uploading...",
      });
      return { ...prev, [assemblyId]: list };
    });
  };

  const stats = useMemo(() => {
    const total = assemblies.length;
    const completed = assemblies.filter((a) => a.ok === "ASSEMBLY_COMPLETED").length;
    const failed = assemblies.filter((a) => !!a.error).length;
    return { total, completed, failed };
  }, [assemblies]);

  const progressValue = (a: AssemblyStatus) => {
    if (a.ok === "ASSEMBLY_COMPLETED") return 100;
    if (typeof a.upload_progress_pct === "number" && a.upload_progress_pct < 100)
      return a.upload_progress_pct;
    if (typeof a.progress_pct === "number") return a.progress_pct;
    return 0;
  };

  const clearAll = () => {
    setAssemblies([]);
    setFileProgress({});
  };

  return (
    <TransflowProvider
      endpoints={{ action: "/api/create-upload", status: "/api/status" }}
    >
      <Head>
        <title>Transflow Demo</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>
      <main className="min-h-screen bg-neutral-950 text-gray-200 selection:bg-indigo-500/30 pb-20">
        {/* Background gradient blobs */}
        <div className="fixed inset-0 pointer-events-none overflow-hidden">
          <div className="absolute -top-1/4 -left-1/4 w-[60%] h-[60%] bg-indigo-900/20 rounded-full blur-[140px]" />
          <div className="absolute top-1/4 -right-1/4 w-[50%] h-[50%] bg-blue-900/10 rounded-full blur-[120px]" />
          <div className="absolute bottom-0 left-1/3 w-[40%] h-[40%] bg-violet-900/10 rounded-full blur-[100px]" />
        </div>

        <div className="relative max-w-5xl mx-auto px-5 sm:px-6 py-10 sm:py-14">
          {/* Header */}
          <header className="flex flex-col sm:flex-row sm:items-end justify-between gap-6 mb-12">
            <div className="space-y-2">
              <div className="inline-flex items-center gap-2 text-xs font-medium text-indigo-300/80 bg-indigo-500/10 border border-indigo-500/20 rounded-full px-2.5 py-1">
                <span className="h-1.5 w-1.5 rounded-full bg-indigo-400 animate-pulse" />
                Transflow demo
              </div>
              <h1 className="text-3xl sm:text-5xl font-bold tracking-tight bg-gradient-to-br from-white via-gray-200 to-gray-500 bg-clip-text text-transparent">
                Drop a file, watch it ship
              </h1>
              <p className="text-base sm:text-lg text-gray-400 font-light max-w-md">
                Presigned upload → SQS → templated processing → DynamoDB status.
              </p>
            </div>

            <div className="flex gap-3">
              <StatCard label="Total" value={stats.total} />
              <StatCard label="Done" value={stats.completed} tone="success" />
              <StatCard label="Failed" value={stats.failed} tone="error" />
            </div>
          </header>

          {/* Upload */}
          <section className="mb-10">
            <Card glow className="p-6 sm:p-8">
              <div className="grid lg:grid-cols-3 gap-6 lg:gap-8">
                <div className="lg:col-span-1 space-y-3">
                  <label className="block text-[11px] font-semibold text-gray-400 uppercase tracking-wider">
                    Template
                  </label>
                  <div className="relative">
                    <select
                      value={templateId}
                      onChange={(e) => setTemplateId(e.target.value)}
                      className="w-full appearance-none bg-gray-900/60 border border-gray-700 rounded-xl px-4 py-2.5 text-gray-200 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50 transition-all hover:bg-gray-800/60"
                    >
                      <option value="tpl_basic_audio">Basic Audio (preview + master)</option>
                      <option value="tpl_export_example">Export Example</option>
                    </select>
                    <div className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-gray-500">
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                      </svg>
                    </div>
                  </div>
                  <p className="text-xs text-gray-500 leading-relaxed">
                    Templates are bundled with esbuild and baked into the
                    Lambda image. The selected template runs on every
                    uploaded file.
                  </p>
                </div>

                <div className="lg:col-span-2">
                  <Uploader
                    template={templateId}
                    onUpdate={handleUpdate}
                    onAssembly={handleAssembly}
                    onUploadProgress={handleUploadProgress}
                    multiple
                    accept="audio/*,video/*,image/*"
                    maxFileSize={500 * 1024 * 1024}
                  />
                </div>
              </div>
            </Card>
          </section>

          {/* Assemblies */}
          {assemblies.length > 0 ? (
            <>
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">
                  Assemblies
                </h2>
                <button
                  type="button"
                  onClick={clearAll}
                  className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
                >
                  Clear list
                </button>
              </div>
              <section className="grid md:grid-cols-2 gap-5">
                {assemblies.map((a) => {
                  const pct = progressValue(a);
                  const perFiles = fileProgress[a.assembly_id] || [];
                  const tone: "indigo" | "emerald" | "red" = a.error
                    ? "red"
                    : a.ok === "ASSEMBLY_COMPLETED"
                    ? "emerald"
                    : "indigo";

                  return (
                    <Card key={a.assembly_id} className="transition-all hover:bg-white/[0.07]">
                      <div className="flex justify-between items-start gap-3 mb-4">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 font-mono text-[11px] text-gray-500 mb-1">
                            <span>id: {a.assembly_id?.slice(-12)}</span>
                            <CopyButton text={a.assembly_id} />
                          </div>
                          <div className="font-medium text-gray-200 truncate">
                            {a.uploads?.[0]?.name || "New assembly"}
                            {a.uploads && a.uploads.length > 1 && (
                              <span className="text-gray-500 ml-2">+{a.uploads.length - 1}</span>
                            )}
                          </div>
                        </div>
                        <StatusBadge status={a.ok || ""} error={a.error} />
                      </div>

                      <div className="mb-3">
                        <div className="flex justify-between text-xs text-gray-400 mb-1.5">
                          <span className="truncate pr-2">
                            {typeof a.upload_progress_pct === "number" &&
                            a.upload_progress_pct < 100
                              ? "Uploading to S3…"
                              : a.current_step && a.steps_total
                              ? `Step ${a.current_step} of ${a.steps_total}: ${
                                  a.current_step_name || "Processing"
                                }`
                              : a.message || "Pending…"}
                          </span>
                          <span className="tabular-nums">{pct}%</span>
                        </div>
                        <ProgressBar value={pct} tone={tone} />
                      </div>

                      {perFiles.length > 0 &&
                        typeof a.upload_progress_pct === "number" &&
                        a.upload_progress_pct < 100 && (
                          <div className="mt-3 space-y-2 border-t border-white/5 pt-3">
                            {perFiles.map((f, i) => (
                              <div key={i} className="text-xs">
                                <div className="flex justify-between text-gray-500 mb-1">
                                  <span className="truncate max-w-[180px]">{f?.name}</span>
                                  <span className="tabular-nums">{f?.pct ?? 0}%</span>
                                </div>
                                <div className="w-full h-1 bg-gray-800 rounded-full overflow-hidden">
                                  <div
                                    className="h-full bg-indigo-500/60 transition-all"
                                    style={{ width: `${f?.pct ?? 0}%` }}
                                  />
                                </div>
                              </div>
                            ))}
                          </div>
                        )}

                      {a.error && (
                        <div className="mt-3 p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-sm text-red-300 break-words">
                          {a.message || a.error}
                        </div>
                      )}

                      {a.results && Object.keys(a.results).length > 0 && (
                        <div className="mt-4 pt-4 border-t border-white/5">
                          <div className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-2">
                            Outputs
                          </div>
                          <div className="space-y-3">
                            {Object.entries(a.results).map(([stepName, results]) => (
                              <div key={stepName}>
                                <div className="text-xs text-indigo-400 mb-1.5 font-mono">
                                  {stepName}
                                </div>
                                <div className="flex flex-wrap gap-2">
                                  {(results as any[]).map((r, i) => (
                                    <a
                                      key={i}
                                      href={r.ssl_url}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="group/link inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-gray-800/80 hover:bg-gray-700/80 border border-gray-700/80 text-xs text-gray-300 transition-colors"
                                    >
                                      <span className="truncate max-w-[140px]">{r.name}</span>
                                      <svg
                                        className="w-3 h-3 opacity-50 group-hover/link:opacity-100 transition-opacity"
                                        fill="none"
                                        stroke="currentColor"
                                        viewBox="0 0 24 24"
                                      >
                                        <path
                                          strokeLinecap="round"
                                          strokeLinejoin="round"
                                          strokeWidth={2}
                                          d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
                                        />
                                      </svg>
                                    </a>
                                  ))}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </Card>
                  );
                })}
              </section>
            </>
          ) : (
            <Card className="text-center py-12">
              <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-gray-800/80 text-gray-500">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 17v-6h13M3 12h6m-3-3v6" />
                </svg>
              </div>
              <p className="text-sm text-gray-400">
                No assemblies yet. Drop a file above to start.
              </p>
            </Card>
          )}

          <footer className="mt-16 flex flex-wrap items-center justify-between gap-4 text-xs text-gray-600">
            <p>
              Powered by{" "}
              <a
                className="text-gray-400 hover:text-gray-200 transition-colors"
                href="https://github.com/xnetcat/transflow"
                target="_blank"
                rel="noopener noreferrer"
              >
                @xnetcat/transflow
              </a>
            </p>
            <p className="font-mono">
              endpoint:{" "}
              <span className="text-gray-400">
                {process.env.NEXT_PUBLIC_TRANSFLOW_AWS_ENDPOINT || "real AWS"}
              </span>
            </p>
          </footer>
        </div>
      </main>
    </TransflowProvider>
  );
}

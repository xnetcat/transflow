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

// --- Components ---

function ProgressBar({ value }: { value: number }) {
  const clamped = Math.max(0, Math.min(100, value));
  return (
    <div className="w-full h-2.5 bg-gray-700/50 rounded-full overflow-hidden">
      <div
        className="h-full bg-gradient-to-r from-indigo-500 to-blue-500 transition-all duration-300 ease-out"
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
      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-red-500/10 text-red-400 border border-red-500/20">
        Error
      </span>
    );
  }
  if (status === "ASSEMBLY_COMPLETED") {
    return (
      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
        Completed
      </span>
    );
  }
  return (
    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-500/10 text-blue-400 border border-blue-500/20 animate-pulse">
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
    <Card className="flex flex-col items-center justify-center p-4 min-w-[120px]">
      <div className="text-xs text-gray-500 uppercase tracking-wider font-semibold mb-1">
        {label}
      </div>
      <div className={`text-3xl font-bold ${colors[tone]}`}>{value}</div>
    </Card>
  );
}

// --- Main Page ---

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

  const handleUpdate = (assembly: AssemblyStatus) => {
    upsertAssembly(assembly);
  };

  const handleAssembly = (assemblyId: string) => {
    // Show the assembly instantly before uploads start
    upsertAssembly({
      assembly_id: assemblyId,
      message: "Uploading...",
      progress_pct: 0,
    });
  };

  const handleUploadProgress = (
    assemblyId: string,
    update: { fileName: string; index: number; pct: number }
  ) => {
    // Update per-file progress first
    setFileProgress((prev) => {
      const list = prev[assemblyId] ? [...prev[assemblyId]] : [];
      list[update.index] = { name: update.fileName, pct: update.pct };

      // Calculate overall upload progress as average of all files
      const avgPct =
        list.length > 0
          ? Math.round(list.reduce((sum, f) => sum + f.pct, 0) / list.length)
          : update.pct;

      // Update assembly with calculated average
      upsertAssembly({
        assembly_id: assemblyId,
        upload_progress_pct: avgPct,
        message: "Uploading...",
      });

      return { ...prev, [assemblyId]: list };
    });
  };

  const stats = useMemo(() => {
    const total = assemblies.length;
    const completed = assemblies.filter(
      (a) => a.ok === "ASSEMBLY_COMPLETED"
    ).length;
    const failed = assemblies.filter((a) => !!a.error).length;
    return { total, completed, failed };
  }, [assemblies]);

  const progressValue = (a: AssemblyStatus) => {
    if (a.ok === "ASSEMBLY_COMPLETED") return 100;
    if (
      typeof a.upload_progress_pct === "number" &&
      a.upload_progress_pct < 100
    )
      return a.upload_progress_pct;
    if (typeof a.progress_pct === "number") return a.progress_pct;
    return 0;
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
        {/* Background Gradients */}
        <div className="fixed inset-0 pointer-events-none">
          <div className="absolute top-[-10%] left-[-10%] w-[50%] h-[50%] bg-indigo-900/20 rounded-full blur-[120px]" />
          <div className="absolute top-[20%] right-[-10%] w-[40%] h-[40%] bg-blue-900/10 rounded-full blur-[100px]" />
        </div>

        <div className="relative max-w-5xl mx-auto px-6 py-12">
          {/* Header */}
          <header className="flex flex-col md:flex-row md:items-end justify-between gap-8 mb-16">
            <div className="space-y-2">
              <h1 className="text-4xl md:text-5xl font-bold tracking-tight bg-gradient-to-br from-white via-gray-200 to-gray-500 bg-clip-text text-transparent">
                Transflow Demo
              </h1>
              <p className="text-lg text-gray-400 font-light max-w-md">
                Secure uploads, explicit exports, step-based progress
              </p>
            </div>

            <div className="flex gap-4">
              <StatCard label="Total" value={stats.total} />
              <StatCard
                label="Completed"
                value={stats.completed}
                tone="success"
              />
              <StatCard label="Failed" value={stats.failed} tone="error" />
            </div>
          </header>

          {/* Upload Section */}
          <section className="mb-12">
            <Card glow className="p-8">
              <div className="grid md:grid-cols-3 gap-8">
                <div className="md:col-span-1 space-y-4">
                  <label className="block text-sm font-medium text-gray-400 uppercase tracking-wider">
                    Select Template
                  </label>
                  <div className="relative">
                    <select
                      value={templateId}
                      onChange={(e) => setTemplateId(e.target.value)}
                      className="w-full appearance-none bg-gray-900/50 border border-gray-700 rounded-xl px-4 py-3 text-gray-200 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50 transition-all hover:bg-gray-800/50"
                    >
                      <option value="tpl_basic_audio">Basic Audio</option>
                      <option value="tpl_export_example">Export Example</option>
                    </select>
                    <div className="absolute right-4 top-1/2 -translate-y-1/2 pointer-events-none text-gray-500">
                      <svg
                        className="w-4 h-4"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M19 9l-7 7-7-7"
                        />
                      </svg>
                    </div>
                  </div>
                  <p className="text-sm text-gray-500 leading-relaxed">
                    Templates define the processing pipeline. The selected
                    template determines where files are stored and how they are
                    processed.
                  </p>
                </div>

                <div className="md:col-span-2">
                  <div className="mb-2 text-sm font-medium text-gray-400 uppercase tracking-wider">
                    Upload Files
                  </div>
                  <Uploader
                    template={templateId}
                    onUpdate={handleUpdate}
                    onAssembly={handleAssembly}
                    onUploadProgress={handleUploadProgress}
                    multiple={true}
                  />
                  <p className="mt-3 text-xs text-gray-600">
                    Files are uploaded to a temporary bucket; results are
                    written only to explicitly allowed output buckets.
                  </p>
                </div>
              </div>
            </Card>
          </section>

          {/* Assemblies Grid */}
          {assemblies.length > 0 && (
            <section className="grid md:grid-cols-2 gap-6">
              {assemblies.map((a) => {
                const pct = progressValue(a);
                const perFiles = fileProgress[a.assembly_id] || [];

                return (
                  <Card
                    key={a.assembly_id}
                    className="transition-all hover:bg-white/[0.07] group"
                  >
                    {/* Card Header */}
                    <div className="flex justify-between items-start mb-4">
                      <div>
                        <div className="font-mono text-xs text-gray-500 mb-1">
                          ID: {a.assembly_id?.slice(-8)}
                        </div>
                        <div
                          className="font-medium text-gray-200 truncate max-w-[200px]"
                          title={a.assembly_id}
                        >
                          {a.uploads?.[0]?.name || "New Assembly"}
                          {a.uploads && a.uploads.length > 1 && (
                            <span className="text-gray-500 ml-2">
                              +{a.uploads.length - 1} more
                            </span>
                          )}
                        </div>
                      </div>
                      <StatusBadge status={a.ok || ""} error={a.error} />
                    </div>

                    {/* Progress */}
                    <div className="mb-4">
                      <div className="flex justify-between text-xs text-gray-400 mb-2">
                        <span>
                          {typeof a.upload_progress_pct === "number" &&
                          a.upload_progress_pct < 100
                            ? "Uploading to S3..."
                            : a.current_step && a.steps_total
                            ? `Step ${a.current_step} of ${a.steps_total}: ${
                                a.current_step_name || "Processing"
                              }`
                            : a.message || "Pending..."}
                        </span>
                        <span>{pct}%</span>
                      </div>
                      <ProgressBar value={pct} />
                    </div>

                    {/* File Upload Progress Detail */}
                    {perFiles.length > 0 &&
                      typeof a.upload_progress_pct === "number" &&
                      a.upload_progress_pct < 100 && (
                        <div className="mt-4 space-y-2 border-t border-white/5 pt-4">
                          {perFiles.map((f, i) => (
                            <div key={i} className="text-xs">
                              <div className="flex justify-between text-gray-500 mb-1">
                                <span className="truncate max-w-[150px]">
                                  {f.name}
                                </span>
                                <span>{f.pct}%</span>
                              </div>
                              <div className="w-full h-1 bg-gray-800 rounded-full overflow-hidden">
                                <div
                                  className="h-full bg-indigo-500/50"
                                  style={{ width: `${f.pct}%` }}
                                />
                              </div>
                            </div>
                          ))}
                        </div>
                      )}

                    {/* Error Display */}
                    {a.error && (
                      <div className="mt-4 p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-sm text-red-300">
                        {a.error}
                      </div>
                    )}

                    {/* Results */}
                    {a.results && Object.keys(a.results).length > 0 && (
                      <div className="mt-4 pt-4 border-t border-white/5">
                        <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
                          Outputs
                        </div>
                        <div className="space-y-3">
                          {Object.entries(a.results).map(
                            ([stepName, results]) => (
                              <div key={stepName}>
                                <div className="text-xs text-indigo-400 mb-1 font-mono">
                                  {stepName}
                                </div>
                                <div className="flex flex-wrap gap-2">
                                  {(results as any[]).map((r, i) => (
                                    <a
                                      key={i}
                                      href={r.ssl_url}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="inline-flex items-center px-3 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 border border-gray-700 text-xs text-gray-300 transition-colors group/link"
                                    >
                                      <span className="truncate max-w-[120px]">
                                        {r.name}
                                      </span>
                                      <svg
                                        className="w-3 h-3 ml-2 opacity-0 group-hover/link:opacity-100 transition-opacity"
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
                            )
                          )}
                        </div>
                      </div>
                    )}
                  </Card>
                );
              })}
            </section>
          )}

          {/* Debug Data */}
          {assemblies.length > 0 && (
            <details className="mt-12 group">
              <summary className="cursor-pointer text-xs text-gray-600 hover:text-gray-400 transition-colors list-none">
                <span className="group-open:hidden">Show Debug Data</span>
                <span className="hidden group-open:inline">
                  Hide Debug Data
                </span>
              </summary>
              <div className="mt-4 p-4 rounded-xl bg-black/50 border border-white/5 overflow-x-auto">
                <pre className="text-xs text-gray-500 font-mono">
                  {JSON.stringify(assemblies, null, 2)}
                </pre>
              </div>
            </details>
          )}
        </div>
      </main>
    </TransflowProvider>
  );
}

import React, { useMemo, useState } from "react";
import dynamic from "next/dynamic";
const TransflowProvider = dynamic(
  () => import("@xnetcat/transflow/web").then((m) => m.TransflowProvider),
  { ssr: false }
);
const Uploader = dynamic(
  () => import("@xnetcat/transflow/web").then((m) => m.Uploader),
  { ssr: false }
);
import type { AssemblyStatus } from "@xnetcat/transflow";

function ProgressBar({ value }: { value: number }) {
  const clamped = Math.max(0, Math.min(100, value));
  return (
    <div
      style={{
        width: "100%",
        height: 10,
        background: "rgba(255,255,255,0.25)",
        borderRadius: 999,
        overflow: "hidden",
        boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.15)",
      }}
    >
      <div
        style={{
          width: `${clamped}%`,
          height: "100%",
          background: "linear-gradient(90deg, #a78bfa, #60a5fa)",
          transition: "width 300ms ease",
        }}
      />
    </div>
  );
}

function Card({
  children,
  tone = "neutral" as "neutral" | "success" | "error",
}) {
  const bg =
    tone === "success"
      ? "rgba(16,185,129,0.15)"
      : tone === "error"
      ? "rgba(239,68,68,0.15)"
      : "rgba(255,255,255,0.1)";
  const border =
    tone === "success"
      ? "1px solid rgba(16,185,129,0.35)"
      : tone === "error"
      ? "1px solid rgba(239,68,68,0.35)"
      : "1px solid rgba(255,255,255,0.2)";
  return (
    <div
      style={{
        border,
        background: bg,
        borderRadius: 16,
        padding: 16,
        backdropFilter: "blur(8px)",
      }}
    >
      {children}
    </div>
  );
}

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

  const headerGradient = {
    background:
      "radial-gradient(1200px 600px at 10% -20%, rgba(99,102,241,0.35), transparent), radial-gradient(1200px 600px at 110% 20%, rgba(59,130,246,0.35), transparent), linear-gradient(180deg, #0b1020, #0a0f1c)",
  } as const;

  const surfaceGradient = {
    background:
      "linear-gradient(180deg, rgba(255,255,255,0.08), rgba(255,255,255,0.03))",
  } as const;

  const renderStatus = (a: AssemblyStatus) => {
    if (a.error) return { label: "Error", tone: "error" as const };
    if (a.ok === "ASSEMBLY_COMPLETED")
      return { label: "Completed", tone: "success" as const };
    if (
      typeof a.upload_progress_pct === "number" &&
      a.upload_progress_pct < 100
    )
      return { label: "Uploading", tone: "neutral" as const };
    return { label: "Processing", tone: "neutral" as const };
  };

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
      <main style={{ minHeight: "100vh", ...headerGradient, color: "#ecf2ff" }}>
        <div style={{ maxWidth: 1040, margin: "0 auto", padding: 24 }}>
          <header
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 24,
            }}
          >
            <div>
              <h1 style={{ margin: 0, letterSpacing: 0.5 }}>Transflow Demo</h1>
              <p style={{ margin: 0, opacity: 0.8 }}>
                Secure uploads, explicit exports, step-based progress
              </p>
            </div>
            <div style={{ display: "flex", gap: 12 }}>
              <Card>
                <div style={{ fontSize: 12, opacity: 0.85 }}>Assemblies</div>
                <div style={{ fontSize: 18, fontWeight: 600 }}>
                  {stats.total}
                </div>
              </Card>
              <Card tone="success">
                <div style={{ fontSize: 12, opacity: 0.85 }}>Completed</div>
                <div style={{ fontSize: 18, fontWeight: 600 }}>
                  {stats.completed}
                </div>
              </Card>
              <Card tone="error">
                <div style={{ fontSize: 12, opacity: 0.85 }}>Errors</div>
                <div style={{ fontSize: 18, fontWeight: 600 }}>
                  {stats.failed}
                </div>
              </Card>
            </div>
          </header>

          <section
            style={{
              ...surfaceGradient,
              border: "1px solid rgba(255,255,255,0.2)",
              borderRadius: 16,
              padding: 20,
              marginBottom: 24,
            }}
          >
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 2fr",
                gap: 16,
                alignItems: "center",
              }}
            >
              <div>
                <label style={{ display: "block", marginBottom: 8 }}>
                  Template
                </label>
                <select
                  value={templateId}
                  onChange={(e) => setTemplateId(e.target.value)}
                  style={{
                    padding: 10,
                    borderRadius: 10,
                    border: "1px solid rgba(255,255,255,0.2)",
                    background: "rgba(255,255,255,0.05)",
                    color: "#ecf2ff",
                    width: "100%",
                  }}
                >
                  <option value="tpl_basic_audio">Basic Audio</option>
                  <option value="tpl_export_example">Export Example</option>
                </select>
              </div>
              <div>
                <Uploader
                  template={templateId}
                  onUpdate={handleUpdate}
                  onAssembly={handleAssembly}
                  onUploadProgress={handleUploadProgress}
                  multiple={true}
                />
                <div style={{ fontSize: 12, opacity: 0.75, marginTop: 8 }}>
                  Files are uploaded to a temporary bucket; results are written
                  only to explicitly allowed output buckets by templates.
                </div>
              </div>
            </div>
          </section>

          {assemblies.length > 0 && (
            <section
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 16,
              }}
            >
              {assemblies.map((a) => {
                const status = renderStatus(a);
                const pct = progressValue(a);
                const perFiles = fileProgress[a.assembly_id] || [];
                return (
                  <Card key={a.assembly_id} tone={status.tone}>
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        marginBottom: 8,
                      }}
                    >
                      <div style={{ fontWeight: 600 }}>
                        Assembly {a.assembly_id?.slice(-8)}
                      </div>
                      <div style={{ fontSize: 12, opacity: 0.85 }}>
                        {status.label}
                      </div>
                    </div>
                    <div style={{ marginBottom: 8 }}>
                      <ProgressBar value={pct} />
                    </div>
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        fontSize: 12,
                        opacity: 0.85,
                        marginBottom: 8,
                      }}
                    >
                      <div>
                        {typeof a.upload_progress_pct === "number" &&
                        a.upload_progress_pct < 100
                          ? `Uploading ${a.upload_progress_pct}%`
                          : a.current_step && a.steps_total
                          ? `Step ${a.current_step}/${a.steps_total}${
                              a.current_step_name
                                ? ` • ${a.current_step_name}`
                                : ""
                            }`
                          : a.message || "Pending"}
                      </div>
                      <div>{pct}%</div>
                    </div>

                    {perFiles.length > 0 && (
                      <div style={{ marginBottom: 8 }}>
                        <div
                          style={{
                            fontSize: 12,
                            opacity: 0.85,
                            marginBottom: 6,
                          }}
                        >
                          Upload progress
                        </div>
                        <ul
                          style={{
                            listStyle: "none",
                            padding: 0,
                            margin: 0,
                            display: "grid",
                            gap: 6,
                          }}
                        >
                          {perFiles.map((f, i) => (
                            <li key={i}>
                              <div
                                style={{
                                  display: "flex",
                                  justifyContent: "space-between",
                                  fontSize: 12,
                                  opacity: 0.85,
                                }}
                              >
                                <span
                                  style={{
                                    marginRight: 8,
                                    overflow: "hidden",
                                    textOverflow: "ellipsis",
                                    whiteSpace: "nowrap",
                                    maxWidth: 340,
                                  }}
                                >
                                  {f.name}
                                </span>
                                <span>{f.pct}%</span>
                              </div>
                              <ProgressBar value={f.pct} />
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {a.uploads && a.uploads.length > 0 && (
                      <details style={{ marginBottom: 8 }}>
                        <summary style={{ cursor: "pointer" }}>
                          Uploads ({a.uploads.length})
                        </summary>
                        <ul style={{ marginTop: 6, paddingLeft: 20 }}>
                          {a.uploads.map((u, i) => (
                            <li key={i}>
                              <strong>{u.name}</strong>
                              {typeof u.size === "number" && (
                                <span style={{ opacity: 0.75 }}>
                                  {" "}
                                  {(u.size / 1024).toFixed(1)} KB
                                </span>
                              )}
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}

                    {a.results && Object.keys(a.results).length > 0 && (
                      <details style={{ marginBottom: 8 }}>
                        <summary style={{ cursor: "pointer" }}>Results</summary>
                        <div style={{ marginTop: 6 }}>
                          {Object.entries(a.results).map(
                            ([stepName, results]) => (
                              <div key={stepName} style={{ marginBottom: 6 }}>
                                <strong>{stepName}</strong>
                                <ul style={{ paddingLeft: 20, marginTop: 4 }}>
                                  {(results as any[]).map((r, i) => (
                                    <li key={i}>
                                      {r.ssl_url ? (
                                        <a
                                          href={r.ssl_url}
                                          target="_blank"
                                          rel="noopener noreferrer"
                                        >
                                          {r.name}
                                        </a>
                                      ) : (
                                        r.name
                                      )}
                                      {typeof r.size === "number" && (
                                        <span style={{ opacity: 0.75 }}>
                                          {" "}
                                          {(r.size / 1024).toFixed(1)} KB
                                        </span>
                                      )}
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            )
                          )}
                        </div>
                      </details>
                    )}

                    {a.error && (
                      <div
                        style={{
                          background: "rgba(239,68,68,0.15)",
                          border: "1px solid rgba(239,68,68,0.35)",
                          color: "#fecaca",
                          borderRadius: 8,
                          padding: 8,
                          marginTop: 8,
                        }}
                      >
                        <strong>Error:</strong> {a.error}
                      </div>
                    )}
                  </Card>
                );
              })}
            </section>
          )}

          {assemblies.length > 0 && (
            <section style={{ marginTop: 24 }}>
              <details>
                <summary style={{ cursor: "pointer" }}>
                  Raw Data (debug)
                </summary>
                <pre
                  style={{
                    background: "#0b1226",
                    padding: 16,
                    borderRadius: 12,
                    overflow: "auto",
                    border: "1px solid rgba(255,255,255,0.15)",
                  }}
                >
                  {JSON.stringify(assemblies, null, 2)}
                </pre>
              </details>
            </section>
          )}
        </div>
      </main>
    </TransflowProvider>
  );
}

import React, { useState } from "react";
import { Uploader, AssemblyStatus } from "@xnetcat/transflow/browser";

export default function Home() {
  const [assemblies, setAssemblies] = useState<AssemblyStatus[]>([]);

  const handleUpdate = (assembly: AssemblyStatus) => {
    setAssemblies((prev) => {
      const existing = prev.findIndex(
        (a) => a.assembly_id === assembly.assembly_id
      );
      if (existing >= 0) {
        const updated = [...prev];
        updated[existing] = assembly;
        return updated;
      }
      return [...prev, assembly];
    });
  };

  const formatProgress = (assembly: AssemblyStatus) => {
    if (assembly.error) return "❌ Error";
    if (assembly.ok === "ASSEMBLY_COMPLETED") return "✅ Completed";
    return "🔄 Processing...";
  };

  const formatDuration = (assembly: AssemblyStatus) => {
    if (assembly.execution_duration) {
      return `${assembly.execution_duration.toFixed(1)}s`;
    }
    if (assembly.execution_start) {
      const elapsed =
        (Date.now() - new Date(assembly.execution_start).getTime()) / 1000;
      return `${elapsed.toFixed(1)}s`;
    }
    return "-";
  };

  return (
    <main style={{ padding: 24, fontFamily: "system-ui" }}>
      <h1>Transflow Example</h1>
      <p>
        Upload files to process with Transflow. Status is updated in real-time
        via DynamoDB polling.
      </p>

      <div style={{ marginBottom: 32 }}>
        <Uploader
          action="/api/create-upload"
          template="tpl_basic_audio"
          onUpdate={handleUpdate}
          multiple={true}
        />
      </div>

      {assemblies.length > 0 && (
        <div>
          <h2>Processing Status</h2>
          {assemblies.map((assembly) => (
            <div
              key={assembly.assembly_id}
              style={{
                border: "1px solid #ddd",
                borderRadius: 8,
                padding: 16,
                marginBottom: 16,
                backgroundColor: assembly.error
                  ? "#fef2f2"
                  : assembly.ok === "ASSEMBLY_COMPLETED"
                  ? "#f0fdf4"
                  : "#fefce8",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: 8,
                }}
              >
                <h3 style={{ margin: 0, fontSize: "1.1em" }}>
                  Assembly {assembly.assembly_id?.slice(-8)}
                </h3>
                <span style={{ fontSize: "0.9em", color: "#666" }}>
                  {formatDuration(assembly)}
                </span>
              </div>

              <div style={{ marginBottom: 8 }}>
                <strong>Status:</strong> {formatProgress(assembly)}{" "}
                {assembly.message}
              </div>

              {assembly.uploads && assembly.uploads.length > 0 && (
                <details style={{ marginBottom: 12 }}>
                  <summary style={{ cursor: "pointer", fontWeight: "bold" }}>
                    Uploads ({assembly.uploads.length})
                  </summary>
                  <ul style={{ marginTop: 8, paddingLeft: 20 }}>
                    {assembly.uploads.map((upload, i) => (
                      <li key={i} style={{ marginBottom: 4 }}>
                        <strong>{upload.name}</strong> (
                        {(upload.size / 1024).toFixed(1)} KB)
                        {upload.mime && (
                          <span style={{ color: "#666" }}>
                            {" "}
                            - {upload.mime}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </details>
              )}

              {assembly.results && Object.keys(assembly.results).length > 0 && (
                <details style={{ marginBottom: 12 }}>
                  <summary style={{ cursor: "pointer", fontWeight: "bold" }}>
                    Results ({Object.values(assembly.results).flat().length}{" "}
                    files)
                  </summary>
                  <div style={{ marginTop: 8 }}>
                    {Object.entries(assembly.results).map(
                      ([stepName, results]) => (
                        <div key={stepName} style={{ marginBottom: 8 }}>
                          <strong>{stepName}:</strong>
                          <ul style={{ paddingLeft: 20, marginTop: 4 }}>
                            {results.map((result, i) => (
                              <li key={i} style={{ marginBottom: 4 }}>
                                {result.ssl_url ? (
                                  <a
                                    href={result.ssl_url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                  >
                                    {result.name}
                                  </a>
                                ) : (
                                  result.name
                                )}
                                {result.size && (
                                  <span style={{ color: "#666" }}>
                                    {" "}
                                    ({(result.size / 1024).toFixed(1)} KB)
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

              {assembly.bytes_expected && (
                <div style={{ fontSize: "0.9em", color: "#666" }}>
                  Bytes: {assembly.bytes_received?.toLocaleString() || 0} /{" "}
                  {assembly.bytes_expected.toLocaleString()}
                  {assembly.bytes_usage &&
                    ` (${assembly.bytes_usage.toLocaleString()} processed)`}
                </div>
              )}

              {assembly.error && (
                <div
                  style={{
                    backgroundColor: "#fee2e2",
                    border: "1px solid #fecaca",
                    borderRadius: 4,
                    padding: 8,
                    marginTop: 8,
                    color: "#dc2626",
                  }}
                >
                  <strong>Error:</strong> {assembly.error}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {assemblies.length > 0 && (
        <details style={{ marginTop: 32 }}>
          <summary style={{ cursor: "pointer" }}>Raw Data (Debug)</summary>
          <pre
            style={{
              backgroundColor: "#f8f9fa",
              padding: 16,
              borderRadius: 4,
              overflow: "auto",
              fontSize: "0.8em",
            }}
          >
            {JSON.stringify(assemblies, null, 2)}
          </pre>
        </details>
      )}
    </main>
  );
}

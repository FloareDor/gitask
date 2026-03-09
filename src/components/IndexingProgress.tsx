"use client";

interface IndexingProgressProps {
  step: string;
  progress: number;        // 0–100
  filesProcessed?: number;
  totalFiles?: number;
  currentFile?: string;
}

export function IndexingProgress({
  step,
  progress,
  filesProcessed,
  totalFiles,
  currentFile,
}: IndexingProgressProps) {
  const pct = Math.min(100, Math.max(0, Math.round(progress)));

  return (
    <div style={{
      border: "2px solid #0a0a0a",
      padding: "24px 28px",
      boxShadow: "4px 4px 0 #0a0a0a",
      background: "#fff",
      borderRadius: 0,
      width: "100%",
      maxWidth: 480,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <span style={{
          fontFamily: "var(--font-display)",
          fontWeight: 700,
          fontSize: "0.9rem",
          color: "#0a0a0a",
          textTransform: "uppercase",
          letterSpacing: "0.05em",
        }}>
          Indexing
        </span>
        <span style={{
          fontFamily: "var(--font-mono)",
          fontWeight: 700,
          fontSize: "1.1rem",
          color: "var(--accent)",
        }}>
          {pct}%
        </span>
      </div>

      {/* Progress bar */}
      <div style={{
        height: 6,
        background: "#e5e5e5",
        border: "1px solid #ccc",
        borderRadius: 0,
        overflow: "hidden",
        marginBottom: 14,
      }}>
        <div style={{
          height: "100%",
          width: `${pct}%`,
          background: "var(--accent)",
          transition: "width 0.3s ease",
          borderRadius: 0,
        }} />
      </div>

      {/* Current step */}
      <p style={{
        fontSize: "0.85rem",
        color: "var(--text-secondary)",
        marginBottom: currentFile ? 6 : 0,
      }}>
        {step}
      </p>

      {/* Current file */}
      {currentFile && (
        <p style={{
          fontFamily: "var(--font-mono)",
          fontSize: "0.72rem",
          color: "var(--text-muted)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          marginBottom: 6,
        }}>
          {currentFile}
        </p>
      )}

      {/* File count */}
      {typeof filesProcessed === "number" && typeof totalFiles === "number" && (
        <p style={{
          fontFamily: "var(--font-mono)",
          fontSize: "0.75rem",
          color: "var(--text-muted)",
          marginTop: 4,
        }}>
          {filesProcessed} / {totalFiles} files
        </p>
      )}
    </div>
  );
}

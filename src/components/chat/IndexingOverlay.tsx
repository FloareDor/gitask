"use client";

import type { IndexProgress } from "@/lib/indexer";

interface IndexingOverlayProps {
	indexProgress: IndexProgress | null;
	progressPercent: number;
	timeRemaining: string | null;
	onRetry: () => void;
	isError?: boolean;
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function IndexingOverlay({
	indexProgress,
	progressPercent,
	timeRemaining,
	onRetry,
	isError,
}: IndexingOverlayProps) {
	if (isError && indexProgress?.message) {
		return (
			<div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
				<div style={{ border: "2px solid #dc2626", padding: "24px 28px", background: "var(--bg-card-dark)", maxWidth: 420, width: "100%", boxShadow: "4px 4px 0 #dc2626" }}>
					<p style={{ fontWeight: 700, color: "#dc2626", marginBottom: 8, fontFamily: "var(--font-display)", margin: "0 0 8px 0" }}>Something went wrong</p>
					<p style={{ fontSize: "13px", color: "var(--text-on-dark-secondary)", marginBottom: 16, lineHeight: 1.5 }}>{indexProgress.message}</p>
					<button onClick={onRetry} style={{ background: "#0a0a0a", color: "#f5f5f0", border: "2px solid #f5f5f0", padding: "10px 20px", cursor: "pointer", fontWeight: 700, fontSize: "13px" }}>
						Retry
					</button>
				</div>
			</div>
		);
	}

	return (
		<div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
			<div style={{ border: "2px solid var(--border-dark)", padding: "28px 32px", background: "var(--bg-card-dark)", maxWidth: 420, width: "100%", boxShadow: "var(--shadow-card-dark)" }}>
				<div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
					<span style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "0.9rem", textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text-on-dark)" }}>
						Indexing
					</span>
					<span style={{ fontFamily: "var(--font-mono)", fontWeight: 700, fontSize: "1.1rem", color: "#16a34a" }}>
						{progressPercent}%
					</span>
				</div>
				<div style={{ height: 6, background: "var(--bg-glass)", marginBottom: 14, border: "1px solid var(--border-dark)" }}>
					<div style={{ height: "100%", background: "#16a34a", width: `${progressPercent}%`, transition: "width 0.3s" }} />
				</div>
				<p style={{ fontSize: "0.85rem", color: "var(--text-on-dark-secondary)", marginBottom: 0 }}>
					{indexProgress?.message ?? "Starting..."}
				</p>
				{indexProgress?.estimatedSizeBytes != null && indexProgress.estimatedSizeBytes > 0 && (
					<p style={{ fontFamily: "var(--font-mono)", fontSize: "0.72rem", color: "var(--text-on-dark-muted)", margin: "4px 0 0 0" }}>
						~{formatBytes(indexProgress.estimatedSizeBytes)}
					</p>
				)}
				{timeRemaining && (
					<p style={{ fontFamily: "var(--font-mono)", fontSize: "0.72rem", color: "var(--text-on-dark-muted)", margin: "4px 0 0 0" }}>
						{timeRemaining} remaining
					</p>
				)}
			</div>
		</div>
	);
}

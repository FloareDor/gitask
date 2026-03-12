"use client";

import { useState } from "react";
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

// ── Doodle SVGs ──────────────────────────────────────────────────────────────

function DoodleStar({ size = 16, color = "#16a34a", style }: { size?: number; color?: string; style?: React.CSSProperties }) {
	return (
		<svg width={size} height={size} viewBox="0 0 20 20" fill="none" style={style} aria-hidden>
			<line x1="10" y1="1" x2="10" y2="19" stroke={color} strokeWidth="1.8" strokeLinecap="round" />
			<line x1="1" y1="10" x2="19" y2="10" stroke={color} strokeWidth="1.8" strokeLinecap="round" />
			<line x1="3.5" y1="3.5" x2="16.5" y2="16.5" stroke={color} strokeWidth="1.2" strokeLinecap="round" />
			<line x1="16.5" y1="3.5" x2="3.5" y2="16.5" stroke={color} strokeWidth="1.2" strokeLinecap="round" />
		</svg>
	);
}

function DoodleDashedCircle({ size = 22, color = "#16a34a", style }: { size?: number; color?: string; style?: React.CSSProperties }) {
	return (
		<svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={style} aria-hidden>
			<circle cx="12" cy="12" r="9" stroke={color} strokeWidth="1.5" strokeDasharray="3.5 2.5" strokeLinecap="round" />
		</svg>
	);
}

function DoodleSquiggle({ width = 72, color = "#2a2a2a", style }: { width?: number; color?: string; style?: React.CSSProperties }) {
	const h = 10;
	const d = `M0 ${h / 2} Q${width / 8} 0 ${width / 4} ${h / 2} Q${(3 * width) / 8} ${h} ${width / 2} ${h / 2} Q${(5 * width) / 8} 0 ${(3 * width) / 4} ${h / 2} Q${(7 * width) / 8} ${h} ${width} ${h / 2}`;
	return (
		<svg width={width} height={h} viewBox={`0 0 ${width} ${h}`} fill="none" style={style} aria-hidden>
			<path d={d} stroke={color} strokeWidth="1.5" strokeLinecap="round" fill="none" />
		</svg>
	);
}

function DoodleDot({ size = 5, color = "#16a34a", style }: { size?: number; color?: string; style?: React.CSSProperties }) {
	return (
		<svg width={size} height={size} viewBox="0 0 10 10" fill="none" style={style} aria-hidden>
			<circle cx="5" cy="5" r="4" stroke={color} strokeWidth="1.5" />
		</svg>
	);
}

function DoodleCoffee({ style }: { style?: React.CSSProperties }) {
	return (
		<svg width="30" height="30" viewBox="0 0 30 30" fill="none" style={style} aria-hidden>
			{/* Cup */}
			<path d="M6 11 L8 23 Q14 25.5 21 23 L23 11 Z" stroke="#555" strokeWidth="1.5" strokeLinejoin="round" fill="none" />
			{/* Handle */}
			<path d="M23 14 Q29 14 29 18 Q29 22 23 22" stroke="#555" strokeWidth="1.5" strokeLinecap="round" fill="none" />
			{/* Saucer */}
			<path d="M4 25 Q14 27.5 26 25" stroke="#555" strokeWidth="1.3" strokeLinecap="round" fill="none" />
			{/* Steam */}
			<path d="M11 8 Q12.5 5 11 2" stroke="#888" strokeWidth="1.3" strokeLinecap="round" />
			<path d="M15.5 7 Q17 4 15.5 1" stroke="#888" strokeWidth="1.3" strokeLinecap="round" />
			<path d="M20 8 Q21.5 5 20 2" stroke="#888" strokeWidth="1.3" strokeLinecap="round" />
		</svg>
	);
}

function DoodleZzz({ style }: { style?: React.CSSProperties }) {
	return (
		<svg width="36" height="22" viewBox="0 0 36 22" fill="none" style={style} aria-hidden>
			{/* Z shapes — hand-drawn feel with slightly wobbly paths */}
			<path d="M1 2 L7 2 L1 8 L7 8" stroke="#555" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" fill="none" />
			<path d="M10 6 L17 6 L10 13 L17 13" stroke="#666" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" fill="none" />
			<path d="M20 10 L29 10 L20 19 L29 19" stroke="#888" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none" />
		</svg>
	);
}

function BouncingDots() {
	return (
		<span style={{ display: "inline-flex", gap: 4, alignItems: "center", verticalAlign: "middle", marginLeft: 6 }}>
			{[0, 1, 2].map((i) => (
				<span
					key={i}
					style={{
						display: "inline-block",
						width: 5,
						height: 5,
						borderRadius: "50%",
						background: "#16a34a",
						animation: "gaDotBounce 1.4s ease-in-out infinite",
						animationDelay: `${i * 0.22}s`,
					}}
				/>
			))}
		</span>
	);
}

// ── Styles ───────────────────────────────────────────────────────────────────

const CSS = `
@keyframes gaFloat {
  0%, 100% { transform: translateY(0px) rotate(0deg); }
  33%       { transform: translateY(-9px) rotate(7deg); }
  66%       { transform: translateY(-4px) rotate(-5deg); }
}
@keyframes gaFloatB {
  0%, 100% { transform: translateY(0px) rotate(0deg); }
  40%       { transform: translateY(-6px) rotate(-6deg); }
  70%       { transform: translateY(-11px) rotate(4deg); }
}
@keyframes gaSpinSlow {
  from { transform: rotate(0deg); }
  to   { transform: rotate(360deg); }
}
@keyframes gaSpinSlowR {
  from { transform: rotate(0deg); }
  to   { transform: rotate(-360deg); }
}
@keyframes gaWiggle {
  0%, 100% { transform: rotate(-5deg) translateY(0); }
  50%       { transform: rotate(5deg)  translateY(-3px); }
}
@keyframes gaDotBounce {
  0%, 80%, 100% { opacity: 0.25; transform: scale(0.7); }
  40%           { opacity: 1;    transform: scale(1.15); }
}
@keyframes gaFadeIn {
  from { opacity: 0; transform: translateY(6px); }
  to   { opacity: 1; transform: translateY(0); }
}
@keyframes gaZzzDrift {
  0%, 100% { transform: translate(0, 0) rotate(-2deg); opacity: 0.55; }
  50%       { transform: translate(4px, -8px) rotate(3deg); opacity: 0.9; }
}
@keyframes gaProgressPulse {
  0%, 100% { filter: brightness(1); }
  50%       { filter: brightness(1.2); }
}
@keyframes gaSquiggleSlide {
  0%   { stroke-dashoffset: 120; opacity: 0; }
  20%  { opacity: 1; }
  100% { stroke-dashoffset: 0; opacity: 0.35; }
}
`;

// ── Component ─────────────────────────────────────────────────────────────────

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
					<p style={{ fontWeight: 700, color: "#dc2626", fontFamily: "var(--font-display)", margin: "0 0 8px 0" }}>Something went wrong</p>
					<p style={{ fontSize: "13px", color: "var(--text-on-dark-secondary)", marginBottom: 16, lineHeight: 1.5 }}>{indexProgress.message}</p>
					<button onClick={onRetry} style={{ background: "#0a0a0a", color: "#f5f5f0", border: "2px solid #f5f5f0", padding: "10px 20px", cursor: "pointer", fontWeight: 700, fontSize: "13px" }}>
						Retry
					</button>
				</div>
			</div>
		);
	}

	const [showDetails, setShowDetails] = useState(false);
	const isBigRepo = (indexProgress?.estimatedSizeBytes ?? 0) > 1.5 * 1024 * 1024;

	if (!isBigRepo) {
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

	return (
		<>
			<style>{CSS}</style>
			<div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
				<div
					style={{
						border: "2px solid var(--border-dark)",
						background: "var(--bg-card-dark)",
						maxWidth: 460,
						width: "100%",
						boxShadow: "var(--shadow-card-dark)",
						position: "relative",
						overflow: "hidden",
						animation: "gaFadeIn 0.4s ease both",
					}}
				>
					{/* ── Doodle header strip ─────────────────────────────── */}
					<div
						style={{
							borderBottom: "1px solid var(--border-dark)",
							padding: "18px 24px 16px",
							position: "relative",
							minHeight: 80,
							display: "flex",
							alignItems: "flex-end",
							gap: 10,
						}}
					>
						{/* Background dot grid */}
						<svg
							width="100%" height="100%"
							style={{ position: "absolute", inset: 0, opacity: 0.07, pointerEvents: "none" }}
							aria-hidden
						>
							<defs>
								<pattern id="ga-dots" x="0" y="0" width="14" height="14" patternUnits="userSpaceOnUse">
									<circle cx="2" cy="2" r="1" fill="#f5f5f0" />
								</pattern>
							</defs>
							<rect width="100%" height="100%" fill="url(#ga-dots)" />
						</svg>

						{/* Floating doodles */}
						<DoodleStar
							size={20}
							color="#16a34a"
							style={{ position: "absolute", top: 10, right: 22, animation: "gaFloat 3.2s ease-in-out infinite" }}
						/>
						<DoodleStar
							size={11}
							color="#2a2a2a"
							style={{ position: "absolute", top: 20, right: 52, animation: "gaFloatB 4.1s ease-in-out infinite", animationDelay: "0.9s" }}
						/>
						<DoodleDashedCircle
							size={24}
							color="#16a34a"
							style={{ position: "absolute", top: 8, left: 18, animation: "gaSpinSlow 9s linear infinite" }}
						/>
						<DoodleDashedCircle
							size={14}
							color="#2a2a2a"
							style={{ position: "absolute", top: 38, left: 46, animation: "gaSpinSlowR 6s linear infinite" }}
						/>
						<DoodleDot
							size={8}
							color="#16a34a"
							style={{ position: "absolute", top: 14, left: 52, animation: "gaFloat 2.8s ease-in-out infinite", animationDelay: "0.5s" }}
						/>
						<DoodleDot
							size={6}
							color="#2a2a2a"
							style={{ position: "absolute", top: 48, right: 38, animation: "gaFloatB 3.5s ease-in-out infinite", animationDelay: "1.4s" }}
						/>
						<DoodleZzz
							style={{ position: "absolute", top: 8, right: 90, animation: "gaZzzDrift 4s ease-in-out infinite", animationDelay: "0.3s" }}
						/>

						{/* Coffee cup — bottom-right corner of strip */}
						<DoodleCoffee
							style={{ position: "absolute", bottom: 10, right: 18, animation: "gaWiggle 4s ease-in-out infinite", animationDelay: "1s" }}
						/>

						{/* Squiggle decorations */}
						<DoodleSquiggle
							width={55}
							color="#16a34a"
							style={{ position: "absolute", bottom: 12, left: 24, opacity: 0.4 }}
						/>
					</div>

					{/* ── Body ────────────────────────────────────────────── */}
					<div style={{ padding: "20px 24px 24px" }}>

						{/* Headline */}
						<div style={{ marginBottom: 10 }}>
							<span
								style={{
									fontFamily: "var(--font-display)",
									fontWeight: 800,
									fontSize: "1.05rem",
									color: "var(--text-on-dark)",
									letterSpacing: "-0.01em",
								}}
							>
								Sit back &amp; relax
							</span>
							<BouncingDots />
						</div>

						{/* Friendly message */}
						<p
							style={{
								fontSize: "0.82rem",
								color: "var(--text-on-dark-secondary)",
								lineHeight: 1.65,
								marginBottom: 20,
							}}
						>
							indexing your repo. big codebases can take a few minutes.{" "}
							<span style={{ color: "#16a34a", fontWeight: 600 }}>
								you can leave this tab in the background
							</span>{" "}
							and come back when it&apos;s done!
						</p>

						{/* Progress bar (always visible, no label) */}
						<div style={{ marginBottom: 12 }}>
							<div
								style={{
									height: 7,
									background: "var(--bg-glass)",
									border: "1px solid var(--border-dark)",
									position: "relative",
									overflow: "hidden",
								}}
							>
								<div
									style={{
										height: "100%",
										background: "linear-gradient(90deg, #16a34a, #22c55e)",
										width: `${progressPercent}%`,
										transition: "width 0.4s ease",
										animation: "gaProgressPulse 2s ease-in-out infinite",
									}}
								/>
							</div>
						</div>

						{/* Collapsed toggle */}
						<button
							onClick={() => setShowDetails((v) => !v)}
							style={{
								background: "none",
								border: "none",
								padding: 0,
								cursor: "pointer",
								display: "flex",
								alignItems: "center",
								gap: 5,
								color: "var(--text-on-dark-muted)",
								fontFamily: "var(--font-mono)",
								fontSize: "0.68rem",
								letterSpacing: "0.04em",
							}}
						>
							<svg
								width="10" height="10" viewBox="0 0 10 10" fill="none"
								style={{ transition: "transform 0.2s", transform: showDetails ? "rotate(90deg)" : "rotate(0deg)" }}
								aria-hidden
							>
								<path d="M3 2 L7 5 L3 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
							</svg>
							{showDetails ? "hide details" : `${progressPercent}% · show details`}
						</button>

						{/* Expandable details */}
						{showDetails && (
							<div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 4 }}>
								<p style={{ fontSize: "0.78rem", color: "var(--text-on-dark-secondary)", margin: 0, lineHeight: 1.5, fontFamily: "var(--font-mono)" }}>
									{indexProgress?.message ?? "Starting…"}
								</p>
								<div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
									{indexProgress?.estimatedSizeBytes != null && indexProgress.estimatedSizeBytes > 0 && (
										<span style={{ fontFamily: "var(--font-mono)", fontSize: "0.68rem", color: "var(--text-on-dark-muted)" }}>
											~{formatBytes(indexProgress.estimatedSizeBytes)}
										</span>
									)}
									{timeRemaining && (
										<span style={{ fontFamily: "var(--font-mono)", fontSize: "0.68rem", color: "var(--text-on-dark-muted)" }}>
											{timeRemaining} remaining
										</span>
									)}
								</div>
							</div>
						)}
					</div>
				</div>
			</div>
		</>
	);
}

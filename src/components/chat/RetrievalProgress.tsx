"use client";

export type RetrievalPhase = "expanding" | "searching" | "refining";

export interface RetrievalProgressState {
	phase: RetrievalPhase;
	variants?: string[];
	refinedQuery?: string;
}

const PHASE_LABELS: Record<RetrievalPhase, string> = {
	expanding: "expanding queries",
	searching: "searching",
	refining: "refining",
};

export function RetrievalProgress({ phase, variants, refinedQuery }: RetrievalProgressState) {
	return (
		<div className="retrieval-progress">
			<div className="retrieval-progress-header">
				<span className="retrieval-progress-dot" aria-hidden="true" />
				<span className="retrieval-progress-phase">{PHASE_LABELS[phase]}</span>
			</div>
			{variants && variants.length > 0 && (
				<div className="retrieval-progress-queries">
					{variants.map((v, i) => (
						<div
							key={i}
							className={`retrieval-progress-query retrieval-progress-query--${i === 0 ? "orig" : "variant"}`}
							style={{ animationDelay: `${i * 0.08}s` }}
						>
							<span className="retrieval-progress-tag">{i === 0 ? "orig" : "+"}</span>
							<span className="retrieval-progress-text">{v}</span>
						</div>
					))}
					{refinedQuery && (
						<div
							className="retrieval-progress-query retrieval-progress-query--refined"
							style={{ animationDelay: `${variants.length * 0.08}s` }}
						>
							<span className="retrieval-progress-tag">↩</span>
							<span className="retrieval-progress-text">{refinedQuery}</span>
						</div>
					)}
				</div>
			)}
		</div>
	);
}

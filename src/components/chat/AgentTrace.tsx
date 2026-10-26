"use client";

import { memo, useState } from "react";
import type { MessageAgentState } from "@/app/[owner]/[repo]/types";

/** `{ pattern: "def ", glob: "*.py" }` → `pattern: "def ", glob: "*.py"` */
function formatArgs(args: Record<string, unknown>): string {
	const parts = Object.entries(args).map(([key, value]) => `${key}: ${JSON.stringify(value)}`);
	const line = parts.join(", ");
	return line.length > 90 ? `${line.slice(0, 90)}…` : line;
}

function formatBytes(bytes: number): string {
	return bytes < 1024 ? `${bytes}B` : `${(bytes / 1024).toFixed(1)}KB`;
}

const STOP_REASON_LABEL: Record<string, string> = {
	answered: "answered",
	step_cap: "hit step cap",
	context_budget: "hit context budget",
};

interface AgentTraceProps {
	agent: MessageAgentState;
	/** The run is still going, so the last row may have no result yet. */
	isLive: boolean;
}

export const AgentTrace = memo(function AgentTrace({ agent, isLive }: AgentTraceProps) {
	const [expanded, setExpanded] = useState(true);
	const [openRows, setOpenRows] = useState<Set<string>>(new Set());

	if (agent.steps.length === 0 && agent.notes.length === 0) return null;

	const toggleRow = (id: string) => {
		setOpenRows((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	};

	const summary = [
		`${agent.totalSteps ?? agent.steps.length} step${(agent.totalSteps ?? agent.steps.length) === 1 ? "" : "s"}`,
		agent.toolBytes != null ? formatBytes(agent.toolBytes) : null,
		agent.tokensIn != null ? `${agent.tokensIn + (agent.tokensOut ?? 0)} tok` : null,
		agent.elapsedMs != null ? `${(agent.elapsedMs / 1000).toFixed(1)}s` : null,
	].filter(Boolean).join(" · ");

	return (
		<div className="agent-trace">
			<button
				type="button"
				className="chat-sources-toggle"
				onClick={() => setExpanded((v) => !v)}
				aria-expanded={expanded}
			>
				<span
					className="chat-sources-chevron"
					style={{ transform: expanded ? "rotate(90deg)" : "rotate(0deg)" }}
					aria-hidden="true"
				>▸</span>
				{isLive ? "investigating…" : `trace — ${summary}`}
			</button>

			{expanded && (
				<div className="agent-trace-rows">
					{agent.notes.length > 0 && (
						<div className="agent-trace-notes">
							{agent.notes.map((note, i) => <p key={i}>{note}</p>)}
						</div>
					)}

					{agent.steps.map((step) => {
						const isOpen = openRows.has(step.id);
						const pending = step.result === undefined;
						return (
							<div key={step.id} className="agent-trace-row">
								<button
									type="button"
									className="agent-trace-head"
									onClick={() => toggleRow(step.id)}
									aria-expanded={isOpen}
									disabled={pending}
								>
									<span className="agent-trace-step">{step.step}</span>
									<span className="agent-trace-tool">{step.tool}</span>
									<span className="agent-trace-args">{formatArgs(step.args)}</span>
									<span className="agent-trace-meta">
										{pending && <span className="agent-trace-pending">running…</span>}
										{step.duplicate && <span className="agent-trace-flag">repeat</span>}
										{step.isError && <span className="agent-trace-flag agent-trace-flag--error">error</span>}
										{step.truncated && <span className="agent-trace-flag">truncated</span>}
										{step.bytes != null && step.bytes > 0 && <span>{formatBytes(step.bytes)}</span>}
										{step.elapsedMs != null && <span>{step.elapsedMs}ms</span>}
									</span>
								</button>
								{isOpen && step.result !== undefined && (
									<pre className="agent-trace-result">{step.result}</pre>
								)}
							</div>
						);
					})}

					{!isLive && agent.stopReason && agent.stopReason !== "answered" && (
						<div className="agent-trace-stop">
							⚠ {STOP_REASON_LABEL[agent.stopReason]} — the answer may be incomplete
						</div>
					)}
				</div>
			)}
		</div>
	);
});

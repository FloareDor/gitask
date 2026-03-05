import {
	buildScopedContext,
	type ContextAssemblyLimits,
	type ContextAssemblyMeta,
} from "./contextAssembly";
import type { SearchResult } from "./vectorStore";

export type InjectionRiskLevel = "none" | "low" | "medium" | "high";

export interface InjectionScanResult {
	level: InjectionRiskLevel;
	signals: string[];
	riskyChunkIds: string[];
	score: number;
}

export interface SafeContextResult {
	safeContext: string;
	meta: ContextAssemblyMeta;
	safeResults: SearchResult[];
	excludedCitationIds: Set<string>;
	redactedChunkIds: Set<string>;
}

type InjectionPattern = {
	name: string;
	pattern: RegExp;
	weight: number;
};

const INJECTION_PATTERNS: InjectionPattern[] = [
	{
		name: "ignore_previous_instructions",
		pattern: /\bignore\b[\s\S]{0,50}\b(previous|prior|above)\b[\s\S]{0,30}\b(instructions?|rules?)\b/gi,
		weight: 6,
	},
	{
		name: "system_prompt_override",
		pattern: /\b(system prompt|developer message|override.*instructions?|new system instructions?)\b/gi,
		weight: 5,
	},
	{
		name: "role_takeover",
		pattern: /\b(you are now|act as|pretend to be|roleplay)\b/gi,
		weight: 4,
	},
	{
		name: "safety_bypass",
		pattern: /\b(jailbreak|bypass safety|disable safety|ignore safety policy)\b/gi,
		weight: 6,
	},
	{
		name: "secret_exfiltration",
		pattern: /\b(reveal|print|dump|exfiltrat\w*)\b[\s\S]{0,60}\b(api[_\s-]?key|secret|token|password|credentials?)\b/gi,
		weight: 7,
	},
	{
		name: "tool_execution_coercion",
		pattern: /\b(execute command|run this command|call tool|function call|shell command)\b/gi,
		weight: 4,
	},
];

const INJECTION_REDACTION_PATTERNS = INJECTION_PATTERNS.map((p) => p.pattern);

function countPatternMatches(text: string, pattern: RegExp): number {
	const scoped = new RegExp(pattern.source, pattern.flags);
	return text.match(scoped)?.length ?? 0;
}

export function classifyInjectionRisk(
	score: number,
	riskyChunkCount: number,
	consideredChunkCount: number
): InjectionRiskLevel {
	if (consideredChunkCount === 0 || (score < 4 && riskyChunkCount === 0)) {
		return "none";
	}
	const dominance = consideredChunkCount > 0
		? riskyChunkCount / consideredChunkCount
		: 0;
	if (
		score >= 18 ||
		(riskyChunkCount >= 2 && dominance >= 0.5)
	) {
		return "high";
	}
	if (
		score >= 9 ||
		(riskyChunkCount >= 2 && dominance >= 0.3)
	) {
		return "medium";
	}
	return "low";
}

export function scanChunksForInjection(results: SearchResult[]): InjectionScanResult {
	const considered = results.slice(0, 8);
	if (considered.length === 0) {
		return { level: "none", signals: [], riskyChunkIds: [], score: 0 };
	}

	let score = 0;
	const riskyChunkIds: string[] = [];
	const signalCounts = new Map<string, number>();

	for (const result of considered) {
		const text = `${result.chunk.filePath}\n${result.chunk.code}`;
		let chunkScore = 0;
		for (const pattern of INJECTION_PATTERNS) {
			const matches = countPatternMatches(text, pattern.pattern);
			if (matches <= 0) continue;
			const boundedMatches = Math.min(matches, 2);
			chunkScore += pattern.weight * boundedMatches;
			signalCounts.set(pattern.name, (signalCounts.get(pattern.name) ?? 0) + boundedMatches);
		}

		if (chunkScore >= 6) {
			riskyChunkIds.push(result.chunk.id);
		}

		const weightedChunkScore = chunkScore * (result.score > 0 ? 1 : 0.6);
		score += weightedChunkScore;
	}

	const level = classifyInjectionRisk(score, riskyChunkIds.length, considered.length);
	const signals = [...signalCounts.entries()]
		.sort((a, b) => b[1] - a[1])
		.map(([name]) => name)
		.slice(0, 6);
	return { level, signals, riskyChunkIds, score: Number(score.toFixed(2)) };
}

export function sanitizeContextChunkText(text: string): {
	text: string;
	redactedLineCount: number;
	redactedLineRatio: number;
} {
	const lines = text.split("\n");
	if (lines.length === 0) {
		return { text, redactedLineCount: 0, redactedLineRatio: 0 };
	}

	let redactedLineCount = 0;
	const sanitizedLines = lines.map((line) => {
		const shouldRedact = INJECTION_REDACTION_PATTERNS.some((pattern) => {
			const scoped = new RegExp(pattern.source, pattern.flags);
			return scoped.test(line);
		});
		if (!shouldRedact) return line;
		redactedLineCount += 1;
		return "[UNTRUSTED_INSTRUCTION_REMOVED]";
	});

	return {
		text: sanitizedLines.join("\n"),
		redactedLineCount,
		redactedLineRatio: redactedLineCount / lines.length,
	};
}

export function shouldDropSanitizedChunk(
	chunk: SearchResult["chunk"],
	redactedLineRatio: number
): boolean {
	const path = chunk.filePath.toLowerCase();
	const likelyDoc =
		path.endsWith(".md") ||
		path.endsWith(".txt") ||
		path.endsWith(".rst") ||
		chunk.nodeType === "text_chunk";
	if (redactedLineRatio >= 0.4) return true;
	if (likelyDoc && redactedLineRatio >= 0.2) return true;
	return false;
}

export function buildSafeContext(
	results: SearchResult[],
	limits: ContextAssemblyLimits,
	scan: InjectionScanResult
): SafeContextResult {
	const riskyIds = new Set(scan.riskyChunkIds);
	const excludedCitationIds = new Set<string>();
	const redactedChunkIds = new Set<string>();
	const safeResults: SearchResult[] = [];

	for (const result of results) {
		if (!riskyIds.has(result.chunk.id)) {
			safeResults.push(result);
			continue;
		}

		excludedCitationIds.add(result.chunk.id);
		const sanitized = sanitizeContextChunkText(result.chunk.code);
		if (sanitized.redactedLineCount > 0) {
			redactedChunkIds.add(result.chunk.id);
		}
		if (shouldDropSanitizedChunk(result.chunk, sanitized.redactedLineRatio)) {
			continue;
		}
		safeResults.push({
			...result,
			chunk: {
				...result.chunk,
				code: sanitized.text,
			},
		});
	}

	const fallbackResults = safeResults.length > 0
		? safeResults
		: results.filter((result) => !riskyIds.has(result.chunk.id));
	const candidates = fallbackResults.map((result) => ({
		chunk: result.chunk,
		score: result.score,
	}));
	const assembled = buildScopedContext(candidates, limits);

	return {
		safeContext: assembled.context,
		meta: assembled.meta,
		safeResults: fallbackResults,
		excludedCitationIds,
		redactedChunkIds,
	};
}

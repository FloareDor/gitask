/**
 * Metrics — lightweight compute monitoring singleton.
 *
 * Records LLM, embedding, indexing, and search events.
 * Persists a ring-buffer of the last 200 events + aggregate counters to localStorage.
 */

const STORAGE_KEY = "gitask-metrics-v1";
const MAX_EVENTS = 200;

export type MetricEventType = "llm" | "embed" | "index" | "search";
export type LLMProvider = "gemini" | "mlc";

export interface MetricEvent {
	id: string;
	ts: number;
	type: MetricEventType;
	durationMs: number;
	provider?: LLMProvider;
	tokensIn?: number;
	tokensOut?: number;
	/** estimated or actual — "actual" means from usageMetadata */
	tokenAccuracy?: "estimated" | "actual";
	chunks?: number;
	files?: number;
	repo?: string;
}

export interface AggregateTotals {
	llmCalls: number;
	geminiCalls: number;
	mlcCalls: number;
	embedCalls: number;
	indexCalls: number;
	searchCalls: number;
	totalTokensIn: number;
	totalTokensOut: number;
	totalLLMMs: number;
	totalEmbedMs: number;
	totalIndexMs: number;
	totalSearchMs: number;
	totalChunksEmbedded: number;
	totalFilesIndexed: number;
}

export interface MetricsStore {
	events: MetricEvent[];
	totals: AggregateTotals;
}

function blankTotals(): AggregateTotals {
	return {
		llmCalls: 0,
		geminiCalls: 0,
		mlcCalls: 0,
		embedCalls: 0,
		indexCalls: 0,
		searchCalls: 0,
		totalTokensIn: 0,
		totalTokensOut: 0,
		totalLLMMs: 0,
		totalEmbedMs: 0,
		totalIndexMs: 0,
		totalSearchMs: 0,
		totalChunksEmbedded: 0,
		totalFilesIndexed: 0,
	};
}

function makeId(): string {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function loadStore(): MetricsStore {
	if (typeof window === "undefined") return { events: [], totals: blankTotals() };
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return { events: [], totals: blankTotals() };
		const parsed = JSON.parse(raw) as Partial<MetricsStore>;
		return {
			events: Array.isArray(parsed.events) ? parsed.events : [],
			totals: parsed.totals ? { ...blankTotals(), ...parsed.totals } : blankTotals(),
		};
	} catch {
		return { events: [], totals: blankTotals() };
	}
}

function saveStore(store: MetricsStore): void {
	if (typeof window === "undefined") return;
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
	} catch {
		// Ignore quota/restriction errors
	}
}

// In-memory cache so multiple calls within one page load don't thrash localStorage
let _store: MetricsStore | null = null;

function getStore(): MetricsStore {
	if (!_store) _store = loadStore();
	return _store;
}

function appendEvent(event: MetricEvent): void {
	const store = getStore();

	// Ring-buffer: keep last MAX_EVENTS
	store.events.push(event);
	if (store.events.length > MAX_EVENTS) {
		store.events.splice(0, store.events.length - MAX_EVENTS);
	}

	// Update aggregates
	const t = store.totals;
	if (event.type === "llm") {
		t.llmCalls += 1;
		if (event.provider === "gemini") t.geminiCalls += 1;
		if (event.provider === "mlc") t.mlcCalls += 1;
		t.totalTokensIn += event.tokensIn ?? 0;
		t.totalTokensOut += event.tokensOut ?? 0;
		t.totalLLMMs += event.durationMs;
	} else if (event.type === "embed") {
		t.embedCalls += 1;
		t.totalEmbedMs += event.durationMs;
		t.totalChunksEmbedded += event.chunks ?? 0;
	} else if (event.type === "index") {
		t.indexCalls += 1;
		t.totalIndexMs += event.durationMs;
		t.totalFilesIndexed += event.files ?? 0;
	} else if (event.type === "search") {
		t.searchCalls += 1;
		t.totalSearchMs += event.durationMs;
	}

	saveStore(store);
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function recordLLM(
	provider: LLMProvider,
	durationMs: number,
	tokensIn: number,
	tokensOut: number,
	tokenAccuracy: "estimated" | "actual" = "estimated",
	repo?: string
): void {
	appendEvent({
		id: makeId(),
		ts: Date.now(),
		type: "llm",
		durationMs,
		provider,
		tokensIn,
		tokensOut,
		tokenAccuracy,
		repo,
	});
}

export function recordEmbedding(chunks: number, durationMs: number): void {
	appendEvent({
		id: makeId(),
		ts: Date.now(),
		type: "embed",
		durationMs,
		chunks,
	});
}

export function recordIndex(
	files: number,
	chunks: number,
	durationMs: number,
	repo?: string
): void {
	appendEvent({
		id: makeId(),
		ts: Date.now(),
		type: "index",
		durationMs,
		files,
		chunks,
		repo,
	});
}

export function recordSearch(durationMs: number): void {
	appendEvent({
		id: makeId(),
		ts: Date.now(),
		type: "search",
		durationMs,
	});
}

export function getMetrics(): MetricsStore {
	return getStore();
}

export function clearMetrics(): void {
	_store = { events: [], totals: blankTotals() };
	saveStore(_store);
}

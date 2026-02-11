/**
 * Ablation Study Results — Static data for the /evals page.
 * Generated from vitest ablation.test.ts on 2026-02-11.
 */

export interface AblationResultEntry {
	config: string;
	description: string;
	avgRecallAt5: number;
	avgMRR: number;
	avgLatencyUs: number;
	/** Which features are active */
	features: {
		binaryQuantization: boolean;
		keywordSearch: boolean;
		rrfFusion: boolean;
		cosineRerank: boolean;
	};
}

export const ABLATION_RESULTS: AblationResultEntry[] = [
	{
		config: "Full Pipeline",
		description:
			"Binary quantization (Hamming) → Keyword search → RRF fusion → Cosine reranking",
		avgRecallAt5: 1.0,
		avgMRR: 1.0,
		avgLatencyUs: 522,
		features: {
			binaryQuantization: true,
			keywordSearch: true,
			rrfFusion: true,
			cosineRerank: true,
		},
	},
	{
		config: "No Quantization",
		description:
			"Full cosine vector search (float32) → Keyword search → RRF fusion → Cosine reranking",
		avgRecallAt5: 1.0,
		avgMRR: 1.0,
		avgLatencyUs: 290,
		features: {
			binaryQuantization: false,
			keywordSearch: true,
			rrfFusion: true,
			cosineRerank: true,
		},
	},
	{
		config: "Vector-Only",
		description:
			"Binary quantization (Hamming) → Cosine reranking only (no keyword, no RRF)",
		avgRecallAt5: 1.0,
		avgMRR: 1.0,
		avgLatencyUs: 242,
		features: {
			binaryQuantization: true,
			keywordSearch: false,
			rrfFusion: false,
			cosineRerank: true,
		},
	},
	{
		config: "No Reranking",
		description:
			"Binary quantization (Hamming) → Keyword search → RRF fusion → RRF-order output (no cosine reranking)",
		avgRecallAt5: 0.967,
		avgMRR: 0.867,
		avgLatencyUs: 325,
		features: {
			binaryQuantization: true,
			keywordSearch: true,
			rrfFusion: true,
			cosineRerank: false,
		},
	},
];

export interface CoveAnalysisEntry {
	aspect: string;
	observation: string;
}

export const COVE_ANALYSIS: CoveAnalysisEntry[] = [
	{
		aspect: "Hallucination Reduction",
		observation:
			"CoVe extracts up to 3 factual claims and verifies each against the codebase via hybrid search. This adds a self-correction pass that catches incorrect function names, wrong file paths, and fabricated API details.",
	},
	{
		aspect: "Latency Cost",
		observation:
			"Each CoVe pass requires 3 additional LLM calls (claim extraction + refinement) plus 3 embedding + search round-trips. On Qwen2-0.5B (q4f16_1), this adds ~2–4 seconds per response.",
	},
	{
		aspect: "Quality Trade-off",
		observation:
			"For short, factual queries (\"what does function X do?\"), CoVe rarely changes the answer. For complex multi-hop questions, CoVe corrects 15–30% of initial claims based on manual testing.",
	},
	{
		aspect: "Recommendation",
		observation:
			"CoVe is most valuable for multi-hop reasoning queries. A toggle or auto-detect (enable for questions with >2 hops) would be the optimal production strategy.",
	},
];

export const STORAGE_COMPARISON = {
	float32PerVector: 384 * 4, // 1536 bytes
	binaryPerVector: Math.ceil(384 / 32) * 4, // 48 bytes
	compressionRatio: 32,
	exampleRepoChunks: 500,
	get float32TotalKB() {
		return (this.float32PerVector * this.exampleRepoChunks) / 1024;
	},
	get binaryTotalKB() {
		return (this.binaryPerVector * this.exampleRepoChunks) / 1024;
	},
};

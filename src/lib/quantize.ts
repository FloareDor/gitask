/**
 * Binary Quantisation utilities for vector compression.
 *
 * Converts float32 embeddings into bit-packed Uint32Arrays (32× smaller)
 * and provides fast Hamming distance for nearest-neighbour search.
 */

/**
 * Binarise a float vector using sign-bit packing.
 * Each float > 0 becomes a 1-bit; <= 0 becomes 0-bit.
 * Bits are packed into Uint32Array segments (32 bits each).
 */
export function binarize(vec: Float32Array | number[]): Uint32Array {
	const len = vec.length;
	const segments = Math.ceil(len / 32);
	const bits = new Uint32Array(segments);

	for (let i = 0; i < len; i++) {
		if (vec[i] > 0) {
			const seg = (i / 32) | 0;
			const off = i % 32;
			bits[seg] |= 1 << off;
		}
	}

	return bits;
}

/**
 * Compute Hamming distance between two binary vectors.
 * Uses XOR + Kernighan's popcount trick.
 * Returns the number of differing bits (lower = more similar).
 */
export function hammingDistance(a: Uint32Array, b: Uint32Array): number {
	const len = Math.min(a.length, b.length);
	let dist = 0;

	for (let i = 0; i < len; i++) {
		let xor = a[i] ^ b[i];
		// Kernighan's bit-counting
		while (xor) {
			dist++;
			xor &= xor - 1;
		}
	}

	return dist;
}

/**
 * Cosine similarity between two float vectors.
 * Used for the Matryoshka reranking stage.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
	const len = Math.min(a.length, b.length);
	let dot = 0;
	let normA = 0;
	let normB = 0;

	for (let i = 0; i < len; i++) {
		dot += a[i] * b[i];
		normA += a[i] * a[i];
		normB += b[i] * b[i];
	}

	const denom = Math.sqrt(normA) * Math.sqrt(normB);
	return denom === 0 ? 0 : dot / denom;
}

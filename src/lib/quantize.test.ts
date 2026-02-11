/**
 * Tests for binary quantisation and Hamming distance.
 * These are the most critical mathematical primitives in the pipeline.
 */

import { describe, it, expect } from "vitest";
import { binarize, hammingDistance, cosineSimilarity } from "./quantize";

describe("binarize", () => {
	it("converts positive values to 1-bits and non-positive to 0-bits", () => {
		const vec = new Float32Array([1.0, -0.5, 0.3, -0.1, 0.0, 2.0, -3.0, 0.01]);
		const result = binarize(vec);

		// Expected: positions 0,2,5,7 are > 0 → bits set
		// Binary: 10100101 = bit 0 + bit 2 + bit 5 + bit 7
		// = 1 + 4 + 32 + 128 = 165
		expect(result[0]).toBe(165);
	});

	it("returns all zeros for all-negative vector", () => {
		const vec = new Float32Array([-1, -2, -3, -4]);
		const result = binarize(vec);
		expect(result[0]).toBe(0);
	});

	it("handles vectors longer than 32 dims (multiple segments)", () => {
		const vec = new Float32Array(64);
		vec[0] = 1;   // segment 0, bit 0
		vec[33] = 1;  // segment 1, bit 1
		const result = binarize(vec);
		expect(result.length).toBe(2);
		expect(result[0]).toBe(1);       // only bit 0 set
		expect(result[1]).toBe(2);       // bit 1 in second segment (33 % 32 = 1)
	});
});

describe("hammingDistance", () => {
	it("returns 0 for identical vectors", () => {
		const a = new Uint32Array([0b11010101]);
		const b = new Uint32Array([0b11010101]);
		expect(hammingDistance(a, b)).toBe(0);
	});

	it("counts differing bits correctly", () => {
		const a = new Uint32Array([0b1111]);
		const b = new Uint32Array([0b0000]);
		expect(hammingDistance(a, b)).toBe(4);
	});

	it("works with multi-segment vectors", () => {
		const a = new Uint32Array([0b1, 0b1]);
		const b = new Uint32Array([0b0, 0b0]);
		expect(hammingDistance(a, b)).toBe(2);
	});

	it("is symmetric", () => {
		const a = binarize(new Float32Array([0.1, -0.2, 0.3, -0.4, 0.5, -0.6, 0.7, -0.8]));
		const b = binarize(new Float32Array([-0.1, 0.2, -0.3, 0.4, -0.5, 0.6, -0.7, 0.8]));
		expect(hammingDistance(a, b)).toBe(hammingDistance(b, a));
	});

	it("similar vectors have smaller distance than dissimilar ones", () => {
		const base = new Float32Array([0.5, 0.3, -0.1, 0.8, -0.2, 0.4, -0.6, 0.1]);
		const similar = new Float32Array([0.6, 0.2, -0.05, 0.9, -0.3, 0.5, -0.7, 0.15]);
		const opposite = new Float32Array(base.map((v) => -v));

		const baseBin = binarize(base);
		const simBin = binarize(similar);
		const oppBin = binarize(opposite);

		expect(hammingDistance(baseBin, simBin)).toBeLessThan(
			hammingDistance(baseBin, oppBin)
		);
	});
});

describe("cosineSimilarity", () => {
	it("returns 1 for identical vectors", () => {
		const v = [0.5, 0.3, 0.8, 0.1];
		expect(cosineSimilarity(v, v)).toBeCloseTo(1.0, 5);
	});

	it("returns -1 for opposite vectors", () => {
		const a = [1, 0, 0];
		const b = [-1, 0, 0];
		expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0, 5);
	});

	it("returns 0 for orthogonal vectors", () => {
		const a = [1, 0];
		const b = [0, 1];
		expect(cosineSimilarity(a, b)).toBeCloseTo(0, 5);
	});

	it("returns 0 for zero vector", () => {
		const a = [1, 2, 3];
		const b = [0, 0, 0];
		expect(cosineSimilarity(a, b)).toBe(0);
	});
});

export type WebGPUAvailabilityReason =
	| "ok"
	| "insecure-context"
	| "missing-api"
	| "no-adapter"
	| "request-failed";

export interface WebGPUAvailability {
	supported: boolean;
	reason: WebGPUAvailabilityReason;
	error?: string;
}

export async function detectWebGPUAvailability(): Promise<WebGPUAvailability> {
	if (typeof window === "undefined" || typeof navigator === "undefined") {
		return { supported: false, reason: "missing-api" };
	}

	if (!window.isSecureContext) {
		return { supported: false, reason: "insecure-context" };
	}

	const gpu = (navigator as Navigator & {
		gpu?: { requestAdapter?: () => Promise<unknown | null> };
	}).gpu;

	if (!gpu?.requestAdapter) {
		return { supported: false, reason: "missing-api" };
	}

	try {
		const adapter = await gpu.requestAdapter();
		if (!adapter) {
			return { supported: false, reason: "no-adapter" };
		}

		return { supported: true, reason: "ok" };
	} catch (error) {
		return {
			supported: false,
			reason: "request-failed",
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

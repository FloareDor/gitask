export type WebGPUAvailabilityReason =
	| "ok"
	| "insecure-context"
	| "missing-api"
	| "no-adapter"
	| "no-device"
	| "request-failed";

export interface WebGPUAvailability {
	supported: boolean;
	reason: WebGPUAvailabilityReason;
	error?: string;
}

export function formatWebGPUReason(
	reason: WebGPUAvailabilityReason,
	error?: string
): string {
	switch (reason) {
		case "ok":
			return "WebGPU is available.";
		case "insecure-context":
			return "This page needs a secure connection to use WebGPU.";
		case "missing-api":
			return "WebGPU is not available in this browser. Try a browser with better WebGPU support, such as Chrome or Edge.";
		case "no-adapter":
			return "This device could not use the GPU for WebGPU.";
		case "no-device":
			return "The GPU was found, but WebGPU could not start.";
		case "request-failed":
			return "WebGPU could not start on this device.";
		default:
			return "WebGPU is unavailable.";
	}
}

export async function detectWebGPUAvailability(): Promise<WebGPUAvailability> {
	if (typeof window === "undefined" || typeof navigator === "undefined") {
		return { supported: false, reason: "missing-api" };
	}

	if (!window.isSecureContext) {
		return { supported: false, reason: "insecure-context" };
	}

	const gpu = (navigator as Navigator & {
		gpu?: {
			requestAdapter?: (options?: {
				powerPreference?: "high-performance" | "low-power";
			}) => Promise<GPUAdapterLike | null>;
		};
	}).gpu;

	if (!gpu?.requestAdapter) {
		return { supported: false, reason: "missing-api" };
	}

	try {
		const adapter = await gpu.requestAdapter({
			powerPreference: "high-performance",
		});
		if (!adapter) {
			return { supported: false, reason: "no-adapter" };
		}

		try {
			const device = await adapter.requestDevice();
			device.destroy?.();
		} catch (error) {
			return {
				supported: false,
				reason: "no-device",
				error: error instanceof Error ? error.message : String(error),
			};
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

interface GPUDeviceLike {
	destroy?: () => void;
}

interface GPUAdapterLike {
	requestDevice: () => Promise<GPUDeviceLike>;
}

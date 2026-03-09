import { afterEach, describe, expect, it } from "vitest";

import { resolveEmbedConfig } from "./embedder";

const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");

function setNavigatorStub(hardwareConcurrency: number, deviceMemory?: number) {
	Object.defineProperty(globalThis, "navigator", {
		value: {
			hardwareConcurrency,
			deviceMemory,
		},
		configurable: true,
	});
}

afterEach(() => {
	if (originalNavigator) {
		Object.defineProperty(globalThis, "navigator", originalNavigator);
	} else {
		// eslint-disable-next-line @typescript-eslint/no-dynamic-delete
		delete (globalThis as { navigator?: Navigator }).navigator;
	}
});

describe("resolveEmbedConfig", () => {
	it("uses larger WebGPU batches on stronger devices", () => {
		setNavigatorStub(16, 16);
		expect(resolveEmbedConfig("webgpu")).toEqual({ batchSize: 32, workerCount: 1 });

		setNavigatorStub(8, 8);
		expect(resolveEmbedConfig("webgpu")).toEqual({ batchSize: 24, workerCount: 1 });

		setNavigatorStub(4, 4);
		expect(resolveEmbedConfig("webgpu")).toEqual({ batchSize: 16, workerCount: 1 });
	});

	it("scales WASM batches and only enables parallel workers on beefy machines", () => {
		setNavigatorStub(16, 16);
		expect(resolveEmbedConfig("wasm")).toEqual({ batchSize: 8, workerCount: 2 });

		setNavigatorStub(8, 8);
		expect(resolveEmbedConfig("wasm")).toEqual({ batchSize: 6, workerCount: 1 });

		setNavigatorStub(4, 4);
		expect(resolveEmbedConfig("wasm")).toEqual({ batchSize: 4, workerCount: 1 });

		setNavigatorStub(2, 0);
		expect(resolveEmbedConfig("wasm")).toEqual({ batchSize: 2, workerCount: 1 });
	});
});

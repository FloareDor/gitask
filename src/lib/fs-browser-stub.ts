// Stub for Node.js built-ins in browser bundles.
// web-tree-sitter conditionally imports these but only uses them
// in Node.js (behind runtime checks). This stub satisfies the
// bundler without ever being called at runtime.
export async function readFile(): Promise<never> {
	throw new Error("not available in the browser");
}
export function createRequire(): never {
	throw new Error("not available in the browser");
}

import { describe, expect, test } from "vitest";
import { InMemoryV2BlobStore } from "../src/blobs.ts";

describe("InMemoryV2BlobStore", () => {
	test("deduplicates content by sha256 digest and returns bounded metadata", async () => {
		const store = new InMemoryV2BlobStore({ maxBytes: 32 });
		const first = await store.put(new TextEncoder().encode("hello"), "text/plain");
		const second = await store.put(new TextEncoder().encode("hello"), "text/plain");

		expect(second.digest).toBe(first.digest);
		expect(await store.stat(first.digest)).toEqual({ digest: first.digest, mimeType: "text/plain", size: 5 });
		expect(new TextDecoder().decode(await store.read(first.digest))).toBe("hello");
		await expect(store.put(new Uint8Array(33), "application/octet-stream")).rejects.toThrow("maximum size");
	});
});

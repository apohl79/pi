import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { FileV2BlobStore, InMemoryV2BlobStore } from "../src/blobs.ts";

describe("InMemoryV2BlobStore", () => {
	test("deduplicates content by sha256 digest and returns bounded metadata", async () => {
		const store = new InMemoryV2BlobStore({ maxBytes: 32, maxTotalBytes: 5, maxBlobs: 1 });
		const first = await store.put(new TextEncoder().encode("hello"), "text/plain");
		const second = await store.put(new TextEncoder().encode("hello"), "text/plain");

		expect(second.digest).toBe(first.digest);
		expect(await store.stat(first.digest)).toEqual({ digest: first.digest, mimeType: "text/plain", size: 5 });
		expect(new TextDecoder().decode(await store.read(first.digest))).toBe("hello");
		await expect(store.put(new TextEncoder().encode("world"), "text/plain")).rejects.toThrow("Blob count");
		await expect(store.put(new Uint8Array(33), "application/octet-stream")).rejects.toThrow("maximum size");
	});
});

describe("FileV2BlobStore", () => {
	test("verifies content-addressed files and reports corruption without repair", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-blobs-integrity-"));
		const store = new FileV2BlobStore(directory);
		const stat = await store.put(new TextEncoder().encode("hello"), "text/plain");
		expect(await store.verify()).toMatchObject({ ok: true, blobs: 1, bytes: 5, errors: [] });
		await writeFile(join(directory, `${stat.digest}.blob`), "corrupt");
		expect(await store.verify()).toMatchObject({ ok: false, blobs: 1, errors: [`content_mismatch:${stat.digest}`] });
	});

	test("enforces aggregate filesystem blob quotas while allowing deduplication", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-blobs-quota-"));
		const store = new FileV2BlobStore(directory, { maxTotalBytes: 5, maxBlobs: 1 });
		await store.put(new TextEncoder().encode("hello"), "text/plain");
		await store.put(new TextEncoder().encode("hello"), "text/plain");
		await expect(store.put(new TextEncoder().encode("world"), "text/plain")).rejects.toThrow("Blob count");
	});
});

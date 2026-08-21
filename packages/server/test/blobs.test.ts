import { describe, expect, test } from "vitest";
import { mkdtemp, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileV2BlobStore, InMemoryV2BlobStore } from "../src/blobs.ts";

describe("InMemoryV2BlobStore", () => {
	test("deduplicates content by sha256 digest and returns bounded metadata", async () => {
		const store = new InMemoryV2BlobStore({ maxBytes: 32 });
		const first = await store.put(new TextEncoder().encode("hello"), "text/plain");
		const second = await store.put(new TextEncoder().encode("hello"), "text/plain");

		expect(second.digest).toBe(first.digest);
		expect(await store.stat(first.digest)).toEqual({ digest: first.digest, mimeType: "text/plain", size: 5 });
		expect(new TextDecoder().decode(await store.read(first.digest))).toBe("hello");
		await expect(store.put(new Uint8Array(33), "application/octet-stream")).rejects.toThrow("maximum size");
		await expect(store.put(new Uint8Array([1]), "text/\u0000plain")).rejects.toThrow("MIME");
	});

	test("enforces total byte and blob count quotas", async () => {
		const store = new InMemoryV2BlobStore({ maxBytes: 4, maxTotalBytes: 5, maxBlobCount: 1 });
		await store.put(new Uint8Array([1, 2, 3]), "application/octet-stream");
		await expect(store.put(new Uint8Array([4]), "application/octet-stream")).rejects.toThrow("count");
		expect(() => new InMemoryV2BlobStore({ maxBytes: 4, maxTotalBytes: 3 })).toThrow();
		const byteStore = new InMemoryV2BlobStore({ maxBytes: 3, maxTotalBytes: 3, maxBlobCount: 4 });
		await byteStore.put(new Uint8Array([1, 2]), "application/octet-stream");
		await expect(byteStore.put(new Uint8Array([3, 4]), "application/octet-stream")).rejects.toThrow("store");
	});
});

describe("FileV2BlobStore", () => {
	test("validates digest paths and stored integrity", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-blobs-"));
		const store = new FileV2BlobStore(root, { maxBytes: 32 });
		const metadata = await store.put(new TextEncoder().encode("hello"), "text/plain");
		expect(await store.stat(metadata.digest)).toEqual(metadata);
		await expect(store.read("../unsafe")).rejects.toThrow("Invalid blob digest");
		await writeFile(join(root, `${metadata.digest}.blob`), "xxxxx");
		await expect(store.read(metadata.digest)).rejects.toThrow("digest mismatch");
		await writeFile(join(root, `${metadata.digest}.blob`), "tampered");
		await expect(store.stat(metadata.digest)).rejects.toThrow("size mismatch");
		await writeFile(join(root, `${metadata.digest}.blob`), new Uint8Array(33));
		await expect(store.stat(metadata.digest)).rejects.toThrow("maximum size");
		await expect(store.put(new Uint8Array([1]), "text/\u007fplain")).rejects.toThrow("MIME");
	});

	test("enforces total byte and blob count quotas", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-blobs-"));
		const store = new FileV2BlobStore(root, { maxBytes: 4, maxTotalBytes: 5, maxBlobCount: 1 });
		await store.put(new Uint8Array([1, 2, 3]), "application/octet-stream");
		await expect(store.put(new Uint8Array([4]), "application/octet-stream")).rejects.toThrow("count");
		expect(() => new FileV2BlobStore(root, { maxBytes: 4, maxTotalBytes: 3 })).toThrow();

		const byteStore = new FileV2BlobStore(await mkdtemp(join(tmpdir(), "pi-blobs-")), {
			maxBytes: 3,
			maxTotalBytes: 3,
			maxBlobCount: 4,
		});
		await byteStore.put(new Uint8Array([1, 2]), "application/octet-stream");
		await expect(byteStore.put(new Uint8Array([3, 4]), "application/octet-stream")).rejects.toThrow("store");
	});

	test("publishes complete metadata under concurrent writes", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-blobs-"));
		const store = new FileV2BlobStore(root);
		const data = new TextEncoder().encode("concurrent");
		const stats = await Promise.all(Array.from({ length: 8 }, () => store.put(data, "text/plain")));
		expect(new Set(stats.map((stat) => stat.digest)).size).toBe(1);
		expect(JSON.parse(await readFile(join(root, `${stats[0].digest}.json`), "utf8"))).toEqual(stats[0]);
	});

	test("rejects symlinked metadata and blob files", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-blobs-"));
		const outside = await mkdtemp(join(tmpdir(), "pi-blobs-outside-"));
		const store = new FileV2BlobStore(root);
		const metadata = await store.put(new TextEncoder().encode("hello"), "text/plain");
		const metadataPath = join(root, `${metadata.digest}.json`);
		const blobPath = join(root, `${metadata.digest}.blob`);
		await writeFile(join(outside, "metadata.json"), JSON.stringify(metadata));
		await writeFile(join(outside, "blob"), "hello");
		await unlink(metadataPath);
		await symlink(join(outside, "metadata.json"), metadataPath);
		await expect(store.stat(metadata.digest)).rejects.toThrow("not a regular file");

		await unlink(metadataPath);
		await writeFile(metadataPath, JSON.stringify(metadata));
		await unlink(blobPath);
		await symlink(join(outside, "blob"), blobPath);
		await expect(store.read(metadata.digest)).rejects.toThrow("not a regular file");
	});
});

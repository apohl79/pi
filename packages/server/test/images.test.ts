import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { InMemoryV2BlobStore } from "../src/blobs.ts";
import { LocalV2FileReferenceService } from "../src/files.ts";
import { BlobV2ImageService } from "../src/images.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
	directories.length = 0;
});

describe("BlobV2ImageService", () => {
	test("views local images through a content-addressed blob", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-images-"));
		directories.push(root);
		await writeFile(join(root, "image.png"), new Uint8Array([137, 80, 78, 71]));
		const service = new BlobV2ImageService(
			new LocalV2FileReferenceService({ projectRoot: root, homeDirectory: root }),
			new InMemoryV2BlobStore(),
		);

		expect(await service.view("session-1", "image.png")).toMatchObject({
			mimeType: "image/png",
			size: 4,
			reference: "image.png",
		});
	});

	test("records generation provenance and prompt hash", async () => {
		const service = new BlobV2ImageService(
			new LocalV2FileReferenceService({ projectRoot: "." }),
			new InMemoryV2BlobStore(),
			{
				generate: async () => ({
					data: new Uint8Array([1, 2]),
					mimeType: "image/png",
					provider: "fake",
					model: "image-fast",
					dimensions: { width: 1, height: 2 },
					costUsd: 0.01,
				}),
			},
		);

		expect(await service.generate("session-1", { prompt: "draw a tree" })).toMatchObject({
			mimeType: "image/png",
			provider: "fake",
			model: "image-fast",
			dimensions: { width: 1, height: 2 },
			costUsd: 0.01,
		});
	});
});

import { tmpdir } from "node:os";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { ModelInstructionResolver } from "../../src/server/model-instructions.ts";

describe("ModelInstructionResolver limits", () => {
	test.each([Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 1.5, 16 * 1024 * 1024 + 1])(
		"rejects invalid maxBytes: %s",
		(maxBytes) => {
		expect(
			() =>
				new ModelInstructionResolver([], {
					cwd: "/workspace",
					maxBytes,
				}),
		).toThrow(/maxBytes must be a positive safe integer/);
		},
	);

	test("rejects oversized files before returning their contents", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-model-instructions-"));
		try {
			await writeFile(join(directory, "profile.md"), "0123456789", "utf8");
			const trustedDirectory = await realpath(directory);
			const resolver = new ModelInstructionResolver(
				[{ id: "profile", provider: "test", model: "model", mode: "append", file: "profile.md" }],
				{ cwd: trustedDirectory, trustedRoots: [trustedDirectory], maxBytes: 8 },
			);
			await expect(resolver.resolve({ provider: "test", id: "model" })).rejects.toThrow("8-byte limit");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("reads files within the configured byte limit", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-model-instructions-"));
		try {
			await writeFile(join(directory, "profile.md"), "hello", "utf8");
			const trustedDirectory = await realpath(directory);
			const resolver = new ModelInstructionResolver(
				[{ id: "profile", provider: "test", model: "model", mode: "append", file: "profile.md" }],
				{ cwd: trustedDirectory, trustedRoots: [trustedDirectory], maxBytes: 8 },
			);
			expect(await resolver.resolve({ provider: "test", id: "model" })).toMatchObject({ text: "hello", byteLength: 5 });
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});

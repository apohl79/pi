import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { ModelConfig } from "../src/core/model-config.ts";

describe("ModelConfig compaction overrides", () => {
	test("resolves provider-local model roles", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-model-roles-"));
		const path = join(directory, "models.json");
		try {
			await writeFile(
				path,
				JSON.stringify({
					providers: { faux: {} },
					modelRoles: { faux: { fast: "fast-model" } },
				}),
			);
			const config = await ModelConfig.load(path);
			expect(config.getModelRole("faux", "fast")).toBe("fast-model");
			expect(config.getModelRole("other", "fast")).toBeUndefined();
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("merges model and provider/model override fields", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-model-config-"));
		const path = join(directory, "models.json");
		try {
			await writeFile(
				path,
				JSON.stringify({
					providers: {
						faux: {
							models: [{ id: "large", compaction: { reserveTokens: 200, keepRecentTokens: 500 } }],
							modelOverrides: { large: { compaction: { keepRecentTokens: 700 } } },
						},
					},
				}),
			);
			const config = await ModelConfig.load(path);
			expect(config.getCompactionOverride("faux", "large")).toEqual({ reserveTokens: 200, keepRecentTokens: 700 });
			expect(config.getCompactionOverride("faux", "missing")).toBeUndefined();
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("rejects unsafe or context-incompatible compaction policies", async () => {
		const cases = [
			{
				compaction: { reserveTokens: 10_000, keepRecentTokens: 100 },
				expected: "reserveTokens",
			},
			{
				compaction: { reserveTokens: 100, keepRecentTokens: 9_901 },
				expected: "keepRecentTokens",
			},
			{
				compaction: { reserveTokens: Number.MAX_SAFE_INTEGER + 1 },
				expected: "safe integer",
			},
		] as const;
		for (const [index, candidate] of cases.entries()) {
			const directory = await mkdtemp(join(tmpdir(), "pi-model-config-invalid-"));
			const path = join(directory, "models.json");
			try {
				await writeFile(
					path,
					JSON.stringify({
						providers: {
							faux: {
								models: [{ id: `model-${index}`, contextWindow: 10_000, compaction: candidate.compaction }],
							},
						},
					}),
				);
				const config = await ModelConfig.load(path);
				expect(config.getError()).toContain(candidate.expected);
			} finally {
				await rm(directory, { recursive: true, force: true });
			}
		}
	});
});

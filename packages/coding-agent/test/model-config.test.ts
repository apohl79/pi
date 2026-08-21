import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { ModelConfig } from "../src/core/model-config.ts";

describe("ModelConfig compaction overrides", () => {
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
});

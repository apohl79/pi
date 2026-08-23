import { describe, expect, test } from "vitest";
import { AdapterV2WebService, assertSafeWebUrl, type V2WebAdapter } from "../src/web.ts";

describe("AdapterV2WebService", () => {
	test("bounds adapter results and extracts while preserving provenance", async () => {
		const adapter: V2WebAdapter = {
			execute: async () => [
				{
					id: "r1",
					title: "One",
					source: "fake",
					retrievedAt: 1,
					url: "https://example.test/a",
					extract: "123456",
				},
				{ id: "r2", title: "Two", source: "fake", retrievedAt: 2, extract: "second" },
			],
		};
		const service = new AdapterV2WebService(adapter, { maxResults: 1, maxExtractBytes: 3 });

		expect(await service.execute("session-1", { operation: "search_query", query: "pi" })).toEqual([
			{ id: "r1", title: "One", source: "fake", retrievedAt: 1, url: "https://example.test/a", extract: "123" },
		]);
	});

	test("rejects private and credential-bearing URLs", () => {
		expect(() => assertSafeWebUrl("http://127.0.0.1/admin")).toThrow("private network");
		expect(() => assertSafeWebUrl("http://169.254.169.254/latest/meta-data")).toThrow("private network");
		expect(() => assertSafeWebUrl("http://[::ffff:127.0.0.1]/admin")).toThrow("private network");
		expect(() => assertSafeWebUrl("http://[::1]/admin")).toThrow("private network");
		expect(() => assertSafeWebUrl("https://user:pass@example.test")).toThrow("credentials");
	});

	test("bounds extracts in UTF-8 bytes without splitting code points", async () => {
		const adapter: V2WebAdapter = {
			execute: async () => [{ id: "unicode", title: "Unicode", source: "fake", retrievedAt: 1, extract: "🙂z" }],
		};
		const service = new AdapterV2WebService(adapter, { maxExtractBytes: 4 });

		expect(await service.execute("session-1", { operation: "search_query", query: "unicode" })).toMatchObject([
			{ extract: "🙂" },
		]);
	});
});

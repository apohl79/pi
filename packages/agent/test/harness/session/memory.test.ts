import { describe, expect, it } from "vitest";
import { InMemorySessionRepo, InMemorySessionStorage, Session } from "../../../src/harness/session/index.ts";
import {
	createSessionBackendConformance,
	type SessionBackendFixture,
} from "../../../src/harness/session/testing/index.ts";

const conformance = createSessionBackendConformance(() =>
	Promise.resolve<SessionBackendFixture>({
		repository: new InMemorySessionRepo(),
		[Symbol.asyncDispose]: () => Promise.resolve(),
	}),
);

describe("InMemorySessionRepo conformance", () => {
	for (const group of new Set(conformance.map((testCase) => testCase.group))) {
		describe(group, () => {
			for (const testCase of conformance.filter((candidate) => candidate.group === group)) {
				it(testCase.name, () => testCase.run());
			}
		});
	}
});

describe("Session with in-memory storage", () => {
	it("publishes record batches all-or-none", async () => {
		const session = new Session(new InMemorySessionStorage({ id: "batch", createdAt: 1 }));
		await expect(
			session.appendRecords([
				{
					type: "usage",
					id: "usage-1",
					lane: "main",
					usage: {
						input: 1,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 1,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					cause: "adjustment",
				},
				{
					type: "usage",
					id: "usage-1",
					lane: "main",
					usage: {
						input: 2,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					cause: "adjustment",
				},
			]),
		).rejects.toThrow("already exists");
		expect(await session.findRecords({ type: "usage" })).toEqual([]);

		const committed = await session.appendRecords([
			{
				type: "usage",
				id: "usage-1",
				lane: "main",
				usage: {
					input: 1,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 1,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				cause: "adjustment",
			},
			{
				type: "usage",
				id: "usage-2",
				lane: "main",
				usage: {
					input: 2,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				cause: "adjustment",
			},
		]);
		expect(committed.map((record) => record.id)).toEqual(["usage-1", "usage-2"]);
	});

	it("uses one injectable id generator across lane views", async () => {
		let nextId = 0;
		const session = new Session(new InMemorySessionStorage({ id: "session", createdAt: 1 }), {
			idGenerator: { next: () => `generated-${++nextId}` },
		});
		const mainId = await session.appendCustomEntry("note");
		await session.createLane("thread", mainId);
		const threadId = await session.view("thread").appendCustomEntry("note");

		expect(mainId).toBe("generated-1");
		expect(threadId).toBe("generated-2");
	});

	it("rejects unsafe pagination values before querying storage", async () => {
		const session = new Session(new InMemorySessionStorage({ id: "session", createdAt: 1 }));
		await expect(session.findEntries({ limit: Number.MAX_SAFE_INTEGER + 1 })).rejects.toThrow("limit");
		await expect(session.findRecords({ afterSeq: Number.MAX_SAFE_INTEGER + 1 })).rejects.toThrow("cursor");
	});
});

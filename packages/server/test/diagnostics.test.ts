import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { InMemoryForensicRecorder, JsonlForensicRecorder } from "../src/diagnostics.ts";

describe("InMemoryForensicRecorder", () => {
	test("assigns correlated sequence numbers and redacts credential fields", async () => {
		const recorder = new InMemoryForensicRecorder({ maxEvents: 2 });
		await recorder.record({
			kind: "operation_accepted",
			sessionId: "session",
			operationId: "operation",
			payload: { token: "secret", nested: { password: "hidden" }, value: "safe" },
		});
		const second = await recorder.record({
			kind: "operation_terminal",
			sessionId: "session",
			operationId: "operation",
		});
		const events = await recorder.read();
		expect(events).toHaveLength(2);
		expect(events[0]).toMatchObject({ seq: 1, sessionId: "session", operationId: "operation" });
		expect(events[0]?.payload).toEqual({ token: "[REDACTED]", nested: { password: "[REDACTED]" }, value: "safe" });
		expect(second.seq).toBe(2);
		expect(await recorder.read(1)).toHaveLength(1);
	});

	test("bounds retained events", async () => {
		const recorder = new InMemoryForensicRecorder({ maxEvents: 2 });
		await recorder.record({ kind: "one" });
		await recorder.record({ kind: "two" });
		await recorder.record({ kind: "three" });
		expect((await recorder.read()).map((event) => event.kind)).toEqual(["two", "three"]);
	});

	test("redacts common credential key casing and separators", async () => {
		const recorder = new InMemoryForensicRecorder();
		const event = await recorder.record({
			kind: "credentials",
			payload: {
				API_KEY: "one",
				"api-key": "two",
				access_token: "three",
				"client-secret": "four",
				"x-api-key": "five",
			},
		});

		expect(event.payload).toEqual({
			API_KEY: "[REDACTED]",
			"api-key": "[REDACTED]",
			access_token: "[REDACTED]",
			"client-secret": "[REDACTED]",
			"x-api-key": "[REDACTED]",
		});
	});

	test("redacts sensitive key substrings and credential-shaped values", async () => {
		const recorder = new InMemoryForensicRecorder();
		const event = await recorder.record({
			kind: "credentials",
			payload: {
				providerAuthorizationHeader: "Bearer abcdefghijklmnop",
				nested: { databasePasswordHash: "hidden" },
				bearer: "Bearer abcdefghijklmnop",
				assignment: "token=abcdefghijk",
				apiKeyValue: "sk-aaaaaaaa",
				safe: "ordinary diagnostic text",
			},
		});

		expect(event.payload).toEqual({
			providerAuthorizationHeader: "[REDACTED]",
			nested: { databasePasswordHash: "[REDACTED]" },
			bearer: "[REDACTED]",
			assignment: "[REDACTED]",
			apiKeyValue: "[REDACTED]",
			safe: "ordinary diagnostic text",
		});
	});

	test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid maxEvents: %s", (maxEvents) => {
		expect(() => new InMemoryForensicRecorder({ maxEvents })).toThrow(
			"maxEvents must be a finite integer greater than or equal to 1",
		);
	});
});

describe("JsonlForensicRecorder", () => {
	test("recovers sequence and redaction state after restart", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-diagnostics-"));
		const path = join(directory, "nested", "events.jsonl");
		const first = new JsonlForensicRecorder(path, { maxEvents: 3 });
		await first.record({ kind: "boot", payload: { token: "secret" } });
		await first.record({ kind: "accepted" });

		const reopened = new JsonlForensicRecorder(path, { maxEvents: 3 });
		const event = await reopened.record({ kind: "terminal" });
		expect(event.seq).toBe(3);
		expect((await reopened.read()).map((item) => item.kind)).toEqual(["boot", "accepted", "terminal"]);
		expect((await reopened.read())[0]?.payload).toEqual({ token: "[REDACTED]" });
	});

	test("bounds the retained JSONL window while preserving monotonic sequence", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-diagnostics-bounded-"));
		const recorder = new JsonlForensicRecorder(join(directory, "events.jsonl"), { maxEvents: 2 });
		await recorder.record({ kind: "one" });
		await recorder.record({ kind: "two" });
		await recorder.record({ kind: "three" });
		expect((await recorder.read()).map((event) => event.seq)).toEqual([2, 3]);
	});
});

describe("JsonlForensicRecorder", () => {
	test("recovers sequence and redaction state after restart", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-diagnostics-"));
		const path = join(directory, "nested", "events.jsonl");
		const first = new JsonlForensicRecorder(path, { maxEvents: 3 });
		await first.record({ kind: "boot", payload: { token: "secret" } });
		await first.record({ kind: "accepted" });

		const reopened = new JsonlForensicRecorder(path, { maxEvents: 3 });
		const event = await reopened.record({ kind: "terminal" });
		expect(event.seq).toBe(3);
		expect((await reopened.read()).map((item) => item.kind)).toEqual(["boot", "accepted", "terminal"]);
		expect((await reopened.read())[0]?.payload).toEqual({ token: "[REDACTED]" });
	});

	test("bounds the retained JSONL window while preserving monotonic sequence", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-diagnostics-bounded-"));
		const recorder = new JsonlForensicRecorder(join(directory, "events.jsonl"), { maxEvents: 2 });
		await recorder.record({ kind: "one" });
		await recorder.record({ kind: "two" });
		await recorder.record({ kind: "three" });
		expect((await recorder.read()).map((event) => event.seq)).toEqual([2, 3]);
	});
});

describe("JsonlForensicRecorder", () => {
	test("recovers sequence and redaction state after restart", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-diagnostics-"));
		const path = join(directory, "nested", "events.jsonl");
		const first = new JsonlForensicRecorder(path, { maxEvents: 3 });
		await first.record({ kind: "boot", payload: { token: "secret" } });
		await first.record({ kind: "accepted" });

		const reopened = new JsonlForensicRecorder(path, { maxEvents: 3 });
		const event = await reopened.record({ kind: "terminal" });
		expect(event.seq).toBe(3);
		expect((await reopened.read()).map((item) => item.kind)).toEqual(["boot", "accepted", "terminal"]);
		expect((await reopened.read())[0]?.payload).toEqual({ token: "[REDACTED]" });
	});

	test("bounds the retained JSONL window while preserving monotonic sequence", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-diagnostics-bounded-"));
		const recorder = new JsonlForensicRecorder(join(directory, "events.jsonl"), { maxEvents: 2 });
		await recorder.record({ kind: "one" });
		await recorder.record({ kind: "two" });
		await recorder.record({ kind: "three" });
		expect((await recorder.read()).map((event) => event.seq)).toEqual([2, 3]);
	});
});

describe("JsonlForensicRecorder", () => {
	test("recovers sequence and redaction state after restart", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-diagnostics-"));
		const path = join(directory, "nested", "events.jsonl");
		const first = new JsonlForensicRecorder(path, { maxEvents: 3 });
		await first.record({ kind: "boot", payload: { token: "secret" } });
		await first.record({ kind: "accepted" });

		const reopened = new JsonlForensicRecorder(path, { maxEvents: 3 });
		const event = await reopened.record({ kind: "terminal" });
		expect(event.seq).toBe(3);
		expect((await reopened.read()).map((item) => item.kind)).toEqual(["boot", "accepted", "terminal"]);
		expect((await reopened.read())[0]?.payload).toEqual({ token: "[REDACTED]" });
	});

	test("bounds the retained JSONL window while preserving monotonic sequence", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-diagnostics-bounded-"));
		const recorder = new JsonlForensicRecorder(join(directory, "events.jsonl"), { maxEvents: 2 });
		await recorder.record({ kind: "one" });
		await recorder.record({ kind: "two" });
		await recorder.record({ kind: "three" });
		expect((await recorder.read()).map((event) => event.seq)).toEqual([2, 3]);
	});
});

describe("JsonlForensicRecorder", () => {
	test("recovers sequence and redaction state after restart", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-diagnostics-"));
		const path = join(directory, "nested", "events.jsonl");
		const first = new JsonlForensicRecorder(path, { maxEvents: 3 });
		await first.record({ kind: "boot", payload: { token: "secret" } });
		await first.record({ kind: "accepted" });

		const reopened = new JsonlForensicRecorder(path, { maxEvents: 3 });
		const event = await reopened.record({ kind: "terminal" });
		expect(event.seq).toBe(3);
		expect((await reopened.read()).map((item) => item.kind)).toEqual(["boot", "accepted", "terminal"]);
		expect((await reopened.read())[0]?.payload).toEqual({ token: "[REDACTED]" });
	});

	test("bounds the retained JSONL window while preserving monotonic sequence", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-diagnostics-bounded-"));
		const recorder = new JsonlForensicRecorder(join(directory, "events.jsonl"), { maxEvents: 2 });
		await recorder.record({ kind: "one" });
		await recorder.record({ kind: "two" });
		await recorder.record({ kind: "three" });
		expect((await recorder.read()).map((event) => event.seq)).toEqual([2, 3]);
	});
});

describe("JsonlForensicRecorder", () => {
	test("recovers sequence and redaction state after restart", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-diagnostics-"));
		const path = join(directory, "nested", "events.jsonl");
		const first = new JsonlForensicRecorder(path, { maxEvents: 3 });
		await first.record({ kind: "boot", payload: { token: "secret" } });
		await first.record({ kind: "accepted" });

		const reopened = new JsonlForensicRecorder(path, { maxEvents: 3 });
		const event = await reopened.record({ kind: "terminal" });
		expect(event.seq).toBe(3);
		expect((await reopened.read()).map((item) => item.kind)).toEqual(["boot", "accepted", "terminal"]);
		expect((await reopened.read())[0]?.payload).toEqual({ token: "[REDACTED]" });
	});

	test("bounds the retained JSONL window while preserving monotonic sequence", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-diagnostics-bounded-"));
		const recorder = new JsonlForensicRecorder(join(directory, "events.jsonl"), { maxEvents: 2 });
		await recorder.record({ kind: "one" });
		await recorder.record({ kind: "two" });
		await recorder.record({ kind: "three" });
		expect((await recorder.read()).map((event) => event.seq)).toEqual([2, 3]);
	});
});

describe("JsonlForensicRecorder", () => {
	test("recovers sequence and redaction state after restart", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-diagnostics-"));
		const path = join(directory, "nested", "events.jsonl");
		const first = new JsonlForensicRecorder(path, { maxEvents: 3 });
		await first.record({ kind: "boot", payload: { token: "secret" } });
		await first.record({ kind: "accepted" });

		const reopened = new JsonlForensicRecorder(path, { maxEvents: 3 });
		const event = await reopened.record({ kind: "terminal" });
		expect(event.seq).toBe(3);
		expect((await reopened.read()).map((item) => item.kind)).toEqual(["boot", "accepted", "terminal"]);
		expect((await reopened.read())[0]?.payload).toEqual({ token: "[REDACTED]" });
	});

	test("bounds the retained JSONL window while preserving monotonic sequence", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-diagnostics-bounded-"));
		const recorder = new JsonlForensicRecorder(join(directory, "events.jsonl"), { maxEvents: 2 });
		await recorder.record({ kind: "one" });
		await recorder.record({ kind: "two" });
		await recorder.record({ kind: "three" });
		expect((await recorder.read()).map((event) => event.seq)).toEqual([2, 3]);
	});
});

describe("JsonlForensicRecorder", () => {
	test("recovers sequence and redaction state after restart", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-diagnostics-"));
		const path = join(directory, "nested", "events.jsonl");
		const first = new JsonlForensicRecorder(path, { maxEvents: 3 });
		await first.record({ kind: "boot", payload: { token: "secret" } });
		await first.record({ kind: "accepted" });

		const reopened = new JsonlForensicRecorder(path, { maxEvents: 3 });
		const event = await reopened.record({ kind: "terminal" });
		expect(event.seq).toBe(3);
		expect((await reopened.read()).map((item) => item.kind)).toEqual(["boot", "accepted", "terminal"]);
		expect((await reopened.read())[0]?.payload).toEqual({ token: "[REDACTED]" });
	});

	test("bounds the retained JSONL window while preserving monotonic sequence", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-diagnostics-bounded-"));
		const recorder = new JsonlForensicRecorder(join(directory, "events.jsonl"), { maxEvents: 2 });
		await recorder.record({ kind: "one" });
		await recorder.record({ kind: "two" });
		await recorder.record({ kind: "three" });
		expect((await recorder.read()).map((event) => event.seq)).toEqual([2, 3]);
	});
});

describe("JsonlForensicRecorder", () => {
	test("recovers sequence and redaction state after restart", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-diagnostics-"));
		const path = join(directory, "nested", "events.jsonl");
		const first = new JsonlForensicRecorder(path, { maxEvents: 3 });
		await first.record({ kind: "boot", payload: { token: "secret" } });
		await first.record({ kind: "accepted" });

		const reopened = new JsonlForensicRecorder(path, { maxEvents: 3 });
		const event = await reopened.record({ kind: "terminal" });
		expect(event.seq).toBe(3);
		expect((await reopened.read()).map((item) => item.kind)).toEqual(["boot", "accepted", "terminal"]);
		expect((await reopened.read())[0]?.payload).toEqual({ token: "[REDACTED]" });
	});

	test("bounds the retained JSONL window while preserving monotonic sequence", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-diagnostics-bounded-"));
		const recorder = new JsonlForensicRecorder(join(directory, "events.jsonl"), { maxEvents: 2 });
		await recorder.record({ kind: "one" });
		await recorder.record({ kind: "two" });
		await recorder.record({ kind: "three" });
		expect((await recorder.read()).map((event) => event.seq)).toEqual([2, 3]);
	});
});

describe("JsonlForensicRecorder", () => {
	test("recovers sequence and redaction state after restart", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-diagnostics-"));
		const path = join(directory, "nested", "events.jsonl");
		const first = new JsonlForensicRecorder(path, { maxEvents: 3 });
		await first.record({ kind: "boot", payload: { token: "secret" } });
		await first.record({ kind: "accepted" });

		const reopened = new JsonlForensicRecorder(path, { maxEvents: 3 });
		const event = await reopened.record({ kind: "terminal" });
		expect(event.seq).toBe(3);
		expect((await reopened.read()).map((item) => item.kind)).toEqual(["boot", "accepted", "terminal"]);
		expect((await reopened.read())[0]?.payload).toEqual({ token: "[REDACTED]" });
	});

	test("bounds the retained JSONL window while preserving monotonic sequence", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-diagnostics-bounded-"));
		const recorder = new JsonlForensicRecorder(join(directory, "events.jsonl"), { maxEvents: 2 });
		await recorder.record({ kind: "one" });
		await recorder.record({ kind: "two" });
		await recorder.record({ kind: "three" });
		expect((await recorder.read()).map((event) => event.seq)).toEqual([2, 3]);
	});
});

describe("JsonlForensicRecorder", () => {
	test("recovers sequence and redaction state after restart", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-diagnostics-"));
		const path = join(directory, "nested", "events.jsonl");
		const first = new JsonlForensicRecorder(path, { maxEvents: 3 });
		await first.record({ kind: "boot", payload: { token: "secret" } });
		await first.record({ kind: "accepted" });

		const reopened = new JsonlForensicRecorder(path, { maxEvents: 3 });
		const event = await reopened.record({ kind: "terminal" });
		expect(event.seq).toBe(3);
		expect((await reopened.read()).map((item) => item.kind)).toEqual(["boot", "accepted", "terminal"]);
		expect((await reopened.read())[0]?.payload).toEqual({ token: "[REDACTED]" });
	});

	test("bounds the retained JSONL window while preserving monotonic sequence", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-diagnostics-bounded-"));
		const recorder = new JsonlForensicRecorder(join(directory, "events.jsonl"), { maxEvents: 2 });
		await recorder.record({ kind: "one" });
		await recorder.record({ kind: "two" });
		await recorder.record({ kind: "three" });
		expect((await recorder.read()).map((event) => event.seq)).toEqual([2, 3]);
	});
});

describe("JsonlForensicRecorder", () => {
	test("recovers sequence and redaction state after restart", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-diagnostics-"));
		const path = join(directory, "nested", "events.jsonl");
		const first = new JsonlForensicRecorder(path, { maxEvents: 3 });
		await first.record({ kind: "boot", payload: { token: "secret" } });
		await first.record({ kind: "accepted" });

		const reopened = new JsonlForensicRecorder(path, { maxEvents: 3 });
		const event = await reopened.record({ kind: "terminal" });
		expect(event.seq).toBe(3);
		expect((await reopened.read()).map((item) => item.kind)).toEqual(["boot", "accepted", "terminal"]);
		expect((await reopened.read())[0]?.payload).toEqual({ token: "[REDACTED]" });
	});

	test("bounds the retained JSONL window while preserving monotonic sequence", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-diagnostics-bounded-"));
		const recorder = new JsonlForensicRecorder(join(directory, "events.jsonl"), { maxEvents: 2 });
		await recorder.record({ kind: "one" });
		await recorder.record({ kind: "two" });
		await recorder.record({ kind: "three" });
		expect((await recorder.read()).map((event) => event.seq)).toEqual([2, 3]);
	});
});

describe("JsonlForensicRecorder", () => {
	test("recovers sequence and redaction state after restart", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-diagnostics-"));
		const path = join(directory, "nested", "events.jsonl");
		const first = new JsonlForensicRecorder(path, { maxEvents: 3 });
		await first.record({ kind: "boot", payload: { token: "secret" } });
		await first.record({ kind: "accepted" });

		const reopened = new JsonlForensicRecorder(path, { maxEvents: 3 });
		const event = await reopened.record({ kind: "terminal" });
		expect(event.seq).toBe(3);
		expect((await reopened.read()).map((item) => item.kind)).toEqual(["boot", "accepted", "terminal"]);
		expect((await reopened.read())[0]?.payload).toEqual({ token: "[REDACTED]" });
	});

	test("bounds the retained JSONL window while preserving monotonic sequence", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-diagnostics-bounded-"));
		const recorder = new JsonlForensicRecorder(join(directory, "events.jsonl"), { maxEvents: 2 });
		await recorder.record({ kind: "one" });
		await recorder.record({ kind: "two" });
		await recorder.record({ kind: "three" });
		expect((await recorder.read()).map((event) => event.seq)).toEqual([2, 3]);
	});
});

describe("JsonlForensicRecorder", () => {
	test("recovers sequence and redaction state after restart", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-diagnostics-"));
		const path = join(directory, "nested", "events.jsonl");
		const first = new JsonlForensicRecorder(path, { maxEvents: 3 });
		await first.record({ kind: "boot", payload: { token: "secret" } });
		await first.record({ kind: "accepted" });

		const reopened = new JsonlForensicRecorder(path, { maxEvents: 3 });
		const event = await reopened.record({ kind: "terminal" });
		expect(event.seq).toBe(3);
		expect((await reopened.read()).map((item) => item.kind)).toEqual(["boot", "accepted", "terminal"]);
		expect((await reopened.read())[0]?.payload).toEqual({ token: "[REDACTED]" });
	});

	test("bounds the retained JSONL window while preserving monotonic sequence", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-diagnostics-bounded-"));
		const recorder = new JsonlForensicRecorder(join(directory, "events.jsonl"), { maxEvents: 2 });
		await recorder.record({ kind: "one" });
		await recorder.record({ kind: "two" });
		await recorder.record({ kind: "three" });
		expect((await recorder.read()).map((event) => event.seq)).toEqual([2, 3]);
	});
});

describe("JsonlForensicRecorder", () => {
	test("recovers sequence and redaction state after restart", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-diagnostics-"));
		const path = join(directory, "nested", "events.jsonl");
		const first = new JsonlForensicRecorder(path, { maxEvents: 3 });
		await first.record({ kind: "boot", payload: { token: "secret" } });
		await first.record({ kind: "accepted" });

		const reopened = new JsonlForensicRecorder(path, { maxEvents: 3 });
		const event = await reopened.record({ kind: "terminal" });
		expect(event.seq).toBe(3);
		expect((await reopened.read()).map((item) => item.kind)).toEqual(["boot", "accepted", "terminal"]);
		expect((await reopened.read())[0]?.payload).toEqual({ token: "[REDACTED]" });
	});

	test("bounds the retained JSONL window while preserving monotonic sequence", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-diagnostics-bounded-"));
		const recorder = new JsonlForensicRecorder(join(directory, "events.jsonl"), { maxEvents: 2 });
		await recorder.record({ kind: "one" });
		await recorder.record({ kind: "two" });
		await recorder.record({ kind: "three" });
		expect((await recorder.read()).map((event) => event.seq)).toEqual([2, 3]);
	});
});

describe("JsonlForensicRecorder", () => {
	test("recovers sequence and redaction state after restart", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-diagnostics-"));
		const path = join(directory, "nested", "events.jsonl");
		const first = new JsonlForensicRecorder(path, { maxEvents: 3 });
		await first.record({ kind: "boot", payload: { token: "secret" } });
		await first.record({ kind: "accepted" });

		const reopened = new JsonlForensicRecorder(path, { maxEvents: 3 });
		const event = await reopened.record({ kind: "terminal" });
		expect(event.seq).toBe(3);
		expect((await reopened.read()).map((item) => item.kind)).toEqual(["boot", "accepted", "terminal"]);
		expect((await reopened.read())[0]?.payload).toEqual({ token: "[REDACTED]" });
	});

	test("bounds the retained JSONL window while preserving monotonic sequence", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-diagnostics-bounded-"));
		const recorder = new JsonlForensicRecorder(join(directory, "events.jsonl"), { maxEvents: 2 });
		await recorder.record({ kind: "one" });
		await recorder.record({ kind: "two" });
		await recorder.record({ kind: "three" });
		expect((await recorder.read()).map((event) => event.seq)).toEqual([2, 3]);
	});
});

describe("JsonlForensicRecorder", () => {
	test("recovers sequence and redaction state after restart", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-diagnostics-"));
		const path = join(directory, "nested", "events.jsonl");
		const first = new JsonlForensicRecorder(path, { maxEvents: 3 });
		await first.record({ kind: "boot", payload: { token: "secret" } });
		await first.record({ kind: "accepted" });

		const reopened = new JsonlForensicRecorder(path, { maxEvents: 3 });
		const event = await reopened.record({ kind: "terminal" });
		expect(event.seq).toBe(3);
		expect((await reopened.read()).map((item) => item.kind)).toEqual(["boot", "accepted", "terminal"]);
		expect((await reopened.read())[0]?.payload).toEqual({ token: "[REDACTED]" });
	});

	test("bounds the retained JSONL window while preserving monotonic sequence", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-diagnostics-bounded-"));
		const recorder = new JsonlForensicRecorder(join(directory, "events.jsonl"), { maxEvents: 2 });
		await recorder.record({ kind: "one" });
		await recorder.record({ kind: "two" });
		await recorder.record({ kind: "three" });
		expect((await recorder.read()).map((event) => event.seq)).toEqual([2, 3]);
	});
});

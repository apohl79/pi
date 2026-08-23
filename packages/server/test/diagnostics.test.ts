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

	test("redacts normalized credential keys and credential-shaped strings", async () => {
		const recorder = new InMemoryForensicRecorder();
		const event = await recorder.record({
			kind: "credential-shape",
			payload: {
				API_KEY: "secret-value",
				nested: { access_token: "another-secret" },
				message: "Authorization: Bearer abcdefghijklmnop",
				providerKey: "sk-example_12345678",
				safe: "ordinary diagnostic text",
			},
		});
		expect(event.payload).toEqual({
			API_KEY: "[REDACTED]",
			nested: { access_token: "[REDACTED]" },
			message: "[REDACTED]",
			providerKey: "[REDACTED]",
			safe: "ordinary diagnostic text",
		});
	});
});

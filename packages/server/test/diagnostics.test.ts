import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
	InMemoryForensicRecorder,
	JsonlForensicRecorder,
	LocalDiagnosticCapsuleStore,
	TeeForensicRecorder,
	verifyDiagnosticBundle,
} from "../src/diagnostics.ts";

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
		expect(events[0]).toMatchObject({
			schemaVersion: 1,
			eventId: expect.any(String),
			severity: "info",
			traceId: expect.any(String),
			spanId: expect.any(String),
			processInstanceId: expect.any(String),
		});
		expect(events[0]?.traceId).not.toBe(events[1]?.traceId);
		expect(events[0]?.processInstanceId).toBe(events[1]?.processInstanceId);
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

describe("JsonlForensicRecorder", () => {
	test("rotates bounded operational logs and replays retained files", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-diagnostics-rotating-"));
		const path = join(directory, "operational.jsonl");
		const recorder = new JsonlForensicRecorder(path, { maxBytes: 180, maxFiles: 3 });
		await recorder.record({ kind: "one", payload: { value: "first" } });
		await recorder.record({ kind: "two", payload: { value: "second" } });
		await recorder.record({ kind: "three", payload: { value: "third" } });
		expect(await recorder.read()).toHaveLength(3);
		expect(await recorder.read()).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "three" })]));
		const reopened = new JsonlForensicRecorder(path, { maxBytes: 180, maxFiles: 3 });
		expect((await reopened.read()).map((event) => event.kind)).toEqual(["one", "two", "three"]);
	});

	test("does not make canonical recording depend on an operational log failure", async () => {
		const primary = new InMemoryForensicRecorder();
		const secondary = {
			record: async () => {
				throw new Error("disk full");
			},
			read: async () => [],
		};
		const recorder = new TeeForensicRecorder(primary, secondary);
		await expect(recorder.record({ kind: "accepted" })).resolves.toMatchObject({ kind: "accepted", seq: 1 });
		expect(recorder.getOperationalLogFailureCount()).toBe(1);
		expect(recorder.isDegraded()).toBe(true);
		expect(await recorder.read()).toMatchObject([
			{ kind: "accepted" },
			{ kind: "diagnostics_degraded", severity: "error", payload: { sink: "operational-log" } },
		]);
	});

	test("recovers sequence and redaction state after restart", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-diagnostics-"));
		const path = join(directory, "nested", "events.jsonl");
		const first = new JsonlForensicRecorder(path, { maxEvents: 3 });
		await first.record({ kind: "boot", payload: { token: "secret" } });
		await first.record({ kind: "accepted" });

		const reopened = new JsonlForensicRecorder(path, { maxEvents: 3 });
		const persisted = await reopened.read();
		expect(persisted[0]).toMatchObject({
			schemaVersion: 1,
			eventId: expect.any(String),
			processInstanceId: expect.any(String),
		});
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

	test("rejects malformed persisted event records", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-diagnostics-invalid-"));
		const path = join(directory, "events.jsonl");
		await writeFile(path, `${JSON.stringify({ schemaVersion: 1, seq: 1, kind: "boot" })}\n`);
		await expect(new JsonlForensicRecorder(path).read()).rejects.toThrow("Invalid forensic event");
	});
});

describe("LocalDiagnosticCapsuleStore", () => {
	test("encrypts bounded content and decrypts after key rotation", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-diagnostic-capsules-"));
		const store = new LocalDiagnosticCapsuleStore(join(directory, "keys.json"), { maxBytes: 5 });
		const first = await store.encrypt({ eventId: "event-1", kind: "prompt", content: "secret-content" });
		expect(first).toMatchObject({ byteLength: 5, originalByteLength: 14, truncated: true });
		expect(Buffer.from(await store.decrypt(first)).toString()).toBe("secre");
		const oldKey = first.keyId;
		const newKey = await store.rotateKey();
		expect(newKey).not.toBe(oldKey);
		const second = await store.encrypt({ eventId: "event-2", kind: "tool", content: "result" });
		expect(second.keyId).toBe(newKey);
		expect(Buffer.from(await store.decrypt(first)).toString()).toBe("secre");
	});

	test("rejects authenticated ciphertext tampering", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-diagnostic-capsules-tamper-"));
		const store = new LocalDiagnosticCapsuleStore(join(directory, "keys.json"));
		const capsule = await store.encrypt({ eventId: "event-1", kind: "prompt", content: "secret" });
		const tampered = {
			...capsule,
			ciphertext: `${capsule.ciphertext.slice(0, -1)}${capsule.ciphertext.endsWith("A") ? "B" : "A"}`,
		};
		await expect(store.decrypt(tampered)).rejects.toThrow();
	});

	test("persists bounded capsules separately from the key file", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-diagnostic-capsules-persist-"));
		const keyPath = join(directory, "keys.json");
		const firstStore = new LocalDiagnosticCapsuleStore(keyPath, { maxCapsules: 1 });
		const first = await firstStore.encrypt({ eventId: "event-1", kind: "prompt", content: "one" });
		const second = await firstStore.encrypt({ eventId: "event-2", kind: "prompt", content: "two" });
		await firstStore.save(first);
		await firstStore.save(second);
		const reopened = new LocalDiagnosticCapsuleStore(keyPath, { maxCapsules: 1 });
		expect(await reopened.list()).toEqual([second]);
		expect(await reopened.decrypt(second)).toEqual(new Uint8Array(Buffer.from("two")));
	});
});

describe("verifyDiagnosticBundle", () => {
	test("verifies an exported event bundle offline", () => {
		const events = [
			{ seq: 1, kind: "boot" },
			{ seq: 2, kind: "ready" },
		];
		const serialized = JSON.stringify(events);
		const manifest = {
			schemaVersion: 1,
			eventCount: 2,
			firstSeq: 1,
			lastSeq: 2,
			eventsSha256: createHash("sha256").update(serialized).digest("hex"),
		};
		expect(verifyDiagnosticBundle({ manifest, events })).toEqual({ valid: true });
		expect(verifyDiagnosticBundle({ manifest, events, integrity: [{ name: "sessions", ok: true }] })).toEqual({
			valid: true,
		});
		expect(verifyDiagnosticBundle({ manifest, events, integrity: [{ name: "sessions", ok: "yes" }] })).toMatchObject({
			valid: false,
		});
		const capsules = [
			{
				schemaVersion: 1,
				eventId: "event-1",
				kind: "prompt",
				keyId: "key-1",
				nonce: "nonce",
				ciphertext: "ciphertext",
				authTag: "tag",
				plaintextSha256: "a".repeat(64),
				byteLength: 1,
				originalByteLength: 1,
				truncated: false,
			},
		];
		const capsulesSha256 = createHash("sha256").update(JSON.stringify(capsules)).digest("hex");
		expect(verifyDiagnosticBundle({ manifest: { ...manifest, capsulesSha256 }, events, capsules })).toEqual({
			valid: true,
		});
		expect(
			verifyDiagnosticBundle({
				manifest: { ...manifest, capsulesSha256 },
				events,
				capsules: [{ ...capsules[0], ciphertext: "changed" }],
			}),
		).toMatchObject({ valid: false });
		const projections = {
			sessions: [{ id: "session-1" }],
			operations: [{ operationId: "operation-1", state: "complete" }],
			operationEvents: [{ event: "operation_accepted", operationId: "operation-1", seq: 2 }],
			usage: { aggregate: { responses: 1 }, entries: [] },
			plugins: { marketplaces: [], plugins: [] },
			blobs: [{ digest: "a".repeat(64), mimeType: "text/plain", size: 1 }],
		};
		const projectionsSha256 = createHash("sha256").update(JSON.stringify(projections)).digest("hex");
		expect(verifyDiagnosticBundle({ manifest: { ...manifest, projectionsSha256 }, events, projections })).toEqual({
			valid: true,
		});
		expect(
			verifyDiagnosticBundle({
				manifest: { ...manifest, projectionsSha256 },
				events,
				projections: { ...projections, sessions: [{ id: "tampered" }] },
			}),
		).toMatchObject({ valid: false });
		expect(verifyDiagnosticBundle({ manifest, events, projections: { sessions: [] } })).toMatchObject({
			valid: false,
		});
		expect(
			verifyDiagnosticBundle({
				manifest,
				events,
				projections: { ...projections, operationEvents: "invalid" },
			}),
		).toMatchObject({ valid: false });
		const scopedEvents = [{ seq: 1, sessionId: "session-1", operationId: "operation-1" }];
		const scopedManifest = {
			...manifest,
			eventCount: 1,
			firstSeq: 1,
			lastSeq: 1,
			eventsSha256: createHash("sha256").update(JSON.stringify(scopedEvents)).digest("hex"),
			scope: { sessionId: "session-1", operationId: "operation-1" },
		};
		const scopedProjections = {
			...projections,
			operations: [{ operationId: "operation-1", sessionId: "session-1", state: "complete" }],
			operationEvents: [{ event: "operation_accepted", operationId: "operation-1", sessionId: "session-1", seq: 2 }],
		};
		expect(
			verifyDiagnosticBundle({ manifest: scopedManifest, events: scopedEvents, projections: scopedProjections }),
		).toEqual({
			valid: true,
		});
		expect(
			verifyDiagnosticBundle({
				manifest: scopedManifest,
				events: scopedEvents,
				projections: {
					...projections,
					operations: [{ operationId: "other-operation", sessionId: "session-1" }],
				},
			}),
		).toMatchObject({ valid: false });
		expect(
			verifyDiagnosticBundle({
				manifest,
				events,
				runtimeManifest: { schemaVersion: 1, runtime: "node v22", platform: "linux", arch: "x64" },
			}),
		).toEqual({ valid: true });
		expect(
			verifyDiagnosticBundle({ manifest: { ...manifest, unavailable: ["client-diagnostic-spool"] }, events }),
		).toEqual({ valid: true });
		expect(verifyDiagnosticBundle({ manifest, events, runtimeManifest: { schemaVersion: 1 } })).toMatchObject({
			valid: false,
			reason: "Diagnostic bundle contains an invalid runtime manifest",
		});
		expect(verifyDiagnosticBundle({ manifest: { ...manifest, lastSeq: 3 }, events })).toMatchObject({ valid: false });
		expect(verifyDiagnosticBundle({ events })).toMatchObject({ valid: false });
		expect(verifyDiagnosticBundle({ manifest: { ...manifest, unavailable: [""] }, events })).toEqual({
			valid: false,
			reason: "Diagnostic bundle manifest contains invalid unavailable entries",
		});
		expect(
			verifyDiagnosticBundle({
				manifest,
				events,
				clientDiagnostics: {
					afterSeq: 2,
					records: [
						{
							schemaVersion: 1,
							seq: 2,
							clientInstanceId: "client-1",
							event: "client.connected",
							severity: "info",
							timestamp: 1,
						},
					],
				},
			}),
		).toEqual({ valid: true });
		expect(verifyDiagnosticBundle({ manifest, events, clientDiagnostics: { afterSeq: -1, records: [] } })).toEqual({
			valid: false,
			reason: "Diagnostic bundle contains invalid client diagnostics",
		});
	});

	test("rejects malformed encrypted capsule records during offline verification", () => {
		const events = [{ seq: 1, kind: "boot" }];
		const manifest = {
			schemaVersion: 1,
			eventCount: 1,
			firstSeq: 1,
			lastSeq: 1,
			eventsSha256: createHash("sha256").update(JSON.stringify(events)).digest("hex"),
		};
		expect(
			verifyDiagnosticBundle({ manifest, events, capsules: [{ schemaVersion: 1, eventId: "event-1" }] }),
		).toEqual({ valid: false, reason: "Diagnostic bundle contains an invalid capsule" });
	});
});

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	AgentSummary,
	CommandV2,
	JsonValue,
	ModelMetadata,
	OperationAccepted,
	SessionMetadataV2,
	SessionSnapshotV2,
	UsageAggregate,
} from "@earendil-works/pi-protocol";
import { afterEach, describe, expect, test } from "vitest";
import { InMemoryV2AgentRegistry } from "../src/agents.ts";
import { InMemoryV2AppRegistry } from "../src/apps.ts";
import { FileV2BlobStore, InMemoryV2BlobStore } from "../src/blobs.ts";
import {
	type DiagnosticIntegrityCheck,
	InMemoryForensicRecorder,
	LocalDiagnosticCapsuleStore,
	TeeForensicRecorder,
} from "../src/diagnostics.ts";
import { LocalV2FileReferenceService } from "../src/files.ts";
import { BlobV2ImageService } from "../src/images.ts";
import { InMemoryV2InputRegistry } from "../src/inputs.ts";
import { InMemoryV2OperationStore, JsonlV2OperationStore } from "../src/operation-store.ts";
import { InMemoryV2ProcessRegistry, NodeV2ProcessRegistry } from "../src/processes.ts";
import { connectInMemoryTestClientV2, connectUnixTestClientV2, Deferred } from "../src/testing/index.ts";
import { createUnixServerV2 } from "../src/transports/unix/preset.ts";
import { InMemoryV2UsageLedger } from "../src/usage-ledger.ts";
import { type PiServerServiceV2, PiServerV2, type PiSessionRuntimeV2 } from "../src/v2.ts";
import { AdapterV2WebService } from "../src/web.ts";

const runtimes: TestRuntime[] = [];
const servers: Array<Awaited<ReturnType<typeof createUnixServerV2>>> = [];
const directories: string[] = [];

const model: ModelMetadata = {
	provider: "test",
	id: "small",
	name: "Test Small",
	api: "test-api",
	reasoning: true,
	input: ["text"],
	contextWindow: 16_000,
	maxTokens: 2_000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	supportedThinkingLevels: ["off"],
	authenticated: true,
};

function sessionSnapshot(id: string): SessionSnapshotV2 {
	return {
		id,
		name: "Contract session",
		nameSource: "explicit",
		nameRevision: 1,
		revision: 1,
		eventSeq: 1,
		phase: "idle",
		model: { provider: model.provider, id: model.id },
		thinkingLevel: "off",
		transcript: [],
		queues: { steer: [], followUp: [] },
		agents: [] satisfies AgentSummary[],
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			costUsd: 0,
			pricingState: "known",
		} satisfies UsageAggregate,
		context: { inputTokens: 0, contextWindow: 16_000, usedPercentage: 0 },
		compactionPolicy: {
			enabled: true,
			contextWindow: 16_000,
			reserveTokens: 1_000,
			keepRecentTokens: 2_000,
			triggerTokens: 15_000,
			source: "global",
		},
		pluginSetHash: "plugins-empty",
		diagnostics: { capture: "metadata", degraded: false, lastCriticalEventSeq: 1 },
		persistence: { schemaVersion: 1, recoveryState: "clean" },
		createdAt: 1,
		updatedAt: 1,
	};
}

class TestRuntime implements PiSessionRuntimeV2 {
	readonly accepted: OperationAccepted[] = [];
	readonly commands: CommandV2[] = [];
	readonly started = new Deferred<void>();
	readonly release = new Deferred<void>();
	disposeCount = 0;
	fail = false;
	private current: SessionSnapshotV2;

	constructor(id: string) {
		this.current = sessionSnapshot(id);
	}

	snapshot(): SessionSnapshotV2 {
		return structuredClone(this.current);
	}

	async accept(operationId: string): Promise<OperationAccepted> {
		const accepted = { operationId, sessionRevision: 2, eventSeq: 2 };
		this.accepted.push(accepted);
		return accepted;
	}

	async run(operationId: string, _command: CommandV2): Promise<void> {
		this.commands.push(structuredClone(_command));
		if (this.fail) throw new Error("runtime failed");
		await this.release.promise;
		this.started.resolve(undefined);
		this.current = {
			...this.current,
			revision: 3,
			eventSeq: 3,
		};
		void operationId;
	}

	dispose(): Promise<void> {
		this.disposeCount += 1;
		return Promise.resolve();
	}
}

class TestService implements PiServerServiceV2 {
	readonly sessionMetadata: SessionMetadataV2[] = [];
	readonly sessions = new Map<string, TestRuntime>();

	constructor() {
		this.sessions.set("session-1", new TestRuntime("session-1"));
	}

	listSessions(): Promise<SessionMetadataV2[]> {
		return Promise.resolve(this.sessionMetadata);
	}

	listModels(): Promise<ModelMetadata[]> {
		return Promise.resolve([model]);
	}

	openSession(sessionId: string): Promise<PiSessionRuntimeV2> {
		const runtime = this.sessions.get(sessionId);
		if (!runtime) return Promise.reject(new Error(`Unknown session ${sessionId}`));
		runtimes.push(runtime);
		return Promise.resolve(runtime);
	}

	async createSession(options: Record<string, unknown>): Promise<{ sessionId: string; runtime: PiSessionRuntimeV2 }> {
		const sessionId = typeof options.id === "string" ? options.id : "created-session";
		if (this.sessions.has(sessionId)) throw new Error(`Session ${sessionId} already exists`);
		const runtime = new TestRuntime(sessionId);
		this.sessions.set(sessionId, runtime);
		return { sessionId, runtime };
	}

	async forkSession(
		sourceSessionId: string,
		options: Record<string, unknown>,
	): Promise<{ sessionId: string; runtime: PiSessionRuntimeV2 }> {
		if (!this.sessions.has(sourceSessionId)) throw new Error(`Unknown session ${sourceSessionId}`);
		const sessionId = typeof options.id === "string" ? options.id : `${sourceSessionId}-fork`;
		const runtime = new TestRuntime(sessionId);
		this.sessions.set(sessionId, runtime);
		return { sessionId, runtime };
	}

	async deleteSession(sessionId: string): Promise<void> {
		if (!this.sessions.delete(sessionId)) throw new Error(`Unknown session ${sessionId}`);
	}
}

afterEach(async () => {
	await Promise.all(servers.map((server) => server.close()));
	servers.length = 0;
	await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
	directories.length = 0;
	runtimes.length = 0;
});

describe("PiServer v2 operation acceptance", () => {
	test("accepts deterministic in-memory v2 handshakes and fragmented requests", async () => {
		const service = new TestService();
		const server = new PiServerV2(service, { listeners: [], serverId: "memory-server" });
		await server.start();
		const client = connectInMemoryTestClientV2(server.accept.bind(server));
		try {
			expect(await client.hello()).toMatchObject({
				type: "hello",
				version: 2,
				snapshot: { serverId: "memory-server" },
			});
			await client.sendFragmentedMessage(
				{
					type: "request",
					id: "memory-model-list",
					request: { command: "model/list" },
				},
				3,
			);
			expect(
				await client.next((message) => message.type === "response" && message.id === "memory-model-list"),
			).toMatchObject({
				type: "response",
				id: "memory-model-list",
				ok: true,
			});
		} finally {
			await client.close();
			await server.close();
		}
	});

	test("routes host-scoped filesystem completion, resolution, and reads", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pis-files-"));
		directories.push(directory);
		await writeFile(join(directory, "notes.ts"), "export const answer = 42;");
		const service = new TestService();
		const server = createUnixServerV2(service, {
			path: join(directory, "server.sock"),
			files: new LocalV2FileReferenceService({ projectRoot: directory, homeDirectory: directory }),
		});
		servers.push(server);
		await server.start();
		const client = await connectUnixTestClientV2(server.addresses[0]!);
		await client.hello();
		await client.request({ command: "session/attach", sessionId: "session-1" });

		const complete = await client.request({
			command: "filesystem/complete",
			sessionId: "session-1",
			payload: { prefix: "@project:n" },
		});
		expect(complete).toMatchObject({
			ok: true,
			result: { items: [{ reference: "project:notes.ts", kind: "file" }] },
		});
		const read = await client.request({
			command: "filesystem/reference/read",
			sessionId: "session-1",
			payload: { reference: "notes.ts" },
		});
		expect(read).toMatchObject({ ok: true, result: { encoding: "base64", file: { kind: "file" } } });
		if (
			!read.ok ||
			!("result" in read) ||
			typeof read.result !== "object" ||
			read.result === null ||
			Array.isArray(read.result)
		)
			throw new Error("Expected a filesystem read result");
		if (typeof read.result.data !== "string") throw new Error("Expected base64 filesystem data");
		expect(Buffer.from(read.result.data, "base64").toString("utf8")).toBe("export const answer = 42;");
	});

	test("routes a bounded adapter-backed web request", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pis-web-"));
		directories.push(directory);
		const service = new TestService();
		const server = createUnixServerV2(service, {
			path: join(directory, "server.sock"),
			web: new AdapterV2WebService({
				execute: async () => [
					{
						id: "result-1",
						title: "Example",
						source: "fake",
						retrievedAt: 1,
						url: "https://example.test",
						extract: "ok",
					},
				],
			}),
		});
		servers.push(server);
		await server.start();
		const client = await connectUnixTestClientV2(server.addresses[0]!);
		await client.hello();
		await client.request({ command: "session/attach", sessionId: "session-1" });
		const response = await client.request({
			command: "web",
			sessionId: "session-1",
			payload: { operation: "search_query", query: "example" },
		});
		expect(response).toMatchObject({ ok: true, result: { results: [{ id: "result-1", source: "fake" }] } });
	});

	test("serves diagnostic status, timeline, export, verify, and doctor", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pis-diagnostics-"));
		directories.push(directory);
		const diagnostics = new InMemoryForensicRecorder();
		const operationStore = new InMemoryV2OperationStore();
		await operationStore.putOperation({
			operationId: "operation-1",
			sessionId: "session-1",
			state: "complete",
			accepted: { operationId: "operation-1", sessionRevision: 2, eventSeq: 2 },
		});
		await operationStore.appendEvent({
			type: "event",
			sessionId: "session-1",
			seq: 2,
			revision: 2,
			operationId: "operation-1",
			event: "operation_accepted",
			payload: { command: "turn/start" },
		});
		const usage = new InMemoryV2UsageLedger();
		await usage.record({
			responseId: "response-1",
			sessionId: "session-1",
			agentId: "agent-1",
			operationId: "operation-1",
			purpose: "agent",
			provider: "test",
			model: "small",
			input: 3,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
			pricing: "providerReported",
			costUsd: 0.01,
			createdAt: 1,
		});
		await diagnostics.record({
			kind: "boot",
			severity: "error",
			sessionId: "session-1",
			payload: { token: "secret" },
		});
		await diagnostics.record({
			kind: "other-session",
			severity: "info",
			sessionId: "session-2",
			operationId: "operation-2",
		});
		await diagnostics.record({
			kind: "boot-follow-up",
			severity: "info",
			sessionId: "session-1",
		});
		const server = createUnixServerV2(new TestService(), {
			path: join(directory, "server.sock"),
			diagnostics,
			operationStore,
			usage,
			integrity: async (): Promise<readonly DiagnosticIntegrityCheck[]> => [
				{ name: "sessions", ok: true, details: { count: 1 } },
				{ name: "operations", ok: true, details: { operations: 2, events: 3 } },
				{ name: "plugins", ok: true, details: { count: 4 } },
				{ name: "blobs", ok: true, details: { metadataFiles: 5 } },
				{
					name: "usage",
					ok: true,
					details: { responses: 6, input: 7, output: 8, costUsd: 0.5, pricingState: "known" },
				},
			],
			runtimeManifest: {
				schemaVersion: 1,
				runtime: "node test",
				platform: "test",
				arch: "test",
				forkCommit: "fork-commit",
			},
		});
		servers.push(server);
		await server.start();
		const client = await connectUnixTestClientV2(server.addresses[0]!);
		await client.hello(undefined, {
			manifest: {
				clientInstanceId: "client-1",
				runtime: "node v22",
				platform: "linux",
				arch: "x64",
				forkCommit: "fork-sha",
			},
			afterSeq: 3,
		});
		const status = await client.request({ command: "diagnostics/status" });
		const timeline = await client.request({
			command: "diagnostics/timeline",
			payload: { sessionId: "session-1" },
		});
		const operationTimeline = await client.request({
			command: "diagnostics/timeline",
			payload: { sessionId: "session-1", operationId: "operation-1" },
		});
		const exported = await client.request({ command: "diagnostics/export" });
		const scopedExport = await client.request({
			command: "diagnostics/export",
			payload: { sessionId: "session-1" },
		});
		const verified = await client.request({ command: "diagnostics/verify" });
		const doctor = await client.request({ command: "diagnostics/doctor" });
		expect(status).toMatchObject({
			ok: true,
			result: { capture: "metadata", eventCount: 4, degraded: true, lastCriticalEventSeq: 1 },
		});
		const scopedStatus = await client.request({ command: "diagnostics/status", payload: { sessionId: "session-2" } });
		expect(scopedStatus).toMatchObject({
			ok: true,
			result: { capture: "metadata", eventCount: 1, degraded: false, lastCriticalEventSeq: 0 },
		});
		expect(timeline).toMatchObject({
			ok: true,
			result: {
				events: [{ kind: "boot", payload: { token: "[REDACTED]" } }, { kind: "boot-follow-up" }],
				operations: [{ operationId: "operation-1", sessionId: "session-1", state: "complete" }],
				operationEvents: [{ event: "operation_accepted", operationId: "operation-1", seq: 2 }],
				usage: {
					aggregate: { responses: 1, input: 3, output: 2, costUsd: 0.01 },
					entries: [{ responseId: "response-1", operationId: "operation-1" }],
				},
			},
		});
		expect(operationTimeline).toMatchObject({
			ok: true,
			result: {
				events: [],
				operations: [{ operationId: "operation-1" }],
				operationEvents: [{ event: "operation_accepted", operationId: "operation-1" }],
				usage: { aggregate: { responses: 1 }, entries: [{ operationId: "operation-1" }] },
			},
		});
		expect(exported).toMatchObject({
			ok: true,
			result: {
				format: "json",
				bundle: {
					manifest: { projectionsSha256: expect.any(String) },
					projections: {
						sessions: [],
						operations: [{ operationId: "operation-1", sessionId: "session-1", state: "complete" }],
						operationEvents: [{ event: "operation_accepted", operationId: "operation-1", seq: 2 }],
						usage: {
							aggregate: { responses: 1, input: 3, output: 2, costUsd: 0.01 },
							entries: [{ responseId: "response-1", operationId: "operation-1" }],
						},
						plugins: { marketplaces: [], plugins: [] },
						blobs: [],
					},
				},
			},
		});
		if (exported.ok && "result" in exported) {
			const result = exported.result as {
				events: Array<{ seq: number }>;
				bundle: { events: Array<{ seq: number }> };
			};
			expect(result.events).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ seq: 1 }),
					expect.objectContaining({ seq: 2 }),
					expect.objectContaining({ seq: 3 }),
				]),
			);
			expect(result.bundle.events).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ seq: 1 }),
					expect.objectContaining({ seq: 2 }),
					expect.objectContaining({ seq: 3 }),
				]),
			);
		}
		expect(scopedExport).toMatchObject({
			ok: true,
			result: {
				events: expect.arrayContaining([expect.objectContaining({ seq: 1 }), expect.objectContaining({ seq: 3 })]),
				bundle: {
					manifest: {
						eventCount: expect.any(Number),
						firstSeq: 1,
						lastSeq: expect.any(Number),
						scope: { sessionId: "session-1" },
					},
				},
			},
		});
		const scopedBundle = (scopedExport as unknown as { result: { bundle: JsonValue } }).result.bundle;
		expect(await client.request({ command: "diagnostics/verify", payload: { bundle: scopedBundle } })).toMatchObject({
			ok: true,
			result: { valid: true },
		});
		expect(
			(exported as unknown as { result: { integrity: Array<{ name: string; ok: boolean }> } }).result.integrity,
		).toEqual(expect.arrayContaining([expect.objectContaining({ name: "sessions", ok: true })]));
		expect(exported).toMatchObject({
			ok: true,
			result: {
				bundle: {
					runtimeManifest: { runtime: "node test", forkCommit: "fork-commit" },
					clientDiagnostics: { manifest: { clientInstanceId: "client-1", forkCommit: "fork-sha" }, afterSeq: 3 },
				},
			},
		});
		expect(verified).toMatchObject({ ok: true, result: { valid: true, gaps: [] } });
		expect(doctor).toMatchObject({ ok: true, result: { ok: true } });
		const doctorChecks = (
			doctor as unknown as { result: { checks: Array<{ name: string; details?: Record<string, JsonValue> }> } }
		).result.checks;
		expect(doctorChecks.map((check) => check.name)).toEqual([
			"recorder",
			"sequence",
			"sessions",
			"operations",
			"plugins",
			"blobs",
			"usage",
		]);
		expect(doctorChecks.find((check) => check.name === "sessions")?.details).toEqual({ count: 1 });
		expect(doctorChecks.find((check) => check.name === "usage")?.details).toMatchObject({
			responses: 6,
			pricingState: "known",
		});
		const bundle = (exported as unknown as { result: { bundle: JsonValue } }).result.bundle;
		const bundleVerified = await client.request({ command: "diagnostics/verify", payload: { bundle } });
		expect(bundleVerified).toMatchObject({ ok: true, result: { valid: true } });
		const tampered = structuredClone(bundle) as {
			events: Array<{ [key: string]: JsonValue }>;
			manifest: { [key: string]: JsonValue };
		};
		tampered.events[0]!.payload = { token: "changed" };
		const tamperedVerification = await client.request({
			command: "diagnostics/verify",
			payload: { bundle: tampered as JsonValue },
		});
		expect(tamperedVerification).toMatchObject({ ok: true, result: { valid: false } });
	});

	test("enables metadata diagnostics when no recorder is injected", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pis-diagnostics-default-"));
		directories.push(directory);
		const server = createUnixServerV2(new TestService(), { path: join(directory, "server.sock") });
		servers.push(server);
		await server.start();
		const client = await connectUnixTestClientV2(server.addresses[0]!);
		await client.hello();
		const status = await client.request({ command: "diagnostics/status" });
		const doctor = await client.request({ command: "diagnostics/doctor" });
		expect(status).toMatchObject({ ok: true, result: { capture: "metadata", eventCount: 1 } });
		expect(doctor).toMatchObject({ ok: true, result: { ok: true } });
	});

	test("reports operational-log degradation without a critical event", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pis-diagnostics-degraded-"));
		directories.push(directory);
		const diagnostics = new TeeForensicRecorder(new InMemoryForensicRecorder(), {
			record: async () => {
				throw new Error("operational log unavailable");
			},
			read: async () => [],
		});
		await diagnostics.record({ kind: "boot", severity: "info" });
		const server = createUnixServerV2(new TestService(), {
			path: join(directory, "server.sock"),
			diagnostics,
			daemonInstanceId: "daemon-degraded-test",
		});
		servers.push(server);
		await server.start();
		const client = await connectUnixTestClientV2(server.addresses[0]!);
		await client.hello();
		const status = await client.request({ command: "diagnostics/status" });
		expect(status).toMatchObject({
			ok: true,
			result: { capture: "metadata", eventCount: 3, degraded: true, lastCriticalEventSeq: 2 },
		});
		await client.close();
	});

	test("exposes usage ledger aggregates and entries through v2", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pis-usage-wire-"));
		directories.push(directory);
		const usage = new InMemoryV2UsageLedger();
		await usage.record({
			responseId: "response-1",
			sessionId: "session-1",
			agentId: "agent-1",
			operationId: "operation-1",
			purpose: "agent",
			provider: "test",
			model: "small",
			input: 3,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
			pricing: "catalog",
			costUsd: 0.1,
			createdAt: 1,
		});
		const server = createUnixServerV2(new TestService(), { path: join(directory, "server.sock"), usage });
		servers.push(server);
		await server.start();
		const client = await connectUnixTestClientV2(server.addresses[0]!);
		await client.hello();
		const response = await client.request({ command: "usage/read", payload: { sessionId: "session-1" } });
		expect(response).toMatchObject({
			ok: true,
			result: {
				aggregate: { responses: 1, input: 3, output: 2, costUsd: 0.1 },
				entries: [{ responseId: "response-1" }],
			},
		});
	});

	test("routes image view and generation through blob references", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pis-images-"));
		directories.push(directory);
		await writeFile(join(directory, "image.png"), new Uint8Array([137, 80, 78, 71]));
		const imageService = new BlobV2ImageService(
			new LocalV2FileReferenceService({ projectRoot: directory, homeDirectory: directory }),
			new InMemoryV2BlobStore(),
			{
				generate: async (request) => ({
					data: new Uint8Array([1]),
					mimeType: "image/png",
					provider: "fake",
					model: "image-fast",
					sourceOperationId: request.sourceOperationId,
				}),
			},
		);
		const server = createUnixServerV2(new TestService(), {
			path: join(directory, "server.sock"),
			images: imageService,
		});
		servers.push(server);
		await server.start();
		const client = await connectUnixTestClientV2(server.addresses[0]!);
		await client.hello();
		await client.request({ command: "session/attach", sessionId: "session-1" });
		const viewed = await client.request({
			command: "image/view",
			sessionId: "session-1",
			payload: { reference: "image.png" },
		});
		const generated = await client.request({
			command: "image/generate",
			sessionId: "session-1",
			payload: { prompt: "a tree" },
		});
		expect(viewed).toMatchObject({ ok: true, result: { image: { mimeType: "image/png", size: 4 } } });
		expect(generated).toMatchObject({
			ok: true,
			result: {
				image: {
					provider: "fake",
					model: "image-fast",
					mimeType: "image/png",
					sourceOperationId: expect.any(String),
				},
			},
		});
	});

	test("resolves blob-backed turn content before durable acceptance", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pis-turn-content-"));
		directories.push(directory);
		const service = new TestService();
		const server = createUnixServerV2(service, { path: join(directory, "server.sock") });
		servers.push(server);
		await server.start();
		const client = await connectUnixTestClientV2(server.addresses[0]!);
		await client.hello();
		await client.request({ command: "session/attach", sessionId: "session-1" });
		const stored = await client.request({
			command: "blob/put",
			payload: { data: "aGVsbG8=", encoding: "base64", mimeType: "image/png" },
		});
		const digest = (stored as unknown as { result: { blob: { digest: string } } }).result.blob.digest;
		const accepted = await client.request({
			command: "turn/start",
			sessionId: "session-1",
			payload: {
				content: [
					{ type: "text", text: "inspect" },
					{ type: "image", digest, mimeType: "image/png" },
				],
			},
		});
		expect(accepted).toMatchObject({ ok: true, accepted: { sessionRevision: 2 } });
		const runtime = service.sessions.get("session-1")!;
		runtime.release.resolve(undefined);
		await runtime.started.promise;
		expect(runtime.commands[0]).toMatchObject({
			payload: {
				content: [
					{ type: "text", text: "inspect" },
					{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
				],
			},
		});
		const mismatched = await client.request({
			command: "blob/put",
			payload: { data: "Ynll", encoding: "base64", mimeType: "text/plain" },
		});
		const textDigest = (mismatched as unknown as { result: { blob: { digest: string } } }).result.blob.digest;
		const rejected = await client.request({
			command: "turn/start",
			sessionId: "session-1",
			payload: { content: [{ type: "image", digest: textDigest, mimeType: "image/png" }] },
		});
		expect(rejected).toMatchObject({
			ok: false,
			error: { code: "request_failed", message: "turn content item 0 MIME type does not match blob metadata" },
		});
		await client.close();
	});

	test("delegates session creation and deletion through the v2 service boundary", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pis-v2-session-"));
		directories.push(directory);
		const service = new TestService();
		const server = createUnixServerV2(service, { path: join(directory, "server.sock") });
		servers.push(server);
		await server.start();
		const client = await connectUnixTestClientV2(server.addresses[0]!);
		await client.hello();
		const created = await client.request({
			command: "session/create",
			payload: { id: "created-session", cwd: "/tmp" },
		});
		expect(created).toMatchObject({
			ok: true,
			result: { command: "session/create", session: { id: "created-session" } },
		});
		await client.request({ command: "session/attach", sessionId: "created-session", payload: { mode: "control" } });
		const deleted = await client.request({ command: "session/delete", sessionId: "created-session" });
		expect(deleted).toMatchObject({ ok: true, result: { command: "session/delete", sessionId: "created-session" } });
		expect(service.sessions.has("created-session")).toBe(false);
		const replacement = await client.request({ command: "session/create", payload: { id: "created-session" } });
		expect(replacement).toMatchObject({ ok: true, result: { session: { id: "created-session" } } });
		const reacquirer = await connectUnixTestClientV2(server.addresses[0]!);
		await reacquirer.hello();
		await expect(
			reacquirer.request({ command: "session/attach", sessionId: "created-session", payload: { mode: "control" } }),
		).resolves.toMatchObject({ ok: true, result: { lease: "control" } });
		await reacquirer.close();
	});

	test("delegates session forks through the v2 service boundary", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pis-v2-session-fork-"));
		directories.push(directory);
		const service = new TestService();
		const server = createUnixServerV2(service, { path: join(directory, "server.sock") });
		servers.push(server);
		await server.start();
		const client = await connectUnixTestClientV2(server.addresses[0]!);
		await client.hello();
		await client.request({ command: "session/attach", sessionId: "session-1", payload: { mode: "control" } });
		const forked = await client.request({
			command: "session/fork",
			sessionId: "session-1",
			payload: { id: "forked-session", scope: "branch", position: "at" },
		});
		expect(forked).toMatchObject({
			ok: true,
			result: { command: "session/fork", session: { id: "forked-session" } },
		});
		expect(service.sessions.has("forked-session")).toBe(true);
		await client.close();
	});

	test("keeps session deletion under the session controller", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pis-v2-session-delete-lease-"));
		directories.push(directory);
		const service = new TestService();
		const server = createUnixServerV2(service, { path: join(directory, "server.sock") });
		servers.push(server);
		await server.start();
		const controller = await connectUnixTestClientV2(server.addresses[0]!);
		const observer = await connectUnixTestClientV2(server.addresses[0]!);
		await controller.hello();
		await observer.hello();
		await controller.request({ command: "session/attach", sessionId: "session-1" });
		await observer.request({ command: "session/attach", sessionId: "session-1", payload: { mode: "observer" } });
		const rejected = await observer.request({ command: "session/delete", sessionId: "session-1" });
		expect(rejected).toMatchObject({
			ok: false,
			error: { code: "request_failed", message: "Session session-1 requires a control lease" },
		});
		await controller.close();
		await observer.close();
	});

	test("serves app metadata and starts auth through the injected app registry", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pis-v2-app-"));
		directories.push(directory);
		const apps = new InMemoryV2AppRegistry({
			apps: [
				{
					id: "calendar",
					name: "Calendar",
					description: "Calendar connector",
					auth: "unauthenticated",
					enabled: true,
				},
			],
		});
		const server = createUnixServerV2(new TestService(), { path: join(directory, "server.sock"), apps });
		servers.push(server);
		await server.start();
		const client = await connectUnixTestClientV2(server.addresses[0]!);
		await client.hello();
		const listed = await client.request({ command: "app/list" });
		const read = await client.request({ command: "app/read", payload: { id: "calendar" } });
		const auth = await client.request({
			command: "app/auth/start",
			payload: { id: "calendar", authorizationUrl: "https://auth.example.test/start" },
		});
		expect(listed).toMatchObject({ ok: true, result: { apps: [{ id: "calendar", auth: "unauthenticated" }] } });
		expect(read).toMatchObject({ ok: true, result: { app: { id: "calendar", name: "Calendar" } } });
		expect(auth).toMatchObject({
			ok: true,
			result: { auth: { appId: "calendar", state: "pending", authorizationUrl: "https://auth.example.test/start" } },
		});
		const pending = await client.request({ command: "app/read", payload: { id: "calendar" } });
		expect(pending).toMatchObject({ ok: true, result: { app: { id: "calendar", auth: "pending" } } });
	});

	test("acknowledges a turn before starting runtime execution", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pis-v2-"));
		directories.push(directory);
		const service = new TestService();
		const diagnostics = new InMemoryForensicRecorder();
		const diagnosticContent = new LocalDiagnosticCapsuleStore(join(directory, "diagnostic-keys.json"));
		const server = createUnixServerV2(service, {
			path: join(directory, "server.sock"),
			diagnostics,
			diagnosticContent,
		});
		servers.push(server);
		await server.start();
		const client = await connectUnixTestClientV2(server.addresses[0]!);
		await client.hello();
		const attached = await client.request({ command: "session/attach", sessionId: "session-1" });
		expect(attached).toMatchObject({ ok: true, result: { command: "session/attach" } });
		const read = await client.request({ command: "session/read", sessionId: "session-1" });
		expect(read).toMatchObject({ ok: true, result: { command: "session/read", session: { id: "session-1" } } });

		const runtime = service.sessions.get("session-1")!;
		const pending = client.request({ command: "turn/start", sessionId: "session-1", payload: { text: "hello" } });
		const response = await pending;
		expect(response).toMatchObject({
			ok: true,
			accepted: { operationId: expect.stringMatching(/^[0-9a-f-]{36}$/), sessionRevision: 2, eventSeq: 2 },
		});
		expect(runtime.accepted).toHaveLength(1);

		runtime.release.resolve(undefined);
		await runtime.started.promise;
		const terminal = await client.next(
			(message) => message.type === "event" && message.event === "operation_terminal",
		);
		expect(terminal).toMatchObject({
			type: "event",
			operationId: runtime.accepted[0]?.operationId,
			payload: { state: "complete" },
		});
		const operationId = runtime.accepted[0]!.operationId;
		const operation = await client.request({ command: "operation/read", sessionId: "session-1", operationId });
		expect(operation).toMatchObject({
			ok: true,
			result: { command: "operation/read", operation: { operationId, state: "complete", terminalSeq: 3 } },
		});
		expect(
			(await diagnostics.read()).map((event) => event.kind).filter((kind) => kind.startsWith("operation_")),
		).toEqual(["operation_accepted", "operation_terminal"]);
		const acceptedEvent = (await diagnostics.read()).find((event) => event.kind === "operation_accepted")!;
		expect(acceptedEvent.payload).toMatchObject({
			command: "turn/start",
			contentRef: { eventId: operationId, kind: "turn/start", truncated: false },
		});
		expect(acceptedEvent).toMatchObject({
			severity: "info",
			outcome: "started",
			traceId: operationId,
			spanId: expect.any(String),
		});
		expect(acceptedEvent.payload).not.toHaveProperty("text");
		const exported = await client.request({ command: "diagnostics/export" });
		const decrypted = await client.request({ command: "diagnostics/export", payload: { decryptContent: true } });
		const repairSafe = await client.request({ command: "diagnostics/doctor", payload: { repairSafe: true } });
		expect(exported).toMatchObject({
			ok: true,
			result: { capsules: [{ eventId: operationId, kind: "turn/start" }] },
		});
		expect(decrypted).toMatchObject({
			ok: true,
			result: { decryptedCapsules: [{ eventId: operationId, kind: "turn/start", content: expect.any(String) }] },
		});
		if (decrypted.ok && "result" in decrypted) {
			const capsule = (decrypted.result as { decryptedCapsules: Array<{ content: string }> }).decryptedCapsules[0];
			expect(Buffer.from(capsule!.content, "base64").toString()).toContain('"text":"hello"');
		}
		expect(repairSafe).toMatchObject({ ok: true, result: { repairSafe: true, repairs: [] } });
		await client.close();
	});

	test("continues a detached operation and replays events after reattach", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pis-v2-"));
		directories.push(directory);
		const service = new TestService();
		const server = createUnixServerV2(service, { path: join(directory, "server.sock") });
		servers.push(server);
		await server.start();
		const first = await connectUnixTestClientV2(server.addresses[0]!);
		await first.hello();
		await first.request({ command: "session/attach", sessionId: "session-1" });
		const runtime = service.sessions.get("session-1")!;
		const response = await first.request({
			command: "turn/start",
			sessionId: "session-1",
			payload: { text: "hello" },
		});
		expect(response).toMatchObject({ ok: true, accepted: { sessionRevision: 2, eventSeq: 2 } });
		await first.close();

		runtime.release.resolve(undefined);
		await runtime.started.promise;
		const second = await connectUnixTestClientV2(server.addresses[0]!);
		await second.hello({ sessionId: "session-1", eventSeq: 2 });
		const replay = await second.next((message) => message.type === "event" && message.event === "operation_terminal");
		expect(replay).toMatchObject({ type: "event", seq: 4, payload: { state: "complete" } });
		await second.close();
	});

	test("includes the authoritative snapshot in a failed terminal event", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pis-v2-failure-"));
		directories.push(directory);
		const service = new TestService();
		const server = createUnixServerV2(service, { path: join(directory, "server.sock") });
		servers.push(server);
		await server.start();
		const client = await connectUnixTestClientV2(server.addresses[0]!);
		await client.hello();
		await client.request({ command: "session/attach", sessionId: "session-1" });
		const runtime = service.sessions.get("session-1")!;
		runtime.fail = true;

		const response = await client.request({
			command: "turn/start",
			sessionId: "session-1",
			payload: { text: "hello" },
		});
		expect(response).toMatchObject({ ok: true, accepted: { sessionRevision: 2, eventSeq: 2 } });
		const terminal = await client.next(
			(message) => message.type === "event" && message.event === "operation_terminal",
		);
		expect(terminal).toMatchObject({
			type: "event",
			payload: { state: "failed", error: "runtime failed", snapshot: { id: "session-1", phase: "idle" } },
		});
		await client.close();
	});

	test("disposes detached runtimes when the server closes", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pis-v2-shutdown-"));
		directories.push(directory);
		const service = new TestService();
		const server = createUnixServerV2(service, { path: join(directory, "server.sock") });
		servers.push(server);
		await server.start();
		const client = await connectUnixTestClientV2(server.addresses[0]!);
		await client.hello();
		await client.request({ command: "session/attach", sessionId: "session-1" });
		const runtime = service.sessions.get("session-1")!;

		await client.close();
		expect(runtime.disposeCount).toBe(0);

		await server.close();
		expect(runtime.disposeCount).toBe(1);
	});

	test("allows one controller and observer lease per session", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pis-v2-leases-"));
		directories.push(directory);
		const service = new TestService();
		const server = createUnixServerV2(service, { path: join(directory, "server.sock") });
		servers.push(server);
		await server.start();
		const controller = await connectUnixTestClientV2(server.addresses[0]!);
		const observer = await connectUnixTestClientV2(server.addresses[0]!);
		await controller.hello();
		await observer.hello();
		await controller.request({ command: "session/attach", sessionId: "session-1" });
		const observed = await observer.request({
			command: "session/attach",
			sessionId: "session-1",
			payload: { mode: "observer" },
		});
		expect(observed).toMatchObject({ ok: true, result: { lease: "observer" } });
		const rejected = await observer.request({
			command: "turn/start",
			sessionId: "session-1",
			payload: { text: "no" },
		});
		expect(rejected).toMatchObject({
			ok: false,
			error: { code: "request_failed", message: "Session session-1 requires a control lease" },
		});
		const released = await controller.request({
			command: "session/attach",
			sessionId: "session-1",
			payload: { mode: "observer" },
		});
		expect(released).toMatchObject({ ok: true, result: { lease: "observer" } });
		const acquired = await observer.request({
			command: "session/attach",
			sessionId: "session-1",
			payload: { mode: "control" },
		});
		expect(acquired).toMatchObject({ ok: true, result: { lease: "control" } });
		const controllerMutation = await controller.request({
			command: "turn/start",
			sessionId: "session-1",
			payload: { text: "still blocked" },
		});
		expect(controllerMutation).toMatchObject({
			ok: false,
			error: { code: "request_failed", message: "Session session-1 requires a control lease" },
		});
		await controller.close();
		await observer.close();
	});

	test("accepts goal lifecycle commands through the durable operation path", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pis-v2-"));
		directories.push(directory);
		const service = new TestService();
		const server = createUnixServerV2(service, { path: join(directory, "server.sock") });
		servers.push(server);
		await server.start();
		const client = await connectUnixTestClientV2(server.addresses[0]!);
		await client.hello();
		await client.request({ command: "session/attach", sessionId: "session-1" });
		const goal = await client.request({ command: "goal/read", sessionId: "session-1" });
		expect(goal).toMatchObject({ ok: true, result: { command: "goal/read" } });

		const response = await client.request({
			command: "goal/create",
			sessionId: "session-1",
			payload: { objective: "ship the runtime" },
		});
		expect(response).toMatchObject({ ok: true, accepted: { sessionRevision: 2, eventSeq: 2 } });
		expect(service.sessions.get("session-1")?.accepted).toHaveLength(1);

		service.sessions.get("session-1")!.release.resolve(undefined);
		await service.sessions.get("session-1")!.started.promise;
		await client.next((message) => message.type === "event" && message.event === "operation_terminal");
		await client.close();
	});

	test("restores operation records and event replay after server restart", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pis-v2-"));
		directories.push(directory);
		const store = new JsonlV2OperationStore(join(directory, "operations.jsonl"));
		const firstService = new TestService();
		const firstServer = createUnixServerV2(firstService, {
			path: join(directory, "server.sock"),
			operationStore: store,
		});
		servers.push(firstServer);
		await firstServer.start();
		const first = await connectUnixTestClientV2(firstServer.addresses[0]!);
		await first.hello();
		await first.request({ command: "session/attach", sessionId: "session-1" });
		const accepted = await first.request({
			command: "turn/start",
			sessionId: "session-1",
			payload: { text: "hello" },
		});
		const operationId = (accepted as { accepted: OperationAccepted }).accepted.operationId;
		firstService.sessions.get("session-1")!.release.resolve(undefined);
		await firstService.sessions.get("session-1")!.started.promise;
		await first.next((message) => message.type === "event" && message.event === "operation_terminal");
		await first.close();
		await firstServer.close();
		const persisted = await store.load();
		expect(
			persisted.events.filter((event) => event.event === "operation_terminal" && event.operationId === operationId),
		).toHaveLength(1);

		const secondServer = createUnixServerV2(new TestService(), {
			path: join(directory, "server.sock"),
			operationStore: store,
		});
		servers.push(secondServer);
		await secondServer.start();
		const second = await connectUnixTestClientV2(secondServer.addresses[0]!);
		await second.hello({ sessionId: "session-1", eventSeq: 2 });
		const replay = await second.next((message) => message.type === "event" && message.event === "operation_terminal");
		expect(replay).toMatchObject({ operationId, payload: { state: "complete" } });
		const operation = await second.request({ command: "operation/read", operationId, sessionId: "session-1" });
		expect(operation).toMatchObject({ ok: true, result: { operation: { operationId, state: "complete" } } });
		await second.close();
	});

	test("marks non-terminal operations suspended during daemon recovery", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pis-v2-recovery-"));
		directories.push(directory);
		const store = new InMemoryV2OperationStore();
		await store.putOperation({
			operationId: "crashed-operation",
			sessionId: "session-1",
			state: "running",
			accepted: { operationId: "crashed-operation", sessionRevision: 2, eventSeq: 2 },
		});
		const server = createUnixServerV2(new TestService(), {
			path: join(directory, "server.sock"),
			operationStore: store,
		});
		servers.push(server);
		await server.start();
		const client = await connectUnixTestClientV2(server.addresses[0]!);
		await client.hello();
		const operation = await client.request({ command: "operation/read", operationId: "crashed-operation" });
		expect(operation).toMatchObject({
			ok: true,
			result: {
				operation: {
					operationId: "crashed-operation",
					state: "suspended",
					error: "Operation was suspended by daemon restart",
				},
			},
		});
		await client.close();
	});

	test("exposes server-owned process cursors over v2", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pis-v2-"));
		directories.push(directory);
		const diagnostics = new InMemoryForensicRecorder();
		const server = createUnixServerV2(new TestService(), {
			path: join(directory, "server.sock"),
			diagnostics,
			daemonInstanceId: "daemon-v2-test",
			processes: new InMemoryV2ProcessRegistry({ maxOutputBytes: 5 }),
		});
		servers.push(server);
		await server.start();
		const client = await connectUnixTestClientV2(server.addresses[0]!);
		await client.hello();
		const started = await client.request({
			command: "process/start",
			sessionId: "session-1",
			payload: { command: "demo" },
		});
		const processId = (started as unknown as { result: { process: { processId: string } } }).result.process.processId;
		await client.request({ command: "process/write", payload: { processId, input: "abcdef" } });
		const output = await client.request({ command: "process/read", payload: { processId, cursor: 0 } });
		expect(output).toMatchObject({ ok: true, result: { output: { output: "bcdef", cursor: 6, truncated: true } } });
		await client.request({ command: "process/wait", payload: { processId } });
		const terminated = await client.request({ command: "process/terminate", payload: { processId } });
		expect(terminated).toMatchObject({ ok: true, result: { process: { state: "terminated", exitCode: 143 } } });
		const diagnosticEvents = await diagnostics.read();
		expect(new Set(diagnosticEvents.map((event) => event.daemonInstanceId))).toEqual(new Set(["daemon-v2-test"]));
		expect(diagnosticEvents.map((event) => event.kind).filter((kind) => kind.startsWith("process_"))).toEqual([
			"process_started",
			"process_input_written",
			"process_output_read",
			"process_waited",
			"process_terminated",
		]);
		expect(diagnosticEvents.filter((event) => event.kind === "protocol_command_received")).toHaveLength(5);
		expect(diagnosticEvents.filter((event) => event.kind === "protocol_command_completed")).toHaveLength(5);
		const inputEvent = diagnosticEvents.find((event) => event.kind === "process_input_written");
		expect(inputEvent).toMatchObject({
			processInstanceId: processId,
			sessionId: "session-1",
			payload: { byteLength: 6, cursor: 6 },
		});
		await client.close();
	});

	test("keeps process writes and termination under the session controller", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pis-v2-process-leases-"));
		directories.push(directory);
		const server = createUnixServerV2(new TestService(), {
			path: join(directory, "server.sock"),
			processes: new InMemoryV2ProcessRegistry(),
		});
		servers.push(server);
		await server.start();
		const controller = await connectUnixTestClientV2(server.addresses[0]!);
		const observer = await connectUnixTestClientV2(server.addresses[0]!);
		await controller.hello();
		await observer.hello();
		await controller.request({ command: "session/attach", sessionId: "session-1" });
		await observer.request({ command: "session/attach", sessionId: "session-1", payload: { mode: "observer" } });
		const started = await controller.request({
			command: "process/start",
			sessionId: "session-1",
			payload: { command: "demo" },
		});
		const processId = (started as unknown as { result: { process: { processId: string } } }).result.process.processId;
		const read = await observer.request({ command: "process/read", payload: { processId, cursor: 0 } });
		expect(read).toMatchObject({ ok: true, result: { output: { cursor: 0 } } });
		const write = await observer.request({ command: "process/write", payload: { processId, input: "blocked" } });
		expect(write).toMatchObject({ ok: false, error: { message: "Session session-1 requires a control lease" } });
		const terminate = await observer.request({ command: "process/terminate", payload: { processId } });
		expect(terminate).toMatchObject({ ok: false, error: { message: "Session session-1 requires a control lease" } });
		await controller.close();
		await observer.close();
	});

	test("forwards process environment deltas to the node process registry", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pis-v2-process-env-"));
		directories.push(directory);
		const server = createUnixServerV2(new TestService(), {
			path: join(directory, "server.sock"),
			processes: new NodeV2ProcessRegistry(),
		});
		servers.push(server);
		await server.start();
		const client = await connectUnixTestClientV2(server.addresses[0]!);
		await client.hello();
		const started = await client.request({
			command: "process/start",
			sessionId: "session-1",
			payload: {
				command: `${process.execPath} -e "process.stdout.write(process.env.PI_V2_ENV ?? '')"`,
				env: { PI_V2_ENV: "forwarded" },
			},
		});
		const processId = (started as unknown as { result: { process: { processId: string } } }).result.process.processId;
		await client.request({ command: "process/wait", payload: { processId } });
		const output = await client.request({ command: "process/read", payload: { processId, cursor: 0 } });
		expect(output).toMatchObject({ ok: true, result: { output: { output: "forwarded", truncated: false } } });
		await client.close();
	});

	test("transports content-addressed blobs without embedding binary bytes in CBOR", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pis-v2-"));
		directories.push(directory);
		const server = createUnixServerV2(new TestService(), {
			path: join(directory, "server.sock"),
			blobs: new InMemoryV2BlobStore(),
		});
		servers.push(server);
		await server.start();
		const client = await connectUnixTestClientV2(server.addresses[0]!);
		await client.hello();
		const put = await client.request({
			command: "blob/put",
			payload: { data: "aGVsbG8=", encoding: "base64", mimeType: "text/plain" },
		});
		const digest = (put as unknown as { result: { blob: { digest: string } } }).result.blob.digest;
		expect(await client.request({ command: "blob/stat", payload: { digest } })).toMatchObject({
			ok: true,
			result: { blob: { digest, mimeType: "text/plain", size: 5 } },
		});
		expect(await client.request({ command: "blob/read", payload: { digest } })).toMatchObject({
			ok: true,
			result: { digest, encoding: "base64", data: "aGVsbG8=" },
		});
		await client.close();
	});

	test("propagates blob quota failures through the v2 transport", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pis-v2-blob-quota-"));
		directories.push(directory);
		const server = createUnixServerV2(new TestService(), {
			path: join(directory, "server.sock"),
			blobs: new InMemoryV2BlobStore({ maxTotalBytes: 5, maxBlobs: 1 }),
		});
		servers.push(server);
		await server.start();
		const client = await connectUnixTestClientV2(server.addresses[0]!);
		await client.hello();
		const first = await client.request({
			command: "blob/put",
			payload: { data: "aGVsbG8=", encoding: "base64", mimeType: "text/plain" },
		});
		expect(first).toMatchObject({ ok: true });
		expect(
			await client.request({
				command: "blob/put",
				payload: { data: "d29ybGQ=", encoding: "base64", mimeType: "text/plain" },
			}),
		).toMatchObject({ ok: false, error: { code: "request_failed", message: expect.stringContaining("Blob count") } });
		await client.close();
	});

	test("rejects tampered disk-backed blobs through the v2 transport", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pis-v2-blob-integrity-"));
		directories.push(directory);
		const blobDirectory = join(directory, "blobs");
		const server = createUnixServerV2(new TestService(), {
			path: join(directory, "server.sock"),
			blobs: new FileV2BlobStore(blobDirectory),
		});
		servers.push(server);
		await server.start();
		const client = await connectUnixTestClientV2(server.addresses[0]!);
		await client.hello();
		const put = await client.request({
			command: "blob/put",
			payload: { data: "aGVsbG8=", encoding: "base64", mimeType: "text/plain" },
		});
		const digest = (put as unknown as { result: { blob: { digest: string } } }).result.blob.digest;
		await writeFile(join(blobDirectory, `${digest}.blob`), "tampered");
		expect(await client.request({ command: "blob/read", payload: { digest } })).toMatchObject({
			ok: false,
			error: { code: "request_failed", message: expect.stringContaining("digest mismatch") },
		});
		await client.close();
	});

	test("exposes the server-owned agent graph and lifecycle commands", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pis-v2-"));
		directories.push(directory);
		const server = createUnixServerV2(new TestService(), {
			path: join(directory, "server.sock"),
			agents: new InMemoryV2AgentRegistry(),
		});
		servers.push(server);
		await server.start();
		const client = await connectUnixTestClientV2(server.addresses[0]!);
		await client.hello();
		await client.request({ command: "session/attach", sessionId: "session-1" });
		const agentEvent = client.next((message) => message.type === "event" && message.event === "agent_updated");
		const spawned = await client.request({
			command: "agent/spawn",
			sessionId: "session-1",
			payload: { taskName: "research", taskMessage: "inspect auth" },
		});
		expect(await agentEvent).toMatchObject({
			event: "agent_updated",
			payload: { agent: { path: "/root/research" } },
		});
		const agent = (spawned as unknown as { result: { agent: { id: string; path: string } } }).result.agent;
		expect(agent.path).toBe("/root/research");
		expect(await client.request({ command: "agent/list", sessionId: "session-1" })).toMatchObject({
			ok: true,
			result: { agents: [{ id: agent.id, state: "running" }] },
		});
		await client.request({ command: "agent/message", payload: { agentId: agent.id, message: "continue" } });
		const interrupted = await client.request({ command: "agent/interrupt", payload: { agentId: agent.id } });
		expect(interrupted).toMatchObject({ ok: true, result: { agent: { id: agent.id, state: "interrupted" } } });
		await client.close();
	});

	test("keeps agent mutations under the session controller", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pis-v2-agent-leases-"));
		directories.push(directory);
		const server = createUnixServerV2(new TestService(), {
			path: join(directory, "server.sock"),
			agents: new InMemoryV2AgentRegistry(),
		});
		servers.push(server);
		await server.start();
		const controller = await connectUnixTestClientV2(server.addresses[0]!);
		const observer = await connectUnixTestClientV2(server.addresses[0]!);
		await controller.hello();
		await observer.hello();
		await controller.request({ command: "session/attach", sessionId: "session-1" });
		await observer.request({ command: "session/attach", sessionId: "session-1", payload: { mode: "observer" } });
		const spawned = await controller.request({
			command: "agent/spawn",
			sessionId: "session-1",
			payload: { taskName: "lease-test", taskMessage: "inspect ownership" },
		});
		const agentId = (spawned as unknown as { result: { agent: { id: string } } }).result.agent.id;
		const message = await observer.request({ command: "agent/message", payload: { agentId, message: "blocked" } });
		const followUp = await observer.request({ command: "agent/followUp", payload: { agentId, message: "blocked" } });
		const interrupt = await observer.request({ command: "agent/interrupt", payload: { agentId } });
		for (const response of [message, followUp, interrupt])
			expect(response).toMatchObject({
				ok: false,
				error: { message: "Session session-1 requires a control lease" },
			});
		await controller.close();
		await observer.close();
	});

	test("serves versioned plan state through the session snapshot", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pis-v2-"));
		directories.push(directory);
		const server = createUnixServerV2(new TestService(), { path: join(directory, "server.sock") });
		servers.push(server);
		await server.start();
		const client = await connectUnixTestClientV2(server.addresses[0]!);
		await client.hello();
		const updated = await client.request({
			command: "plan/update",
			sessionId: "session-1",
			payload: { items: [{ step: "implement", status: "in_progress" }] },
		});
		expect(updated).toMatchObject({ ok: true, result: { plan: { version: 1 } } });
		await expect(
			client.next((message) => message.type === "event" && message.event === "plan_updated"),
		).resolves.toMatchObject({
			event: "plan_updated",
			payload: { plan: { version: 1, items: [{ step: "implement" }] } },
		});
		const read = await client.request({ command: "session/read", sessionId: "session-1" });
		expect(read).toMatchObject({
			ok: true,
			result: { session: { plan: { version: 1, items: [{ step: "implement" }] } } },
		});
		const cleared = await client.request({ command: "plan/clear", sessionId: "session-1" });
		expect(cleared).toMatchObject({ ok: true, result: { cleared: true } });
		await expect(
			client.next(
				(message) =>
					message.type === "event" &&
					message.event === "plan_updated" &&
					typeof message.payload === "object" &&
					message.payload !== null &&
					"plan" in message.payload &&
					message.payload.plan === null,
			),
		).resolves.toMatchObject({ event: "plan_updated", payload: { plan: null } });
		const clearedSession = await client.request({ command: "session/read", sessionId: "session-1" });
		expect(clearedSession).toMatchObject({ ok: true, result: { session: {} } });
		expect((clearedSession as { result?: { session?: Record<string, unknown> } }).result?.session).not.toHaveProperty(
			"plan",
		);
		await client.close();
	});

	test("keeps structured input owned by the daemon across snapshot reads", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pis-v2-"));
		directories.push(directory);
		const inputs = new InMemoryV2InputRegistry();
		const request = await inputs.create("session-1", [
			{ id: "choice", prompt: "Choose", options: [{ label: "yes" }] },
		]);
		const server = createUnixServerV2(new TestService(), { path: join(directory, "server.sock"), inputs });
		servers.push(server);
		await server.start();
		const client = await connectUnixTestClientV2(server.addresses[0]!);
		await client.hello();
		const session = await client.request({ command: "session/read", sessionId: "session-1" });
		expect(session).toMatchObject({ result: { session: { queues: { pendingInputRequestId: request.id } } } });
		const read = await client.request({ command: "input/request/read", payload: { requestId: request.id } });
		expect(read).toMatchObject({ result: { request: { status: "pending", id: request.id } } });
		await client.request({ command: "session/attach", sessionId: "session-1" });
		const response = await client.request({
			command: "input/request/respond",
			payload: { requestId: request.id, answers: { choice: "yes" } },
		});
		expect(response).toMatchObject({ result: { request: { status: "responded" } } });
		await client.close();
	});
});

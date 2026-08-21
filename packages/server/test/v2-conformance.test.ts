import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	AgentSummary,
	CommandV2,
	ModelMetadata,
	OperationAccepted,
	SessionMetadataV2,
	SessionSnapshotV2,
	UsageAggregate,
} from "@earendil-works/pi-protocol";
import { afterEach, describe, expect, test, vi } from "vitest";
import { InMemoryV2AgentRegistry } from "../src/agents.ts";
import { InMemoryV2AppRegistry } from "../src/apps.ts";
import { InMemoryV2BlobStore } from "../src/blobs.ts";
import { InMemoryForensicRecorder } from "../src/diagnostics.ts";
import { LocalV2FileReferenceService } from "../src/files.ts";
import { InMemoryV2InputRegistry } from "../src/inputs.ts";
import { InMemoryV2OperationStore, JsonlV2OperationStore } from "../src/operation-store.ts";
import { InMemoryV2ProcessRegistry } from "../src/processes.ts";
import { connectUnixTestClientV2, Deferred } from "../src/testing/index.ts";
import { createUnixServerV2 } from "../src/transports/unix/preset.ts";
import type { PiServerServiceV2, PiSessionRuntimeV2 } from "../src/v2.ts";

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
	runEntered = false;
	disposed = false;
	disposeCount = 0;
	fail = false;
	private current: SessionSnapshotV2;

	constructor(id: string) {
		this.current = sessionSnapshot(id);
	}

	async snapshot(): Promise<SessionSnapshotV2> {
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
		this.runEntered = true;
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
		this.disposed = true;
		return Promise.resolve();
	}
}

class ControlledAcceptRuntime extends TestRuntime {
	readonly acceptEntered = new Deferred<void>();
	readonly acceptRelease = new Deferred<void>();
	rejectAccept = false;

	override async accept(operationId: string): Promise<OperationAccepted> {
		this.acceptEntered.resolve(undefined);
		await this.acceptRelease.promise;
		if (this.rejectAccept) throw new Error("accept failed");
		return super.accept(operationId);
	}
}

class BlockingSnapshotRuntime extends TestRuntime {
	readonly snapshotEntered = new Deferred<void>();
	readonly snapshotRelease = new Deferred<void>();

	override async snapshot(): Promise<SessionSnapshotV2> {
		this.snapshotEntered.resolve(undefined);
		await this.snapshotRelease.promise;
		return super.snapshot();
	}
}

class RacingSnapshotRuntime extends TestRuntime {
	readonly firstSnapshotEntered = new Deferred<void>();
	readonly secondSnapshotEntered = new Deferred<void>();
	readonly firstSnapshotRelease = new Deferred<void>();
	readonly secondSnapshotRelease = new Deferred<void>();
	private snapshotCalls = 0;

	override async snapshot(): Promise<SessionSnapshotV2> {
		this.snapshotCalls += 1;
		if (this.snapshotCalls === 1) {
			this.firstSnapshotEntered.resolve(undefined);
			await this.firstSnapshotRelease.promise;
			throw new Error("first attach snapshot failed");
		}
		this.secondSnapshotEntered.resolve(undefined);
		await this.secondSnapshotRelease.promise;
		return super.snapshot();
	}
}

class AllFailSnapshotRuntime extends TestRuntime {
	readonly firstSnapshotEntered = new Deferred<void>();
	readonly secondSnapshotEntered = new Deferred<void>();
	readonly firstSnapshotRelease = new Deferred<void>();
	readonly secondSnapshotRelease = new Deferred<void>();
	private snapshotCalls = 0;

	override async snapshot(): Promise<SessionSnapshotV2> {
		this.snapshotCalls += 1;
		if (this.snapshotCalls === 1) {
			this.firstSnapshotEntered.resolve(undefined);
			await this.firstSnapshotRelease.promise;
		} else {
			this.secondSnapshotEntered.resolve(undefined);
			await this.secondSnapshotRelease.promise;
		}
		throw new Error("attach snapshot failed");
	}
}

class TestService implements PiServerServiceV2 {
	readonly sessionMetadata: SessionMetadataV2[] = [];
	readonly sessions = new Map<string, TestRuntime>();

	constructor(runtime = new TestRuntime("session-1")) {
		this.sessionMetadata.push({ id: "session-1", createdAt: 1, updatedAt: 1 });
		this.sessions.set("session-1", runtime);
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
				execute: async () => [{ id: "result-1", title: "Example", source: "fake", retrievedAt: 1, extract: "ok" }],
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
		await diagnostics.record({ kind: "boot", sessionId: "session-1", payload: { token: "secret" } });
		const server = createUnixServerV2(new TestService(), {
			path: join(directory, "server.sock"),
			diagnostics,
		});
		servers.push(server);
		await server.start();
		const client = await connectUnixTestClientV2(server.addresses[0]!);
		await client.hello();
		await client.request({ command: "session/attach", sessionId: "session-1" });
		const status = await client.request({ command: "diagnostics/status", sessionId: "session-1" });
		const timeline = await client.request({
			command: "diagnostics/timeline",
			sessionId: "session-1",
			payload: { sessionId: "session-1" },
		});
		const exported = await client.request({ command: "diagnostics/export", sessionId: "session-1" });
		const verified = await client.request({ command: "diagnostics/verify", sessionId: "session-1" });
		const doctor = await client.request({ command: "diagnostics/doctor", sessionId: "session-1" });
		expect(status).toMatchObject({ ok: true, result: { capture: "metadata", eventCount: 1 } });
		expect(timeline).toMatchObject({
			ok: true,
			result: { events: [{ kind: "boot", payload: { token: "[REDACTED]" } }] },
		});
		expect(exported).toMatchObject({ ok: true, result: { format: "json", events: [{ seq: 1 }] } });
		expect(verified).toMatchObject({ ok: true, result: { valid: true, gaps: [] } });
		expect(doctor).toMatchObject({ ok: true, result: { ok: true } });
	});

	test("enables metadata diagnostics when no recorder is injected", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pis-diagnostics-default-"));
		directories.push(directory);
		const server = createUnixServerV2(new TestService(), { path: join(directory, "server.sock") });
		servers.push(server);
		await server.start();
		const client = await connectUnixTestClientV2(server.addresses[0]!);
		await client.hello();
		const unauthenticated = await client.request({ command: "diagnostics/status" });
		expect(unauthenticated).toMatchObject({ ok: false, error: { code: "request_failed" } });
		await client.request({ command: "session/attach", sessionId: "session-1" });
		const status = await client.request({ command: "diagnostics/status", sessionId: "session-1" });
		const doctor = await client.request({ command: "diagnostics/doctor", sessionId: "session-1" });
		expect(status).toMatchObject({ ok: true, result: { capture: "metadata", eventCount: 0 } });
		expect(doctor).toMatchObject({ ok: true, result: { ok: true } });
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
		const stored = await client.request({ command: "blob/put", payload: { data: "aGVsbG8=", encoding: "base64", mimeType: "image/png" } });
		const digest = (stored as unknown as { result: { blob: { digest: string } } }).result.blob.digest;
		const accepted = await client.request({ command: "turn/start", sessionId: "session-1", payload: { content: [{ type: "text", text: "inspect" }, { type: "image", digest, mimeType: "image/png" }] } });
		expect(accepted).toMatchObject({ ok: true, accepted: { sessionRevision: 2 } });
		const runtime = service.sessions.get("session-1")!;
		runtime.release.resolve(undefined);
		await runtime.started.promise;
		expect(runtime.commands[0]).toMatchObject({ payload: { content: [{ type: "text", text: "inspect" }, { type: "image", data: "aGVsbG8=", mimeType: "image/png" }] } });
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
		const deleted = await client.request({ command: "session/delete", sessionId: "created-session" });
		expect(deleted).toMatchObject({ ok: true, result: { command: "session/delete", sessionId: "created-session" } });
		expect(service.sessions.has("created-session")).toBe(false);
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
		const server = createUnixServerV2(service, { path: join(directory, "server.sock"), diagnostics });
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
		expect(runtime.runEntered).toBe(false);

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
		expect((await diagnostics.read()).map((event) => event.kind)).toEqual([
			"operation_accepted",
			"operation_terminal",
		]);
		await client.close();
	});

	test("continues a detached operation and replays events after reattach", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pis-v2-"));
		directories.push(directory);
		const service = new TestService();
		const server = createUnixServerV2(service, { path: join(directory, "server.sock") });
		servers.push(server);
		await server.start();
		const firstClient = await connectUnixTestClientV2(server.addresses[0]!);
		await firstClient.hello();
		await firstClient.request({ command: "session/attach", sessionId: "session-1" });
		const accepted = await firstClient.request({ command: "turn/start", sessionId: "session-1", payload: { text: "hello" } });
		expect(accepted).toMatchObject({ ok: true, accepted: { eventSeq: 2 } });
		const runtime = service.sessions.get("session-1")!;
		await firstClient.request({ command: "session/detach", sessionId: "session-1" });
		await firstClient.close();
		expect(runtime.disposed).toBe(false);

		const secondClient = await connectUnixTestClientV2(server.addresses[0]!);
		await secondClient.hello({ sessionId: "session-1", eventSeq: 0 });
		const replayed = await secondClient.next(
			(message) => message.type === "event" && message.event === "operation_accepted",
		);
		expect(replayed).toMatchObject({ type: "event", sessionId: "session-1", seq: 2 });
		await secondClient.request({ command: "session/attach", sessionId: "session-1" });
		expect(runtime.runEntered).toBe(true);
		runtime.release.resolve(undefined);
		await runtime.started.promise;
		const terminal = await secondClient.next(
			(message) => message.type === "event" && message.event === "operation_terminal",
		);
		expect(terminal).toMatchObject({ type: "event", sessionId: "session-1", payload: { state: "complete" } });
		await secondClient.close();
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

		await client.request({ command: "turn/start", sessionId: "session-1", payload: { text: "hello" } });
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
			error: { code: "request_failed" },
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

	test("retains a runtime while accepting an operation across detach", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pis-v2-"));
		directories.push(directory);
		const runtime = new ControlledAcceptRuntime("session-1");
		const service = new TestService(runtime);
		const server = createUnixServerV2(service, { path: join(directory, "server.sock") });
		servers.push(server);
		await server.start();
		const client = await connectUnixTestClientV2(server.addresses[0]!);
		await client.hello();
		await client.request({ command: "session/attach", sessionId: "session-1" });

		const turn = client.request({ command: "turn/start", sessionId: "session-1", payload: { text: "hello" } });
		await runtime.acceptEntered.promise;
		await expect(client.request({ command: "session/detach", sessionId: "session-1" })).resolves.toMatchObject({ ok: true });
		expect(runtime.disposed).toBe(false);

		runtime.acceptRelease.resolve(undefined);
		await expect(turn).resolves.toMatchObject({ ok: true, accepted: { operationId: expect.any(String) } });
		runtime.release.resolve(undefined);
		await runtime.started.promise;
		await vi.waitFor(() => expect(runtime.disposed).toBe(true));
	});

	test("releases and disposes a runtime when acceptance fails after detach", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pis-v2-"));
		directories.push(directory);
		const runtime = new ControlledAcceptRuntime("session-1");
		runtime.rejectAccept = true;
		const service = new TestService(runtime);
		const server = createUnixServerV2(service, { path: join(directory, "server.sock") });
		servers.push(server);
		await server.start();
		const client = await connectUnixTestClientV2(server.addresses[0]!);
		await client.hello();
		await client.request({ command: "session/attach", sessionId: "session-1" });

		const turn = client.request({ command: "turn/start", sessionId: "session-1", payload: { text: "hello" } });
		await runtime.acceptEntered.promise;
		await expect(client.request({ command: "session/detach", sessionId: "session-1" })).resolves.toMatchObject({ ok: true });
		runtime.acceptRelease.resolve(undefined);
		await expect(turn).resolves.toMatchObject({ ok: false, error: { code: "request_failed" } });
		await vi.waitFor(() => expect(runtime.disposed).toBe(true));
	});

	test("does not dispose a runtime while a pending attach still holds its lease", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pis-v2-"));
		directories.push(directory);
		const runtime = new BlockingSnapshotRuntime("session-1");
		const service = new TestService(runtime);
		const server = createUnixServerV2(service, { path: join(directory, "server.sock") });
		servers.push(server);
		await server.start();
		const client = await connectUnixTestClientV2(server.addresses[0]!);
		await client.hello();
		const attachment = client.request({ command: "session/attach", sessionId: "session-1" });
		await runtime.snapshotEntered.promise;

		await client.close();
		expect(runtime.disposed).toBe(false);

		runtime.snapshotRelease.resolve(undefined);
		await vi.waitFor(() => expect(runtime.disposed).toBe(true));
		await attachment.catch(() => undefined);
	});

	test("does not let a failed concurrent attach remove a successful shared attachment", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pis-v2-"));
		directories.push(directory);
		const runtime = new RacingSnapshotRuntime("session-1");
		const service = new TestService(runtime);
		const server = createUnixServerV2(service, { path: join(directory, "server.sock") });
		servers.push(server);
		await server.start();
		const client = await connectUnixTestClientV2(server.addresses[0]!);
		await client.hello();

		const first = client.request({ command: "session/attach", sessionId: "session-1" });
		await runtime.firstSnapshotEntered.promise;
		const second = client.request({ command: "session/attach", sessionId: "session-1" });
		await runtime.secondSnapshotEntered.promise;

		runtime.firstSnapshotRelease.resolve(undefined);
		await expect(first).resolves.toMatchObject({ ok: false, error: { code: "request_failed" } });
		runtime.secondSnapshotRelease.resolve(undefined);
		await expect(second).resolves.toMatchObject({ ok: true, result: { command: "session/attach" } });
		expect(runtime.disposed).toBe(false);

		await expect(client.request({ command: "session/detach", sessionId: "session-1" })).resolves.toMatchObject({ ok: true });
		await vi.waitFor(() => expect(runtime.disposed).toBe(true));
	});

	test("disposes and unmaps a runtime when every concurrent attach fails", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pis-v2-"));
		directories.push(directory);
		const runtime = new AllFailSnapshotRuntime("session-1");
		const service = new TestService(runtime);
		const server = createUnixServerV2(service, { path: join(directory, "server.sock") });
		servers.push(server);
		await server.start();
		const client = await connectUnixTestClientV2(server.addresses[0]!);
		await client.hello();

		const first = client.request({ command: "session/attach", sessionId: "session-1" });
		await runtime.firstSnapshotEntered.promise;
		const second = client.request({ command: "session/attach", sessionId: "session-1" });
		await runtime.secondSnapshotEntered.promise;
		runtime.firstSnapshotRelease.resolve(undefined);
		runtime.secondSnapshotRelease.resolve(undefined);
		await expect(first).resolves.toMatchObject({ ok: false, error: { code: "request_failed" } });
		await expect(second).resolves.toMatchObject({ ok: false, error: { code: "request_failed" } });
		await vi.waitFor(() => expect(runtime.disposed).toBe(true));
		await expect(client.request({ command: "session/read", sessionId: "session-1" })).resolves.toMatchObject({
			ok: false,
			error: { code: "request_failed" },
		});
		await client.close();
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
		await second.request({ command: "session/attach", sessionId: "session-1" });
		const operation = await second.request({ command: "operation/read", operationId, sessionId: "session-1" });
		expect(operation).toMatchObject({ ok: true, result: { operation: { operationId, state: "complete" } } });
		await second.close();
	});

	test("exposes server-owned process cursors over v2", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pis-v2-"));
		directories.push(directory);
		const server = createUnixServerV2(new TestService(), {
			path: join(directory, "server.sock"),
			processes: new InMemoryV2ProcessRegistry({ maxOutputBytes: 5 }),
		});
		servers.push(server);
		await server.start();
		const client = await connectUnixTestClientV2(server.addresses[0]!);
		await client.hello();
		await client.request({ command: "session/attach", sessionId: "session-1" });
		const started = await client.request({
			command: "process/start",
			sessionId: "session-1",
			payload: { command: "demo" },
		});
		const processId = (started as unknown as { result: { process: { processId: string } } }).result.process.processId;
		await client.request({ command: "process/write", payload: { processId, input: "abcdef" } });
		const output = await client.request({ command: "process/read", payload: { processId, cursor: 0 } });
		expect(output).toMatchObject({ ok: true, result: { output: { output: "bcdef", cursor: 6, truncated: true } } });
		const terminated = await client.request({ command: "process/terminate", payload: { processId } });
		expect(terminated).toMatchObject({ ok: true, result: { process: { state: "terminated", exitCode: 143 } } });
		await client.close();
	});

	test("keeps process writes and termination under the session controller", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pis-v2-"));
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
		const started = await controller.request({ command: "process/start", sessionId: "session-1", payload: { command: "demo" } });
		const processId = (started as unknown as { result: { process: { processId: string } } }).result.process.processId;
		await expect(observer.request({ command: "process/read", payload: { processId, cursor: 0 } })).resolves.toMatchObject({ ok: true });
		await expect(observer.request({ command: "process/write", payload: { processId, input: "x" } })).resolves.toMatchObject({ ok: false, error: { code: "request_failed" } });
		await expect(observer.request({ command: "process/terminate", payload: { processId } })).resolves.toMatchObject({ ok: false, error: { code: "request_failed" } });
		await controller.close();
		await observer.close();
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
		const messageEvent = client.next((message) => message.type === "event" && message.event === "agent_message");
		await client.request({
			command: "agent/message",
			payload: { agentId: agent.id, message: `token=super-secret ${"continue ".repeat(1000)}` },
		});
		const receivedMessage = await messageEvent;
		expect(receivedMessage).toMatchObject({
			event: "agent_message",
			payload: { agentId: agent.id, message: expect.stringContaining("token=[redacted]") },
		});
		if (receivedMessage.type === "event") {
			const payload = receivedMessage.payload as { message?: unknown };
			if (typeof payload.message === "string") expect(payload.message.length).toBeLessThanOrEqual(4096);
		}
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
		const responses = await Promise.all([
			observer.request({ command: "agent/message", payload: { agentId, message: "blocked" } }),
			observer.request({ command: "agent/followUp", payload: { agentId, message: "blocked" } }),
			observer.request({ command: "agent/interrupt", payload: { agentId } }),
		]);
		for (const response of responses) expect(response).toMatchObject({ ok: false, error: { code: "request_failed" } });
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
		await client.request({ command: "session/attach", sessionId: "session-1" });
		const updated = await client.request({
			command: "plan/update",
			sessionId: "session-1",
			payload: { items: [{ step: "implement", status: "in_progress" }] },
		});
		expect(updated).toMatchObject({ ok: true, result: { plan: { version: 1 } } });
		const read = await client.request({ command: "session/read", sessionId: "session-1" });
		expect(read).toMatchObject({
			ok: true,
			result: { session: { plan: { version: 1, items: [{ step: "implement" }] } } },
		});
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
		await client.request({ command: "session/attach", sessionId: "session-1" });
		const session = await client.request({ command: "session/read", sessionId: "session-1" });
		expect(session).toMatchObject({ result: { session: { queues: { pendingInputRequestId: request.id } } } });
		const read = await client.request({ command: "input/request/read", payload: { requestId: request.id } });
		expect(read).toMatchObject({ result: { request: { status: "pending", id: request.id } } });
		const response = await client.request({
			command: "input/request/respond",
			payload: { requestId: request.id, answers: { choice: "yes" } },
		});
		expect(response).toMatchObject({ result: { request: { status: "responded" } } });
		await client.close();
	});
});

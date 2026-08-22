import { mkdtemp, rm } from "node:fs/promises";
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
import { afterEach, describe, expect, test } from "vitest";
import { InMemoryV2AgentRegistry } from "../src/agents.ts";
import { InMemoryV2BlobStore } from "../src/blobs.ts";
import { InMemoryForensicRecorder } from "../src/diagnostics.ts";
import { InMemoryV2InputRegistry } from "../src/inputs.ts";
import { InMemoryV2OperationStore } from "../src/operation-store.ts";
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
	readonly started = new Deferred<void>();
	readonly release = new Deferred<void>();
	runEntered = false;
	disposed = false;
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
}

afterEach(async () => {
	await Promise.all(servers.map((server) => server.close()));
	servers.length = 0;
	await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
	directories.length = 0;
	runtimes.length = 0;
});

describe("PiServer v2 operation acceptance", () => {
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
});

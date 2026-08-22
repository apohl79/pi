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

class TestService implements PiServerServiceV2 {
	readonly sessionMetadata: SessionMetadataV2[] = [];
	readonly sessions = new Map<string, TestRuntime>();

	constructor() {
		this.sessionMetadata.push({ id: "session-1", createdAt: 1, updatedAt: 1 });
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
		runtime.release.resolve(undefined);
		await runtime.started.promise;
		const terminal = await secondClient.next(
			(message) => message.type === "event" && message.event === "operation_terminal",
		);
		expect(terminal).toMatchObject({ type: "event", sessionId: "session-1", payload: { state: "complete" } });
		await secondClient.close();
	});
});

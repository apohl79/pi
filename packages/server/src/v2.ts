import { randomUUID } from "node:crypto";
import {
	type ClientHelloV2,
	type CommandV2,
	decodeCbor,
	type EventEnvelopeV2,
	encodeServerMessageV2,
	FrameDecoder,
	type ModelMetadata,
	type OperationAccepted,
	type OperationRecordV2,
	PROTOCOL_V2_VERSION,
	parseClientMessageV2,
	type ServerMessageV2,
	type ServerSnapshotV2,
	type SessionMetadataV2,
	type SessionSnapshotV2,
} from "@earendil-works/pi-protocol";
import { InMemoryV2AgentRegistry, type V2AgentRegistry } from "./agents.ts";
import { InMemoryV2BlobStore, type V2BlobStore } from "./blobs.ts";
import type { ByteConnection, ByteConnectionHandler } from "./connection.ts";
import type { ForensicRecorder } from "./diagnostics.ts";
import { InMemoryV2InputRegistry, type V2InputRegistry } from "./inputs.ts";
import type { PiServerListener } from "./listener.ts";
import { InMemoryV2OperationStore, type V2OperationStore } from "./operation-store.ts";
import { InMemoryV2PlanRegistry, type V2PlanRegistry } from "./plans.ts";
import { InMemoryV2ProcessRegistry, type V2ProcessRegistry } from "./processes.ts";
import { toProtocolJsonValue } from "./protocol.ts";
import type { MaybePromise } from "./types.ts";

export interface PiSessionRuntimeV2 {
	snapshot(): MaybePromise<SessionSnapshotV2>;
	accept(operationId: string): Promise<OperationAccepted>;
	run(operationId: string, command: CommandV2): Promise<void>;
	dispose(): Promise<void>;
}

export interface PiServerServiceV2 {
	listSessions(): Promise<SessionMetadataV2[]>;
	listModels(): Promise<ModelMetadata[]>;
	openSession(sessionId: string): Promise<PiSessionRuntimeV2>;
}

export interface PiServerV2Options {
	listeners: readonly PiServerListener[];
	maxFrameLength?: number;
	handshakeTimeoutMs?: number;
	serverId?: string;
	onError?: (error: Error) => void;
	diagnostics?: ForensicRecorder;
	operationStore?: V2OperationStore;
	processes?: V2ProcessRegistry;
	blobs?: V2BlobStore;
	agents?: V2AgentRegistry;
	plans?: V2PlanRegistry;
	inputs?: V2InputRegistry;
}

type V2ConnectionState = {
	id: string;
	connection: ByteConnection;
	decoder: FrameDecoder;
	sessions: Map<string, PiSessionRuntimeV2>;
	ready: boolean;
	closed: boolean;
	handshakeTimeout: NodeJS.Timeout;
};

const DEFAULT_MAX_FRAME_LENGTH = 4 * 1024 * 1024;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;

function objectPayload(command: CommandV2): Record<string, unknown> {
	if (typeof command.payload !== "object" || command.payload === null || Array.isArray(command.payload)) return {};
	return command.payload as Record<string, unknown>;
}

function processIdFrom(command: CommandV2, payload: Record<string, unknown>): string {
	const processId = payload.processId ?? command.operationId;
	if (typeof processId !== "string" || processId.length === 0) throw new Error("processId is required");
	return processId;
}

function agentIdFrom(command: CommandV2, payload: Record<string, unknown>): string {
	const agentId = payload.agentId ?? command.operationId;
	if (typeof agentId !== "string" || agentId.length === 0) throw new Error("agentId is required");
	return agentId;
}

function requestIdFrom(command: CommandV2, payload: Record<string, unknown>): string {
	const requestId = payload.requestId ?? command.operationId;
	if (typeof requestId !== "string" || requestId.length === 0) throw new Error("requestId is required");
	return requestId;
}

export class PiServerV2 {
	readonly id: string;
	private readonly listeners: readonly PiServerListener[];
	private readonly service: PiServerServiceV2;
	private readonly maxFrameLength: number;
	private readonly handshakeTimeoutMs: number;
	private readonly onError: ((error: Error) => void) | undefined;
	private readonly diagnostics: ForensicRecorder | undefined;
	private readonly operationStore: V2OperationStore;
	private readonly processes: V2ProcessRegistry;
	private readonly blobs: V2BlobStore;
	private readonly agents: V2AgentRegistry;
	private readonly plans: V2PlanRegistry;
	private readonly inputs: V2InputRegistry;
	private readonly connections = new Set<V2ConnectionState>();
	private readonly eventHistory = new Map<string, EventEnvelopeV2[]>();
	private readonly operations = new Map<string, OperationRecordV2>();
	private readonly disposedRuntimes = new WeakSet<PiSessionRuntimeV2>();
	private closing = false;
	private started = false;
	private restored = false;

	constructor(service: PiServerServiceV2, options: PiServerV2Options) {
		this.service = service;
		this.listeners = options.listeners;
		this.id = options.serverId ?? randomUUID();
		this.maxFrameLength = options.maxFrameLength ?? DEFAULT_MAX_FRAME_LENGTH;
		this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
		this.onError = options.onError;
		this.diagnostics = options.diagnostics;
		this.operationStore = options.operationStore ?? new InMemoryV2OperationStore();
		this.processes = options.processes ?? new InMemoryV2ProcessRegistry();
		this.blobs = options.blobs ?? new InMemoryV2BlobStore();
		this.agents = options.agents ?? new InMemoryV2AgentRegistry();
		this.plans = options.plans ?? new InMemoryV2PlanRegistry();
		this.inputs = options.inputs ?? new InMemoryV2InputRegistry();
	}

	get addresses(): readonly string[] {
		return this.listeners.flatMap((listener) => (listener.address === undefined ? [] : [listener.address]));
	}

	async start(): Promise<this> {
		if (this.started || this.closing) throw new Error("PiServerV2 is already started or closing");
		const started: PiServerListener[] = [];
		try {
			await this.restoreStore();
			for (const listener of this.listeners) {
				await listener.start((connection) => this.accept(connection));
				started.push(listener);
			}
			this.started = true;
			return this;
		} catch (error) {
			await Promise.allSettled(started.map((listener) => listener.close()));
			throw error;
		}
	}

	private async restoreStore(): Promise<void> {
		if (this.restored) return;
		const stored = await this.operationStore.load();
		for (const operation of stored.operations) this.operations.set(operation.operationId, operation);
		for (const event of stored.events) {
			const history = this.eventHistory.get(event.sessionId) ?? [];
			history.push(event);
			this.eventHistory.set(event.sessionId, history);
		}
		this.restored = true;
	}

	accept(connection: ByteConnection): ByteConnectionHandler {
		if (this.closing) {
			void connection.close();
			return { onData: () => {}, onClose: () => {}, onError: (error) => this.reportError(error) };
		}
		const state = this.createConnectionState(connection);
		this.connections.add(state);
		return {
			onData: (chunk) => this.receive(state, chunk),
			onClose: () => this.disconnect(state),
			onError: (error) => {
				this.reportError(error);
				void Promise.resolve(state.connection.close()).then(() => this.disconnect(state));
			},
		};
	}

	async close(): Promise<void> {
		if (this.closing) return;
		this.closing = true;
		await Promise.all(this.listeners.map((listener) => listener.close()));
		await Promise.all(Array.from(this.connections, (state) => this.closeConnection(state)));
		this.started = false;
	}

	private createConnectionState(connection: ByteConnection): V2ConnectionState {
		const state = {
			id: randomUUID(),
			connection,
			decoder: new FrameDecoder({ maxFrameLength: this.maxFrameLength }),
			sessions: new Map<string, PiSessionRuntimeV2>(),
			ready: false,
			closed: false,
			handshakeTimeout: undefined as unknown as NodeJS.Timeout,
		};
		state.handshakeTimeout = setTimeout(() => {
			void this.failProtocol(state, "invalid_request", "Handshake timeout");
		}, this.handshakeTimeoutMs);
		state.handshakeTimeout.unref();
		return state;
	}

	private receive(state: V2ConnectionState, chunk: Uint8Array): void {
		if (state.closed) return;
		try {
			for (const frame of state.decoder.push(chunk)) this.dispatch(state, parseClientMessageV2(decodeCbor(frame)));
		} catch (error) {
			void this.failProtocol(state, "invalid_request", error instanceof Error ? error.message : String(error));
		}
	}

	private dispatch(state: V2ConnectionState, message: ReturnType<typeof parseClientMessageV2>): void {
		if (!state.ready) {
			if (message.type !== "hello") return void this.failProtocol(state, "invalid_request", "Expected v2 hello");
			void this.handshake(state, message);
			return;
		}
		if (message.type !== "request")
			return void this.failProtocol(state, "invalid_request", "Hello is only valid once");
		void this.handleRequest(state, message.id, message.request);
	}

	private async handshake(state: V2ConnectionState, message: ClientHelloV2): Promise<void> {
		if (message.version !== PROTOCOL_V2_VERSION)
			return void (await this.failProtocol(state, "unsupported_version", "Unsupported protocol version"));
		try {
			const snapshot: ServerSnapshotV2 = {
				serverId: this.id,
				protocolVersion: PROTOCOL_V2_VERSION,
				revision: 0,
				eventSeq: 0,
				sessions: await this.service.listSessions(),
				models: await this.service.listModels(),
			};
			await this.send(state, { type: "hello", version: PROTOCOL_V2_VERSION, connectionId: state.id, snapshot });
			state.ready = true;
			clearTimeout(state.handshakeTimeout);
			if (message.lastEvent) {
				const events = this.eventHistory.get(message.lastEvent.sessionId) ?? [];
				await Promise.all(
					events
						.filter((event) => event.seq > message.lastEvent!.eventSeq)
						.map((event) => this.send(state, event)),
				);
			}
		} catch (error) {
			await this.failProtocol(state, "internal_error", error instanceof Error ? error.message : String(error));
		}
	}

	private async handleRequest(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		try {
			if (command.command === "session/list")
				return void (await this.sendResponse(state, id, {
					command: command.command,
					sessions: await this.service.listSessions(),
				}));
			if (command.command === "model/list")
				return void (await this.sendResponse(state, id, {
					command: command.command,
					models: await this.service.listModels(),
				}));
			if (command.command === "operation/read") return void (await this.readOperation(state, id, command));
			if (command.command === "session/attach") return void (await this.attach(state, id, command));
			if (command.command === "session/read") return void (await this.readSession(state, id, command));
			if (command.command === "goal/read") return void (await this.readGoal(state, id, command));
			if (command.command === "process/start") return void (await this.startProcess(state, id, command));
			if (command.command === "process/write") return void (await this.writeProcess(state, id, command));
			if (command.command === "process/read") return void (await this.readProcess(state, id, command));
			if (command.command === "process/wait") return void (await this.waitProcess(state, id, command));
			if (command.command === "process/terminate") return void (await this.terminateProcess(state, id, command));
			if (command.command === "blob/put") return void (await this.putBlob(state, id, command));
			if (command.command === "blob/read") return void (await this.readBlob(state, id, command));
			if (command.command === "blob/stat") return void (await this.statBlob(state, id, command));
			if (command.command === "agent/spawn") return void (await this.spawnAgent(state, id, command));
			if (command.command === "agent/list") return void (await this.listAgents(state, id, command));
			if (command.command === "agent/wait") return void (await this.waitAgent(state, id, command));
			if (command.command === "agent/message") return void (await this.messageAgent(state, id, command));
			if (command.command === "agent/followUp") return void (await this.followUpAgent(state, id, command));
			if (command.command === "agent/interrupt") return void (await this.interruptAgent(state, id, command));
			if (command.command === "plan/read") return void (await this.readPlan(state, id, command));
			if (command.command === "plan/update") return void (await this.updatePlan(state, id, command));
			if (command.command === "input/request/read") return void (await this.readInputRequest(state, id, command));
			if (command.command === "input/request/respond")
				return void (await this.respondInputRequest(state, id, command));
			if (command.command === "input/request/cancel")
				return void (await this.cancelInputRequest(state, id, command));
			if (command.command === "session/detach") return void (await this.detach(state, id, command));
			if (
				command.command === "turn/start" ||
				command.command === "turn/steer" ||
				command.command === "turn/followUp" ||
				command.command === "turn/abort" ||
				command.command === "turn/resume" ||
				command.command === "turn/rollback" ||
				command.command === "goal/create" ||
				command.command === "goal/update" ||
				command.command === "goal/pause" ||
				command.command === "goal/resume" ||
				command.command === "session/model/set" ||
				command.command === "session/thinking/set" ||
				command.command === "session/name/set" ||
				command.command === "session/name/generate" ||
				command.command === "session/name/auto/set"
			)
				return void (await this.startTurn(state, id, command));
			await this.sendError(
				state,
				id,
				"not_implemented",
				`Command ${command.command} is not implemented in the v2 seam`,
			);
		} catch (error) {
			await this.sendError(state, id, "request_failed", error instanceof Error ? error.message : String(error));
		}
	}

	private async attach(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		if (!command.sessionId) throw new Error("session/attach requires sessionId");
		const runtime = await this.service.openSession(command.sessionId);
		state.sessions.set(command.sessionId, runtime);
		await this.sendResponse(state, id, {
			command: command.command,
			session: toProtocolJsonValue(await this.snapshotForSession(command.sessionId, runtime)),
		});
	}

	private async readSession(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		if (!command.sessionId) throw new Error("session/read requires sessionId");
		const runtime = state.sessions.get(command.sessionId) ?? (await this.service.openSession(command.sessionId));
		state.sessions.set(command.sessionId, runtime);
		await this.sendResponse(state, id, {
			command: command.command,
			session: toProtocolJsonValue(await this.snapshotForSession(command.sessionId, runtime)),
		});
	}

	private async readGoal(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		if (!command.sessionId) throw new Error("goal/read requires sessionId");
		const runtime = state.sessions.get(command.sessionId) ?? (await this.service.openSession(command.sessionId));
		state.sessions.set(command.sessionId, runtime);
		const snapshot = await runtime.snapshot();
		await this.sendResponse(
			state,
			id,
			snapshot.goal === undefined ? { command: command.command } : { command: command.command, goal: snapshot.goal },
		);
	}

	private async startProcess(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		if (!command.sessionId) throw new Error("process/start requires sessionId");
		const payload = objectPayload(command);
		if (typeof payload.command !== "string") throw new Error("process/start requires command");
		const process = await this.processes.start({
			sessionId: command.sessionId,
			command: payload.command,
			...(typeof payload.cwd === "string" ? { cwd: payload.cwd } : {}),
			...(typeof payload.pty === "boolean" ? { pty: payload.pty } : {}),
		});
		await this.sendResponse(state, id, {
			command: command.command,
			process: process as unknown as Record<string, unknown>,
		});
	}

	private async writeProcess(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		const payload = objectPayload(command);
		const processId = processIdFrom(command, payload);
		if (typeof payload.input !== "string") throw new Error("process/write requires input");
		await this.sendResponse(state, id, {
			command: command.command,
			output: await this.processes.write(processId, payload.input),
		});
	}

	private async readProcess(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		const payload = objectPayload(command);
		const processId = processIdFrom(command, payload);
		const cursor = typeof payload.cursor === "number" ? payload.cursor : 0;
		await this.sendResponse(state, id, {
			command: command.command,
			output: await this.processes.read(processId, cursor),
		});
	}

	private async waitProcess(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		const payload = objectPayload(command);
		await this.sendResponse(state, id, {
			command: command.command,
			process: await this.processes.wait(processIdFrom(command, payload)),
		});
	}

	private async terminateProcess(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		const payload = objectPayload(command);
		await this.sendResponse(state, id, {
			command: command.command,
			process: await this.processes.terminate(processIdFrom(command, payload)),
		});
	}

	private async putBlob(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		const payload = objectPayload(command);
		if (typeof payload.data !== "string" || typeof payload.mimeType !== "string")
			throw new Error("blob/put requires data and mimeType");
		const encoding = payload.encoding === "base64" ? "base64" : payload.encoding === "utf8" ? "utf8" : undefined;
		if (!encoding) throw new Error("blob/put encoding must be utf8 or base64");
		const data = encoding === "base64" ? Buffer.from(payload.data, "base64") : Buffer.from(payload.data, "utf8");
		await this.sendResponse(state, id, {
			command: command.command,
			blob: await this.blobs.put(data, payload.mimeType),
		});
	}

	private async readBlob(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		const payload = objectPayload(command);
		if (typeof payload.digest !== "string") throw new Error("blob/read requires digest");
		const data = await this.blobs.read(payload.digest);
		await this.sendResponse(state, id, {
			command: command.command,
			digest: payload.digest,
			encoding: "base64",
			data: Buffer.from(data).toString("base64"),
		});
	}

	private async statBlob(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		const payload = objectPayload(command);
		if (typeof payload.digest !== "string") throw new Error("blob/stat requires digest");
		await this.sendResponse(state, id, { command: command.command, blob: await this.blobs.stat(payload.digest) });
	}

	private async spawnAgent(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		if (!command.sessionId) throw new Error("agent/spawn requires sessionId");
		const payload = objectPayload(command);
		if (typeof payload.taskName !== "string" || typeof payload.taskMessage !== "string")
			throw new Error("agent/spawn requires taskName and taskMessage");
		const modelPayload =
			typeof payload.model === "object" && payload.model !== null && !Array.isArray(payload.model)
				? (payload.model as Record<string, unknown>)
				: {};
		const agent = await this.agents.spawn({
			sessionId: command.sessionId,
			parentPath: typeof payload.parentPath === "string" ? payload.parentPath : "/root",
			taskName: payload.taskName,
			taskMessage: payload.taskMessage,
			...(typeof payload.role === "string" ? { role: payload.role } : {}),
			model: {
				provider: typeof modelPayload.provider === "string" ? modelPayload.provider : "inherit",
				id: typeof modelPayload.id === "string" ? modelPayload.id : "inherit",
			},
		});
		await this.sendResponse(state, id, { command: command.command, agent });
	}

	private async listAgents(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		if (!command.sessionId) throw new Error("agent/list requires sessionId");
		await this.sendResponse(state, id, {
			command: command.command,
			agents: await this.agents.list(command.sessionId),
		});
	}

	private async waitAgent(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		const payload = objectPayload(command);
		const agentId = agentIdFrom(command, payload);
		await this.sendResponse(state, id, {
			command: command.command,
			agent: await this.agents.wait(agentId, typeof payload.timeoutMs === "number" ? payload.timeoutMs : undefined),
		});
	}

	private async messageAgent(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		const payload = objectPayload(command);
		const agentId = agentIdFrom(command, payload);
		if (typeof payload.message !== "string") throw new Error("agent/message requires message");
		await this.agents.message(agentId, payload.message);
		await this.sendResponse(state, id, { command: command.command, agentId });
	}

	private async followUpAgent(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		const payload = objectPayload(command);
		const agentId = agentIdFrom(command, payload);
		if (typeof payload.message !== "string") throw new Error("agent/followUp requires message");
		await this.sendResponse(state, id, {
			command: command.command,
			agent: await this.agents.followUp(agentId, payload.message),
		});
	}

	private async interruptAgent(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		const payload = objectPayload(command);
		await this.sendResponse(state, id, {
			command: command.command,
			agent: await this.agents.interrupt(agentIdFrom(command, payload)),
		});
	}

	private async snapshotForSession(sessionId: string, runtime: PiSessionRuntimeV2): Promise<SessionSnapshotV2> {
		const snapshot = await runtime.snapshot();
		const agents = await this.agents.list(sessionId);
		const plan = await this.plans.read(sessionId);
		const pendingInputRequestId = await this.inputs.pendingForSession(sessionId);
		return {
			...snapshot,
			...(agents.length === 0 ? {} : { agents: [...agents] }),
			...(plan === undefined ? {} : { plan }),
			queues: {
				...snapshot.queues,
				...(pendingInputRequestId === undefined ? {} : { pendingInputRequestId }),
			},
		};
	}

	private async readPlan(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {

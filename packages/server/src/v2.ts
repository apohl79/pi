import { createHash, randomUUID } from "node:crypto";
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
import { InMemoryV2AppRegistry, type V2App, type V2AppRegistry } from "./apps.ts";
import { InMemoryV2BlobStore, type V2BlobStore } from "./blobs.ts";
import type { ByteConnection, ByteConnectionHandler } from "./connection.ts";
import {
	type DiagnosticCapsule,
	type DiagnosticContentStore,
	type DiagnosticIntegrityProvider,
	type DiagnosticRuntimeManifest,
	type ForensicRecorder,
	InMemoryForensicRecorder,
	verifyDiagnosticBundle,
} from "./diagnostics.ts";
import { LocalV2FileReferenceService, type V2FileReferenceService } from "./files.ts";
import { BlobV2ImageService, type V2ImageService } from "./images.ts";
import { InMemoryV2InputRegistry, type V2InputRegistry } from "./inputs.ts";
import type { PiServerListener } from "./listener.ts";
import { InMemoryV2OperationStore, type V2OperationStore } from "./operation-store.ts";
import { InMemoryV2PlanRegistry, type V2PlanRegistry } from "./plans.ts";
import { InMemoryV2PluginRegistry, type V2PluginRegistry } from "./plugins.ts";
import { InMemoryV2ProcessRegistry, type V2ProcessRegistry } from "./processes.ts";
import { toProtocolJsonValue } from "./protocol.ts";
import type { MaybePromise } from "./types.ts";
import { InMemoryV2UsageLedger, type V2UsageFilter, type V2UsageLedger } from "./usage-ledger.ts";
import { UnavailableV2WebService, type V2WebOperation, type V2WebService } from "./web.ts";

function fileReferencePayload(file: Awaited<ReturnType<V2FileReferenceService["resolve"]>>): Record<string, unknown> {
	return {
		reference: file.reference,
		path: file.path,
		kind: file.kind,
		...(file.size === undefined ? {} : { size: file.size }),
		...(file.mimeType === undefined ? {} : { mimeType: file.mimeType }),
	};
}

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
	createSession?(options: Record<string, unknown>): Promise<{ sessionId: string; runtime: PiSessionRuntimeV2 }>;
	deleteSession?(sessionId: string): Promise<void>;
}

export interface PiServerV2Options {
	listeners: readonly PiServerListener[];
	maxFrameLength?: number;
	handshakeTimeoutMs?: number;
	serverId?: string;
	onError?: (error: Error) => void;
	diagnostics?: ForensicRecorder;
	diagnosticContent?: DiagnosticContentStore;
	integrity?: DiagnosticIntegrityProvider;
	runtimeManifest?: DiagnosticRuntimeManifest;
	operationStore?: V2OperationStore;
	processes?: V2ProcessRegistry;
	blobs?: V2BlobStore;
	agents?: V2AgentRegistry;
	apps?: V2AppRegistry;
	plans?: V2PlanRegistry;
	inputs?: V2InputRegistry;
	files?: V2FileReferenceService;
	web?: V2WebService;
	images?: V2ImageService;
	plugins?: V2PluginRegistry;
	usage?: V2UsageLedger;
}

type V2ConnectionState = {
	id: string;
	connection: ByteConnection;
	decoder: FrameDecoder;
	sessions: Map<string, PiSessionRuntimeV2>;
	controlSessions: Set<string>;
	ready: boolean;
	closed: boolean;
	clientDiagnostics?: ClientHelloV2["diagnostics"];
	handshakeTimeout: NodeJS.Timeout;
};

const DEFAULT_MAX_FRAME_LENGTH = 4 * 1024 * 1024;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;

function objectPayload(command: CommandV2): Record<string, unknown> {
	if (typeof command.payload !== "object" || command.payload === null || Array.isArray(command.payload)) return {};
	return command.payload as Record<string, unknown>;
}

function parseForkTurns(value: unknown): "none" | "all" | number {
	if (value === "none" || value === "all") return value;
	if (typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 32) return value;
	throw new Error("agent/spawn forkTurns must be none, all, or an integer from 1 to 32");
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

function referenceFrom(command: CommandV2, payload: Record<string, unknown>): string {
	const reference = payload.reference ?? command.operationId;
	if (typeof reference !== "string" || reference.length === 0) throw new Error("file reference is required");
	return reference;
}

export class PiServerV2 {
	readonly id: string;
	private readonly listeners: readonly PiServerListener[];
	private readonly service: PiServerServiceV2;
	private readonly maxFrameLength: number;
	private readonly handshakeTimeoutMs: number;
	private readonly onError: ((error: Error) => void) | undefined;
	private readonly diagnostics: ForensicRecorder;
	private readonly diagnosticContent: DiagnosticContentStore | undefined;
	private readonly integrity: DiagnosticIntegrityProvider | undefined;
	private readonly runtimeManifest: DiagnosticRuntimeManifest;
	private readonly diagnosticCapsules = new Map<string, DiagnosticCapsule>();
	private readonly operationStore: V2OperationStore;
	private readonly processes: V2ProcessRegistry;
	private readonly blobs: V2BlobStore;
	private readonly agents: V2AgentRegistry;
	private readonly apps: V2AppRegistry;
	private readonly plans: V2PlanRegistry;
	private readonly inputs: V2InputRegistry;
	private readonly files: V2FileReferenceService;
	private readonly web: V2WebService;
	private readonly images: V2ImageService;
	private readonly plugins: V2PluginRegistry;
	private readonly usage: V2UsageLedger;
	private readonly connections = new Set<V2ConnectionState>();
	private readonly controls = new Map<string, string>();
	private readonly runtimes = new Set<PiSessionRuntimeV2>();
	private readonly eventHistory = new Map<string, EventEnvelopeV2[]>();
	private readonly agentWatches = new Set<string>();
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
		this.diagnostics = options.diagnostics ?? new InMemoryForensicRecorder();
		this.diagnosticContent = options.diagnosticContent;
		this.integrity = options.integrity;
		this.runtimeManifest = options.runtimeManifest ?? {
			schemaVersion: 1,
			runtime: `node ${process.version}`,
			platform: process.platform,
			arch: process.arch,
		};
		this.operationStore = options.operationStore ?? new InMemoryV2OperationStore();
		this.processes = options.processes ?? new InMemoryV2ProcessRegistry();
		this.blobs = options.blobs ?? new InMemoryV2BlobStore();
		this.agents = options.agents ?? new InMemoryV2AgentRegistry();
		this.apps = options.apps ?? new InMemoryV2AppRegistry();
		this.plans = options.plans ?? new InMemoryV2PlanRegistry();
		this.inputs = options.inputs ?? new InMemoryV2InputRegistry();
		this.files =
			options.files ?? new LocalV2FileReferenceService({ projectRoot: process.cwd(), allowAbsolute: false });
		this.web = options.web ?? new UnavailableV2WebService();
		this.images = options.images ?? new BlobV2ImageService(this.files, this.blobs);
		this.plugins = options.plugins ?? new InMemoryV2PluginRegistry();
		this.usage = options.usage ?? new InMemoryV2UsageLedger();
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
		for (const operation of stored.operations) {
			const recovered =
				operation.state === "accepted" || operation.state === "running"
					? {
							...operation,
							state: "suspended" as const,
							error: "Operation was suspended by daemon restart",
						}
					: operation;
			this.operations.set(recovered.operationId, recovered);
			if (recovered !== operation) await this.operationStore.putOperation(recovered);
		}
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
		await Promise.all(Array.from(this.runtimes, (runtime) => this.disposeRuntime(runtime)));
		this.runtimes.clear();
		await this.agents.dispose?.();
		this.started = false;
	}

	private createConnectionState(connection: ByteConnection): V2ConnectionState {
		const state = {
			id: randomUUID(),
			connection,
			decoder: new FrameDecoder({ maxFrameLength: this.maxFrameLength }),
			sessions: new Map<string, PiSessionRuntimeV2>(),
			controlSessions: new Set<string>(),
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
			state.clientDiagnostics = message.diagnostics;
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
			if (command.command === "session/create") return void (await this.createSession(state, id, command));
			if (command.command === "session/delete") return void (await this.deleteSession(state, id, command));
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
			if (command.command === "app/list") return void (await this.listApps(state, id, command));
			if (command.command === "app/read") return void (await this.readApp(state, id, command));
			if (command.command === "app/auth/start") return void (await this.startAppAuth(state, id, command));
			if (command.command === "app/auth/complete") return void (await this.completeAppAuth(state, id, command));
			if (command.command === "plan/read") return void (await this.readPlan(state, id, command));
			if (command.command === "plan/update") return void (await this.updatePlan(state, id, command));
			if (command.command === "plan/clear") return void (await this.clearPlan(state, id, command));
			if (command.command === "input/request/read") return void (await this.readInputRequest(state, id, command));
			if (command.command === "input/request/respond")
				return void (await this.respondInputRequest(state, id, command));
			if (command.command === "input/request/cancel")
				return void (await this.cancelInputRequest(state, id, command));
			if (command.command === "filesystem/complete") return void (await this.completeFiles(state, id, command));
			if (command.command === "filesystem/reference/resolve")
				return void (await this.resolveFile(state, id, command));
			if (command.command === "filesystem/reference/read") return void (await this.readFile(state, id, command));
			if (command.command === "web") return void (await this.webRequest(state, id, command));
			if (command.command === "image/view") return void (await this.viewImage(state, id, command));
			if (command.command === "image/generate") return void (await this.generateImage(state, id, command));
			if (command.command === "diagnostics/status") return void (await this.diagnosticsStatus(state, id, command));
			if (command.command === "diagnostics/timeline")
				return void (await this.diagnosticsTimeline(state, id, command));
			if (command.command === "diagnostics/export") return void (await this.diagnosticsExport(state, id, command));
			if (command.command === "diagnostics/verify") return void (await this.diagnosticsVerify(state, id, command));
			if (command.command === "diagnostics/doctor") return void (await this.diagnosticsDoctor(state, id, command));
			if (command.command === "marketplace/add") return void (await this.addMarketplace(state, id, command));
			if (command.command === "marketplace/list") return void (await this.listMarketplaces(state, id, command));
			if (command.command === "marketplace/upgrade") return void (await this.upgradeMarketplace(state, id, command));
			if (command.command === "marketplace/remove") return void (await this.removeMarketplace(state, id, command));
			if (command.command === "plugin/list") return void (await this.listPlugins(state, id, command));
			if (command.command === "plugin/read") return void (await this.readPlugin(state, id, command));
			if (command.command === "plugin/install") return void (await this.installPlugin(state, id, command));
			if (command.command === "plugin/uninstall") return void (await this.uninstallPlugin(state, id, command));
			if (command.command === "plugin/enable") return void (await this.setPluginEnabled(state, id, command, true));
			if (command.command === "plugin/disable") return void (await this.setPluginEnabled(state, id, command, false));
			if (command.command === "usage/read") return void (await this.readUsage(state, id, command));
			if (command.command === "session/detach") return void (await this.detach(state, id, command));
			if (
				command.command === "turn/start" ||
				command.command === "turn/steer" ||
				command.command === "turn/followUp" ||
				command.command === "turn/abort" ||
				command.command === "turn/resume" ||
				command.command === "turn/rollback" ||
				command.command === "turn/compact" ||
				command.command === "goal/create" ||
				command.command === "goal/update" ||
				command.command === "goal/pause" ||
				command.command === "goal/resume" ||
				command.command === "session/model/set" ||
				command.command === "session/thinking/set" ||
				command.command === "session/steering-mode/set" ||
				command.command === "session/follow-up-mode/set" ||
				command.command === "session/compaction/set" ||
				command.command === "session/retry/set" ||
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

	private async createSession(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		if (!this.service.createSession) throw new Error("session/create is not supported by this service");
		const payload = objectPayload(command);
		for (const field of ["id", "name", "cwd"]) {
			if (payload[field] !== undefined && typeof payload[field] !== "string")
				throw new Error(`session/create ${field} must be a string`);
		}
		const created = await this.service.createSession(payload);
		if (state.sessions.has(created.sessionId)) throw new Error(`Session ${created.sessionId} is already attached`);
		this.trackRuntime(created.runtime);
		state.sessions.set(created.sessionId, created.runtime);
		await this.sendResponse(state, id, {
			command: command.command,
			session: toProtocolJsonValue(await this.snapshotForSession(created.sessionId, created.runtime)),
		});
	}

	private async deleteSession(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		if (!command.sessionId) throw new Error("session/delete requires sessionId");
		if (!this.service.deleteSession) throw new Error("session/delete is not supported by this service");
		await this.service.deleteSession(command.sessionId);
		const runtime = state.sessions.get(command.sessionId);
		state.sessions.delete(command.sessionId);
		if (runtime && !this.hasRuntimeReference(runtime)) await this.disposeRuntime(runtime);
		await this.sendResponse(state, id, { command: command.command, sessionId: command.sessionId });
	}

	private async attach(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		if (!command.sessionId) throw new Error("session/attach requires sessionId");
		const payload = objectPayload(command);
		const mode = payload.mode === undefined ? "control" : payload.mode;
		if (mode !== "control" && mode !== "observer") throw new Error("session/attach mode must be control or observer");
		const runtime = await this.service.openSession(command.sessionId);
		if (mode === "control") this.claimControl(state, command.sessionId);
		else this.releaseControlFor(state, command.sessionId);
		this.trackRuntime(runtime);
		state.sessions.set(command.sessionId, runtime);
		await this.sendResponse(state, id, {
			command: command.command,
			lease: mode,
			session: toProtocolJsonValue(await this.snapshotForSession(command.sessionId, runtime)),
		});
	}

	private async readSession(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		if (!command.sessionId) throw new Error("session/read requires sessionId");
		const runtime = state.sessions.get(command.sessionId) ?? (await this.service.openSession(command.sessionId));
		this.trackRuntime(runtime);
		state.sessions.set(command.sessionId, runtime);
		await this.sendResponse(state, id, {
			command: command.command,
			session: toProtocolJsonValue(await this.snapshotForSession(command.sessionId, runtime)),
		});
	}

	private async readGoal(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		if (!command.sessionId) throw new Error("goal/read requires sessionId");
		const runtime = state.sessions.get(command.sessionId) ?? (await this.service.openSession(command.sessionId));
		this.trackRuntime(runtime);
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
		this.requireControl(state, command.sessionId);
		const payload = objectPayload(command);
		if (typeof payload.command !== "string") throw new Error("process/start requires command");
		let env: Record<string, string> | undefined;
		if (payload.env !== undefined) {
			if (typeof payload.env !== "object" || payload.env === null || Array.isArray(payload.env))
				throw new Error("process/start env must be an object");
			env = {};
			for (const [name, value] of Object.entries(payload.env)) {
				if (typeof value !== "string") throw new Error(`process/start env ${name} must be a string`);
				env[name] = value;
			}
		}
		const process = await this.processes.start({
			sessionId: command.sessionId,
			command: payload.command,
			...(typeof payload.cwd === "string" ? { cwd: payload.cwd } : {}),
			...(env === undefined ? {} : { env }),
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
		this.requireControl(state, (await this.processes.getSnapshot(processId)).sessionId);
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
		this.requireControl(state, (await this.processes.getSnapshot(processIdFrom(command, payload))).sessionId);
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
		this.requireControl(state, command.sessionId);
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
			...(payload.forkTurns === undefined ? {} : { forkTurns: parseForkTurns(payload.forkTurns) }),
			model: {
				provider: typeof modelPayload.provider === "string" ? modelPayload.provider : "inherit",
				id: typeof modelPayload.id === "string" ? modelPayload.id : "inherit",
			},
			modelResolution: Object.keys(modelPayload).length === 0 ? "inherited" : "explicit",
		});
		await this.sendResponse(state, id, { command: command.command, agent });
		const runtime = state.sessions.get(command.sessionId);
		if (runtime) {
			await this.broadcastEvent(command.sessionId, runtime, { agent }, undefined, "agent_updated");
			this.watchAgent(command.sessionId, runtime, agent.id);
		}
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
		this.requireControl(state, (await this.agents.getSnapshot(agentId)).sessionId);
		if (typeof payload.message !== "string") throw new Error("agent/message requires message");
		const message = payload.message;
		await this.agents.message(agentId, message);
		await this.sendResponse(state, id, { command: command.command, agentId });
		const sessionId = (await this.agents.getSnapshot(agentId)).sessionId;
		const runtime = state.sessions.get(sessionId);
		if (runtime) await this.broadcastEvent(sessionId, runtime, { agentId, message }, undefined, "agent_message");
	}

	private async followUpAgent(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		const payload = objectPayload(command);
		const agentId = agentIdFrom(command, payload);
		this.requireControl(state, (await this.agents.getSnapshot(agentId)).sessionId);
		if (typeof payload.message !== "string") throw new Error("agent/followUp requires message");
		const agent = await this.agents.followUp(agentId, payload.message);
		await this.sendResponse(state, id, {
			command: command.command,
			agent,
		});
		const sessionId = (await this.agents.getSnapshot(agentId)).sessionId;
		const runtime = state.sessions.get(sessionId);
		if (runtime) await this.broadcastEvent(sessionId, runtime, { agent }, undefined, "agent_updated");
	}

	private async interruptAgent(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		const payload = objectPayload(command);
		this.requireControl(state, (await this.agents.getSnapshot(agentIdFrom(command, payload))).sessionId);
		const agent = await this.agents.interrupt(agentIdFrom(command, payload));
		await this.sendResponse(state, id, {
			command: command.command,
			agent,
		});
		const sessionId = (await this.agents.getSnapshot(agent.id)).sessionId;
		const runtime = state.sessions.get(sessionId);
		if (runtime) {
			await this.broadcastEvent(sessionId, runtime, { agent }, undefined, "agent_updated");
			this.watchAgent(sessionId, runtime, agent.id);
		}
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

	private watchAgent(sessionId: string, runtime: PiSessionRuntimeV2, agentId: string): void {
		const key = `${sessionId}:${agentId}`;
		if (this.agentWatches.has(key)) return;
		this.agentWatches.add(key);
		void this.agents
			.wait(agentId)
			.then(async (agent) => {
				if (!this.closing) await this.broadcastEvent(sessionId, runtime, { agent }, undefined, "agent_updated");
			})
			.catch((error) => this.reportError(error instanceof Error ? error : new Error(String(error))))
			.finally(() => this.agentWatches.delete(key));
	}

	private async readPlan(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		if (!command.sessionId) throw new Error("plan/read requires sessionId");
		const plan = await this.plans.read(command.sessionId);
		await this.sendResponse(
			state,
			id,
			plan === undefined ? { command: command.command } : { command: command.command, plan },
		);
	}

	private async updatePlan(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		if (!command.sessionId) throw new Error("plan/update requires sessionId");
		this.requireControl(state, command.sessionId);
		const payload = objectPayload(command);
		if (!Array.isArray(payload.items)) throw new Error("plan/update requires items");
		const items = payload.items as Array<{ step: string; status: "pending" | "in_progress" | "completed" }>;
		const plan = await this.plans.update(command.sessionId, {
			items,
			...(typeof payload.version === "number" ? { version: payload.version } : {}),
		});
		await this.sendResponse(state, id, { command: command.command, plan });
		const runtime = state.sessions.get(command.sessionId) ?? (await this.service.openSession(command.sessionId));
		this.trackRuntime(runtime);
		state.sessions.set(command.sessionId, runtime);
		await this.broadcastEvent(command.sessionId, runtime, { plan }, undefined, "plan_updated");
	}

	private async clearPlan(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		if (!command.sessionId) throw new Error("plan/clear requires sessionId");
		this.requireControl(state, command.sessionId);
		if (!this.plans.clear) throw new Error("plan/clear is not supported by this registry");
		await this.plans.clear(command.sessionId);
		const runtime = state.sessions.get(command.sessionId) ?? (await this.service.openSession(command.sessionId));
		this.trackRuntime(runtime);
		state.sessions.set(command.sessionId, runtime);
		await this.sendResponse(state, id, { command: command.command, cleared: true });
		await this.broadcastEvent(command.sessionId, runtime, { plan: null }, undefined, "plan_updated");
	}

	private async readInputRequest(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		const requestId = requestIdFrom(command, objectPayload(command));
		await this.sendResponse(state, id, { command: command.command, request: await this.inputs.read(requestId) });
	}

	private async respondInputRequest(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		const payload = objectPayload(command);
		const requestId = requestIdFrom(command, payload);
		const request = await this.inputs.read(requestId);
		this.requireControl(state, request.sessionId);
		if (typeof payload.answers !== "object" || payload.answers === null || Array.isArray(payload.answers))
			throw new Error("input/request/respond requires answers");
		const answers = Object.fromEntries(
			Object.entries(payload.answers as Record<string, unknown>).map(([key, value]) => {
				if (typeof value !== "string") throw new Error(`Answer ${key} must be a string`);
				return [key, value];
			}),
		);
		const responded = await this.inputs.respond(requestId, answers);
		await this.sendResponse(state, id, {
			command: command.command,
			request: responded,
		});
		const runtime = state.sessions.get(request.sessionId);
		if (runtime !== undefined && (await runtime.snapshot()).phase === "idle") {
			const operationId = randomUUID();
			await runtime.accept(operationId);
			void runtime
				.run(operationId, { command: "turn/resume", sessionId: request.sessionId, payload: {} })
				.catch(() => undefined);
		}
	}

	private async cancelInputRequest(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		const requestId = requestIdFrom(command, objectPayload(command));
		const request = await this.inputs.read(requestId);
		this.requireControl(state, request.sessionId);
		await this.sendResponse(state, id, { command: command.command, request: await this.inputs.cancel(requestId) });
	}

	private async completeFiles(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		if (!command.sessionId) throw new Error("filesystem/complete requires sessionId");
		const payload = objectPayload(command);
		const prefix = typeof payload.prefix === "string" ? payload.prefix : "";
		await this.sendResponse(state, id, {
			command: command.command,
			items: await this.files.complete(command.sessionId, prefix),
		});
	}

	private async resolveFile(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		if (!command.sessionId) throw new Error("filesystem/reference/resolve requires sessionId");
		await this.sendResponse(state, id, {
			command: command.command,
			file: fileReferencePayload(
				await this.files.resolve(command.sessionId, referenceFrom(command, objectPayload(command))),
			),
		});
	}

	private async readFile(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		if (!command.sessionId) throw new Error("filesystem/reference/read requires sessionId");
		const result = await this.files.read(command.sessionId, referenceFrom(command, objectPayload(command)));
		await this.sendResponse(state, id, {
			command: command.command,
			file: fileReferencePayload(result.file),
			encoding: "base64",
			data: Buffer.from(result.data).toString("base64"),
		});
	}

	private async webRequest(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		if (!command.sessionId) throw new Error("web requires sessionId");
		const payload = objectPayload(command);
		const operation = payload.operation;
		const operations: readonly V2WebOperation[] = [
			"search_query",
			"open",
			"click",
			"find",
			"screenshot",
			"image_query",
		];
		if (typeof operation !== "string" || !operations.includes(operation as V2WebOperation))
			throw new Error("web operation is invalid");
		const request = {
			operation: operation as V2WebOperation,
			...(typeof payload.query === "string" ? { query: payload.query } : {}),
			...(typeof payload.url === "string" ? { url: payload.url } : {}),
			...(typeof payload.refId === "string" ? { refId: payload.refId } : {}),
			...(typeof payload.pattern === "string" ? { pattern: payload.pattern } : {}),
		};
		await this.sendResponse(state, id, {
			command: command.command,
			results: await this.web.execute(command.sessionId, request),
		});
	}

	private async viewImage(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		if (!command.sessionId) throw new Error("image/view requires sessionId");
		const payload = objectPayload(command);
		if (typeof payload.reference !== "string") throw new Error("image/view requires reference");
		await this.sendResponse(state, id, {
			command: command.command,
			image: await this.images.view(command.sessionId, payload.reference),
		});
	}

	private async generateImage(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		if (!command.sessionId) throw new Error("image/generate requires sessionId");
		this.requireControl(state, command.sessionId);
		const payload = objectPayload(command);
		if (typeof payload.prompt !== "string") throw new Error("image/generate requires prompt");
		const image = await this.images.generate(command.sessionId, {
			prompt: payload.prompt,
			...(typeof payload.sourceDigest === "string" ? { sourceDigest: payload.sourceDigest } : {}),
			sourceOperationId: id,
		});
		await this.usage.record({
			responseId: `${id}:image`,
			sessionId: command.sessionId,
			agentId: command.sessionId,
			operationId: id,
			purpose: "otherSideband",
			provider: image.provider,
			model: image.model,
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			pricing: image.costUsd === undefined ? "unknown" : "providerReported",
			...(image.costUsd === undefined ? {} : { costUsd: image.costUsd }),
			imageUnits: 1,
			createdAt: Date.now(),
		});
		await this.sendResponse(state, id, {
			command: command.command,
			image,
		});
	}

	private async diagnosticsStatus(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		const events = await this.diagnosticEvents();
		await this.sendResponse(state, id, {
			command: command.command,
			capture: "metadata",
			degraded: false,
			lastCriticalEventSeq: events.at(-1)?.seq ?? 0,
			eventCount: events.length,
		});
	}

	private async diagnosticsTimeline(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		const payload = objectPayload(command);
		const events = await this.diagnosticEvents(typeof payload.afterSeq === "number" ? payload.afterSeq : 0);
		await this.sendResponse(state, id, {
			command: command.command,
			events: events.filter(
				(event) =>
					(typeof payload.sessionId !== "string" || event.sessionId === payload.sessionId) &&
					(typeof payload.operationId !== "string" || event.operationId === payload.operationId),
			),
		});
	}

	private async diagnosticsExport(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		const payload = objectPayload(command);
		const events = await this.diagnosticEvents();
		const capsules = await this.diagnosticCapsulesForExport();
		const decryptedCapsules =
			payload.decryptContent === true ? await this.diagnosticCapsulesForDecryption(capsules) : undefined;
		const serializedEvents = JSON.stringify(events);
		const manifest = {
			schemaVersion: 1,
			eventCount: events.length,
			firstSeq: events[0]?.seq ?? 0,
			lastSeq: events.at(-1)?.seq ?? 0,
			eventsSha256: createHash("sha256").update(serializedEvents).digest("hex"),
			unavailable: ["client-diagnostic-spool"],
		};
		await this.sendResponse(state, id, {
			command: command.command,
			format: "json",
			events,
			capsules,
			bundle: {
				manifest,
				runtimeManifest: this.runtimeManifest,
				...(state.clientDiagnostics === undefined ? {} : { clientDiagnostics: state.clientDiagnostics }),
				events,
				capsules,
				...(decryptedCapsules === undefined ? {} : { decryptedCapsules }),
			},
			...(decryptedCapsules === undefined ? {} : { decryptedCapsules }),
		});
	}

	private async diagnosticsVerify(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		const payload = objectPayload(command);
		const bundle = payload.bundle;
		if (typeof bundle === "object" && bundle !== null && !Array.isArray(bundle)) {
			const verification = verifyDiagnosticBundle(bundle);
			if (verification.reason === "diagnostics/verify bundle requires events and manifest")
				throw new Error(verification.reason);
			await this.sendResponse(state, id, {
				command: command.command,
				...verification,
			});
			return;
		}
		const events = await this.diagnosticEvents();
		const gaps = events.slice(1).flatMap((event, index) => {
			const previous = events[index];
			return previous && event.seq !== previous.seq + 1 ? [{ from: previous.seq, to: event.seq }] : [];
		});
		await this.sendResponse(state, id, { command: command.command, valid: gaps.length === 0, gaps });
	}

	private async diagnosticsDoctor(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		const payload = objectPayload(command);
		const events = await this.diagnosticEvents();
		const sequenceOk = events.every((event, index) => index === 0 || event.seq === events[index - 1]!.seq + 1);
		const checks = [
			{ name: "recorder", ok: true },
			{ name: "sequence", ok: sequenceOk },
			...(this.integrity === undefined ? [] : await this.integrity()),
		];
		await this.sendResponse(state, id, {
			command: command.command,
			ok: checks.every((check) => check.ok),
			checks,
			...(payload.repairSafe === true ? { repairSafe: true, repairs: [] } : {}),
		});
	}

	private async addMarketplace(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		const payload = objectPayload(command);
		if (typeof payload.name !== "string" || typeof payload.source !== "string")
			throw new Error("marketplace/add requires name and source");
		await this.sendResponse(state, id, {
			command: command.command,
			marketplace: await this.plugins.addMarketplace(payload.name, payload.source),
		});
	}

	private async listMarketplaces(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		await this.sendResponse(state, id, {
			command: command.command,
			marketplaces: await this.plugins.listMarketplaces(),
		});
	}

	private async upgradeMarketplace(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		const payload = objectPayload(command);
		if (typeof payload.name !== "string") throw new Error("marketplace/upgrade requires name");
		await this.sendResponse(state, id, {
			command: command.command,
			marketplace: await this.plugins.upgradeMarketplace(payload.name),
		});
	}

	private async removeMarketplace(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		const payload = objectPayload(command);
		if (typeof payload.name !== "string") throw new Error("marketplace/remove requires name");
		await this.plugins.removeMarketplace(payload.name);
		await this.sendResponse(state, id, { command: command.command, name: payload.name });
	}

	private async listPlugins(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		const payload = objectPayload(command);
		await this.sendResponse(state, id, {
			command: command.command,
			plugins: await this.plugins.listPlugins(payload.installedOnly === true),
		});
	}

	private async readPlugin(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		const payload = objectPayload(command);
		if (typeof payload.id !== "string") throw new Error("plugin/read requires id");
		const plugin = await this.plugins.readPlugin(payload.id);
		if (!plugin) throw new Error(`Unknown plugin: ${payload.id}`);
		await this.sendResponse(state, id, { command: command.command, plugin });
	}

	private async installPlugin(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		const payload = objectPayload(command);
		if (
			typeof payload.name !== "string" ||
			typeof payload.marketplace !== "string" ||
			typeof payload.version !== "string" ||
			typeof payload.manifest !== "object" ||
			payload.manifest === null ||
			Array.isArray(payload.manifest)
		)
			throw new Error("plugin/install requires name, marketplace, version, and manifest");
		await this.sendResponse(state, id, {
			command: command.command,
			plugin: await this.plugins.installPlugin({
				name: payload.name,
				marketplace: payload.marketplace,
				version: payload.version,
				manifest: payload.manifest as Record<string, unknown>,
				...(typeof payload.root === "string" ? { root: payload.root } : {}),
				...(payload.scope === "user" || payload.scope === "project" ? { scope: payload.scope } : {}),
			}),
		});
	}

	private async uninstallPlugin(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		const payload = objectPayload(command);
		if (typeof payload.id !== "string") throw new Error("plugin/uninstall requires id");
		await this.plugins.uninstallPlugin(payload.id);
		await this.sendResponse(state, id, { command: command.command, id: payload.id });
	}

	private async setPluginEnabled(
		state: V2ConnectionState,
		id: string,
		command: CommandV2,
		enabled: boolean,
	): Promise<void> {
		const payload = objectPayload(command);
		if (typeof payload.id !== "string") throw new Error(`${command.command} requires id`);
		await this.sendResponse(state, id, {
			command: command.command,
			plugin: await this.plugins.setEnabled(
				payload.id,
				enabled,
				payload.scope === "user" || payload.scope === "project" ? payload.scope : undefined,
			),
		});
	}

	private async listApps(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		const installed = (await this.plugins.listPlugins(true))
			.filter((plugin) => plugin.enabled)
			.flatMap((plugin) => plugin.appDescriptors ?? []);
		await this.sendResponse(state, id, {
			command: command.command,
			apps: [...(await this.apps.list()), ...installed],
		});
	}

	private async readApp(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		const payload = objectPayload(command);
		if (typeof payload.id !== "string") throw new Error("app/read requires id");
		const app =
			(await this.apps.read(payload.id)) ??
			((await this.plugins.listPlugins(true))
				.filter((plugin) => plugin.enabled)
				.flatMap((plugin) => plugin.appDescriptors ?? [])
				.find((candidate) => candidate.id === payload.id) as V2App | undefined);
		if (!app) throw new Error(`Unknown app: ${payload.id}`);
		await this.sendResponse(state, id, { command: command.command, app });
	}

	private async startAppAuth(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		const payload = objectPayload(command);
		if (typeof payload.id !== "string") throw new Error("app/auth/start requires id");
		const standalone = await this.apps.read(payload.id);
		if (!standalone && this.plugins.startAppAuth !== undefined) {
			await this.sendResponse(state, id, {
				command: command.command,
				auth: await this.plugins.startAppAuth(payload.id, payload),
			});
			return;
		}
		await this.sendResponse(state, id, {
			command: command.command,
			auth: await this.apps.startAuth(payload.id, payload),
		});
	}

	private async completeAppAuth(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		const payload = objectPayload(command);
		if (typeof payload.id !== "string") throw new Error("app/auth/complete requires id");
		const standalone = await this.apps.read(payload.id);
		if (!standalone && this.plugins.completeAppAuth !== undefined) {
			await this.sendResponse(state, id, {
				command: command.command,
				auth: await this.plugins.completeAppAuth(payload.id, payload),
			});
			return;
		}
		await this.sendResponse(state, id, {
			command: command.command,
			auth: await this.apps.completeAuth(payload.id, payload),
		});
	}

	private async readUsage(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		const payload = objectPayload(command);
		const filter: V2UsageFilter = {};
		for (const key of ["sessionId", "agentId", "turnId", "goalId", "provider", "model"] as const) {
			if (payload[key] !== undefined && typeof payload[key] !== "string")
				throw new Error(`usage/read ${key} must be a string`);
			if (typeof payload[key] === "string") (filter as { [name: string]: string })[key] = payload[key];
		}
		if (
			payload.purpose !== undefined &&
			!["agent", "compaction", "sessionName", "otherSideband"].includes(String(payload.purpose))
		)
			throw new Error("usage/read purpose is invalid");
		if (typeof payload.purpose === "string")
			(filter as { purpose: V2UsageFilter["purpose"] }).purpose = payload.purpose as V2UsageFilter["purpose"];
		await this.sendResponse(state, id, {
			command: command.command,
			aggregate: await this.usage.aggregate(filter),
			entries: await this.usage.read(filter),
		});
	}

	private async diagnosticEvents(afterSeq = 0): Promise<Awaited<ReturnType<ForensicRecorder["read"]>>> {
		return this.diagnostics.read(afterSeq);
	}

	private async detach(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		if (!command.sessionId) throw new Error("session/detach requires sessionId");
		const runtime = state.sessions.get(command.sessionId);
		state.sessions.delete(command.sessionId);
		this.releaseControlFor(state, command.sessionId);
		if (runtime && !this.hasRuntimeReference(runtime)) await this.disposeRuntime(runtime);
		await this.sendResponse(state, id, { command: command.command, sessionId: command.sessionId });
	}

	private async startTurn(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		if (!command.sessionId) throw new Error("turn/start requires sessionId");
		this.requireControl(state, command.sessionId);
		const runtime = state.sessions.get(command.sessionId);
		if (!runtime) throw new Error(`Session ${command.sessionId} is not attached`);
		const resolvedCommand = await this.resolveTurnContent(command);
		const operationId = randomUUID();
		const capsule = this.diagnosticContent
			? await this.diagnosticContent.encrypt({
					eventId: operationId,
					kind: command.command,
					content: JSON.stringify(resolvedCommand.payload ?? {}),
				})
			: undefined;
		if (capsule !== undefined) {
			await this.diagnosticContent?.save?.(capsule);
			this.diagnosticCapsules.set(capsule.eventId, capsule);
		}
		const accepted = await runtime.accept(operationId);
		this.operations.set(operationId, {
			operationId,
			sessionId: command.sessionId,
			state: "accepted",
			accepted,
		});
		await this.operationStore.putOperation(this.operations.get(operationId)!);
		await this.send(state, { type: "response", id, ok: true, accepted });
		await this.broadcastEvent(
			command.sessionId,
			runtime,
			{ state: "accepted", accepted },
			operationId,
			"operation_accepted",
			{ eventSeq: accepted.eventSeq, revision: accepted.sessionRevision },
		);
		await this.diagnostics?.record({
			kind: "operation_accepted",
			severity: "info",
			outcome: "started",
			traceId: operationId,
			spanId: id,
			sessionId: command.sessionId,
			operationId,
			payload: {
				command: command.command,
				...(capsule === undefined
					? {}
					: {
							contentRef: {
								eventId: capsule.eventId,
								kind: capsule.kind,
								keyId: capsule.keyId,
								plaintextSha256: capsule.plaintextSha256,
								byteLength: capsule.byteLength,
								originalByteLength: capsule.originalByteLength,
								truncated: capsule.truncated,
							},
						}),
			},
		});
		void this.runOperation(runtime, command.sessionId, operationId, resolvedCommand);
	}

	private async diagnosticCapsulesForExport(): Promise<readonly DiagnosticCapsule[]> {
		const persisted = await this.diagnosticContent?.list?.();
		return persisted === undefined ? [...this.diagnosticCapsules.values()] : persisted;
	}

	private async diagnosticCapsulesForDecryption(capsules: readonly DiagnosticCapsule[]): Promise<readonly object[]> {
		if (this.diagnosticContent?.decrypt === undefined)
			throw new Error("diagnostics/export --decrypt-content is unavailable for this diagnostic store");
		return Promise.all(
			capsules.map(async (capsule) => ({
				eventId: capsule.eventId,
				kind: capsule.kind,
				content: Buffer.from(await this.diagnosticContent!.decrypt!(capsule)).toString("base64"),
				byteLength: capsule.byteLength,
			})),
		);
	}

	private async resolveTurnContent(command: CommandV2): Promise<CommandV2> {
		const payload = objectPayload(command);
		if (!Array.isArray(payload.content)) return command;
		const content = await Promise.all(
			payload.content.map(async (part, index) => {
				if (typeof part !== "object" || part === null || Array.isArray(part))
					throw new Error(`turn content item ${index} must be an object`);
				const item = part as Record<string, unknown>;
				if (item.type === "text" && typeof item.text === "string") return { type: "text", text: item.text };
				if (item.type === "mention") return this.resolveMention(item, index);
				if (item.type !== "image" && item.type !== "blob")
					throw new Error(`turn content item ${index} must be text, image, or blob`);
				if (typeof item.mimeType !== "string" || !item.mimeType.startsWith("image/"))
					throw new Error(`turn content item ${index} requires an image MIME type`);
				if (typeof item.data === "string") return { type: "image", data: item.data, mimeType: item.mimeType };
				if (typeof item.digest !== "string") throw new Error(`turn content item ${index} requires a blob digest`);
				const data = await this.blobs.read(item.digest);
				return { type: "image", data: Buffer.from(data).toString("base64"), mimeType: item.mimeType };
			}),
		);
		return { ...command, payload: toProtocolJsonValue({ ...payload, content }) };
	}

	private async resolveMention(item: Record<string, unknown>, index: number): Promise<{ type: "text"; text: string }> {
		if (typeof item.name !== "string" || typeof item.path !== "string")
			throw new Error(`turn content item ${index} mention requires name and path`);
		const name = item.name.trim();
		const path = item.path.trim();
		if (name.length === 0 || path.length === 0) throw new Error(`turn content item ${index} mention is empty`);
		if (path.startsWith("app://")) {
			const appId = path.slice("app://".length);
			const app =
				(await this.apps.read(appId)) ??
				(await this.plugins.listPlugins(true))
					.filter((plugin) => plugin.enabled)
					.flatMap((plugin) => plugin.appDescriptors ?? [])
					.find((candidate) => candidate.id === appId);
			if (!app?.enabled) throw new Error(`Unknown or disabled app mention: ${path}`);
		} else if (path.startsWith("plugin://")) {
			const plugin = await this.plugins.readPlugin(path.slice("plugin://".length));
			if (!plugin?.enabled) throw new Error(`Unknown or disabled plugin mention: ${path}`);
		} else {
			throw new Error(`Unsupported mention path: ${path}`);
		}
		return { type: "text", text: `@${name}` };
	}

	private async runOperation(
		runtime: PiSessionRuntimeV2,
		sessionId: string,
		operationId: string,
		command: CommandV2,
	): Promise<void> {
		try {
			await runtime.run(operationId, command);
			const record = this.operations.get(operationId);
			if (record) {
				const updated = { ...record, state: "complete" as const };
				this.operations.set(operationId, updated);
				await this.operationStore.putOperation(updated);
			}
			await this.broadcastEvent(
				sessionId,
				runtime,
				{ state: "complete", snapshot: toProtocolJsonValue(await runtime.snapshot()) },
				operationId,
				"operation_terminal",
			);
			const completed = this.operations.get(operationId);
			if (completed) {
				const updated = { ...completed, terminalSeq: (await runtime.snapshot()).eventSeq };
				this.operations.set(operationId, updated);
				await this.operationStore.putOperation(updated);
			}
			await this.diagnostics?.record({
				kind: "operation_terminal",
				severity: "info",
				outcome: "ok",
				traceId: operationId,
				spanId: operationId,
				sessionId,
				operationId,
				payload: { state: "complete" },
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const failureSnapshot = await runtime.snapshot();
			const record = this.operations.get(operationId);
			if (record) {
				const updated = { ...record, state: "failed" as const, error: message };
				this.operations.set(operationId, updated);
				await this.operationStore.putOperation(updated);
			}
			await this.broadcastEvent(
				sessionId,
				runtime,
				{ state: "failed", error: message, snapshot: toProtocolJsonValue(failureSnapshot) },
				operationId,
				"operation_terminal",
			);
			const failed = this.operations.get(operationId);
			if (failed) {
				const updated = { ...failed, terminalSeq: failureSnapshot.eventSeq };
				this.operations.set(failed.operationId, updated);
				await this.operationStore.putOperation(updated);
			}
			await this.diagnostics?.record({
				kind: "operation_terminal",
				severity: "error",
				outcome: "error",
				traceId: operationId,
				spanId: operationId,
				sessionId,
				operationId,
				payload: { state: "failed", error: message },
			});
		}
	}

	private async readOperation(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		if (!command.operationId) throw new Error("operation/read requires operationId");
		const operation = this.operations.get(command.operationId);
		if (!operation) throw new Error(`Unknown operation ${command.operationId}`);
		await this.sendResponse(state, id, { command: command.command, operation });
	}

	private async broadcastEvent(
		sessionId: string,
		runtime: PiSessionRuntimeV2,
		payload: Record<string, unknown>,
		operationId: string | undefined,
		eventName: EventEnvelopeV2["event"],
		sequence?: { eventSeq: number; revision: number },
	): Promise<void> {
		const snapshot = await runtime.snapshot();
		const history = this.eventHistory.get(sessionId) ?? [];
		const lastEvent = history.at(-1);
		const event: ServerMessageV2 = {
			type: "event",
			sessionId,
			seq: sequence?.eventSeq ?? Math.max(snapshot.eventSeq, lastEvent?.seq ?? 0) + 1,
			revision: sequence?.revision ?? Math.max(snapshot.revision, lastEvent?.revision ?? 0) + 1,
			...(operationId === undefined ? {} : { operationId }),
			event: eventName,
			payload: toProtocolJsonValue(payload),
		};
		history.push(event);
		if (history.length > 256) history.splice(0, history.length - 256);
		this.eventHistory.set(sessionId, history);
		await this.operationStore.appendEvent(event);
		await Promise.all(
			Array.from(this.connections)
				.filter((connection) => connection.sessions.get(sessionId) === runtime)
				.map((connection) => this.send(connection, event)),
		);
	}

	private sendResponse(state: V2ConnectionState, id: string, result: Record<string, unknown>): Promise<void> {
		return this.send(state, { type: "response", id, ok: true, result: toProtocolJsonValue(result) });
	}

	private async sendError(state: V2ConnectionState, id: string, code: string, message: string): Promise<void> {
		if (state.closed) return;
		try {
			await this.send(state, { type: "response", id, ok: false, error: { code, message } });
		} catch {
			// The request may finish after the client has disconnected; no response can be delivered.
			this.disconnect(state);
		}
	}

	private send(state: V2ConnectionState, message: ServerMessageV2): Promise<void> {
		return state.connection.send(encodeServerMessageV2(message));
	}

	private async failProtocol(state: V2ConnectionState, code: string, message: string): Promise<void> {
		if (state.closed) return;
		await state.connection.close(encodeServerMessageV2({ type: "hello_error", error: { code, message } }));
		this.disconnect(state);
	}

	private async closeConnection(state: V2ConnectionState): Promise<void> {
		if (state.closed) return;
		state.closed = true;
		clearTimeout(state.handshakeTimeout);
		for (const sessionId of state.controlSessions) this.releaseControlFor(state, sessionId);
		await Promise.allSettled(Array.from(state.sessions.values(), (runtime) => this.disposeRuntime(runtime)));
		await state.connection.close();
		this.connections.delete(state);
	}

	private disconnect(state: V2ConnectionState): void {
		if (state.closed) return;
		state.closed = true;
		clearTimeout(state.handshakeTimeout);
		for (const sessionId of state.controlSessions) this.releaseControlFor(state, sessionId);
		this.connections.delete(state);
	}

	private claimControl(state: V2ConnectionState, sessionId: string): void {
		const owner = this.controls.get(sessionId);
		if (owner !== undefined && owner !== state.id)
			throw new Error(`Session ${sessionId} already has a control lease`);
		this.controls.set(sessionId, state.id);
		state.controlSessions.add(sessionId);
	}

	private requireControl(state: V2ConnectionState, sessionId: string): void {
		if (this.controls.get(sessionId) === state.id) return;
		if (this.controls.get(sessionId) === undefined && !state.sessions.has(sessionId)) {
			this.claimControl(state, sessionId);
			return;
		}
		throw new Error(`Session ${sessionId} requires a control lease`);
	}

	private releaseControlFor(state: V2ConnectionState, sessionId: string): void {
		if (this.controls.get(sessionId) === state.id) this.controls.delete(sessionId);
		state.controlSessions.delete(sessionId);
	}

	private hasRuntimeReference(runtime: PiSessionRuntimeV2): boolean {
		return Array.from(this.connections).some((connection) =>
			Array.from(connection.sessions.values()).some((candidate) => candidate === runtime),
		);
	}

	private trackRuntime(runtime: PiSessionRuntimeV2): void {
		this.runtimes.add(runtime);
	}

	private async disposeRuntime(runtime: PiSessionRuntimeV2): Promise<void> {
		if (this.disposedRuntimes.has(runtime)) return;
		this.disposedRuntimes.add(runtime);
		await runtime.dispose();
	}

	private reportError(error: Error): void {
		this.onError?.(error);
	}
}

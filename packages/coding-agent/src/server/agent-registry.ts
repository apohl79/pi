import { randomUUID } from "node:crypto";
import type { AgentSummary } from "@earendil-works/pi-protocol";
import type { V2AgentRegistry, V2AgentRequest, V2AgentSnapshot } from "@earendil-works/pi-server";
import type { CodingAgentV2Runtime, CodingAgentV2Service } from "./v2-service.ts";

const MAX_AGENT_INBOX_MESSAGES = 32;
const MAX_AGENT_INBOX_CHARACTERS = 16_000;
const AGENT_REGISTRY_STATE = "agent_registry_state";
const AGENT_COMPLETION = "agent_completion";

interface PersistedAgentState {
	readonly version: 1;
	readonly state?: AgentSummary["state"];
	readonly inbox: readonly string[];
	readonly followUps: readonly string[];
}

function isPersistedAgentState(value: unknown): value is PersistedAgentState {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const state = value as Record<string, unknown>;
	if (state.version !== 1 || !Array.isArray(state.inbox) || !Array.isArray(state.followUps)) return false;
	if (
		state.state !== undefined &&
		!(["idle", "running", "awaitingInput", "complete", "failed", "interrupted"] as const).includes(
			state.state as AgentSummary["state"],
		)
	)
		return false;
	if (![...state.inbox, ...state.followUps].every((item) => typeof item === "string" && item.length > 0)) return false;
	const characters = [...state.inbox, ...state.followUps].reduce((total, item) => total + item.length, 0);
	return (
		state.inbox.length <= MAX_AGENT_INBOX_MESSAGES &&
		state.followUps.length <= MAX_AGENT_INBOX_MESSAGES &&
		characters <= MAX_AGENT_INBOX_CHARACTERS
	);
}

interface ChildAgent {
	readonly summary: AgentSummary;
	readonly parentSessionId: string;
	readonly childSessionId: string;
	readonly runtime: CodingAgentV2Runtime;
	state: AgentSummary["state"];
	inbox: string[];
	followUps: string[];
	waiters: Array<() => void>;
	persistence: Promise<void>;
}

export interface CodingAgentV2AgentRegistryOptions {
	readonly maxDepth?: number;
	readonly maxActive?: number;
	readonly maxActivePerParent?: number;
}

/** Executes server-owned child agents through the durable coding-agent service. */
export class CodingAgentV2AgentRegistry implements V2AgentRegistry {
	private readonly maxDepth: number;
	private readonly maxActive: number;
	private readonly maxActivePerParent: number;
	private readonly agents = new Map<string, ChildAgent>();
	private readonly service: CodingAgentV2Service;
	private disposed = false;
	private readonly hydratedParents = new Set<string>();

	constructor(service: CodingAgentV2Service, options: CodingAgentV2AgentRegistryOptions = {}) {
		this.service = service;
		this.maxDepth = options.maxDepth ?? 1;
		this.maxActive = options.maxActive ?? 8;
		this.maxActivePerParent = options.maxActivePerParent ?? 4;
		if (!Number.isInteger(this.maxDepth) || this.maxDepth < 1) throw new Error("maxDepth must be a positive integer");
		if (!Number.isInteger(this.maxActive) || this.maxActive < 1 || this.maxActive > 8)
			throw new Error("maxActive must be an integer from 1 to 8");
		if (!Number.isInteger(this.maxActivePerParent) || this.maxActivePerParent < 1 || this.maxActivePerParent > 8)
			throw new Error("maxActivePerParent must be an integer from 1 to 8");
	}

	async spawn(request: V2AgentRequest): Promise<AgentSummary> {
		if (this.disposed) throw new Error("Coding-agent child registry is disposed");
		this.validateRequest(request);
		await this.hydrate(request.sessionId);
		if (this.activeCount() >= this.maxActive) throw new Error(`Agent active limit ${this.maxActive} exceeded`);
		if (this.activeCountForParent(request.sessionId) >= this.maxActivePerParent)
			throw new Error(`Agent active limit ${this.maxActivePerParent} exceeded for parent ${request.sessionId}`);
		if (!this.service.createSession) throw new Error("Coding-agent service does not support child sessions");
		const model = await this.resolveModel(request);
		const forkedContext = await this.readForkedContext(request);
		const path = `${request.parentPath.replace(/\/$/, "")}/${request.taskName}`;
		if ([...this.agents.values()].some((agent) => agent.summary.path === path))
			throw new Error(`Agent path ${path} already exists`);
		const agentId = randomUUID();
		const created = await this.service.createSession({
			parentSessionId: request.sessionId,
			name: request.taskName,
			model,
			id: agentId,
		});
		const summary: AgentSummary = {
			id: agentId,
			path,
			taskName: request.taskName,
			state: "running",
			model,
		};
		const agent: ChildAgent = {
			summary,
			parentSessionId: request.sessionId,
			childSessionId: created.sessionId,
			runtime: created.runtime,
			state: "running",
			inbox: [],
			followUps: [],
			waiters: [],
			persistence: Promise.resolve(),
		};
		this.agents.set(summary.id, agent);
		await this.persist(agent);
		void this.run(agent, "turn/start", [forkedContext, request.taskMessage].filter(Boolean).join("\n\n"));
		return this.snapshot(agent);
	}

	async list(sessionId: string): Promise<readonly AgentSummary[]> {
		await this.hydrate(sessionId);
		return [...this.agents.values()]
			.filter((agent) => agent.parentSessionId === sessionId)
			.map((agent) => this.snapshot(agent));
	}

	async getSnapshot(agentId: string): Promise<V2AgentSnapshot> {
		await this.ensureAgent(agentId);
		const agent = this.get(agentId);
		return { ...this.snapshot(agent), sessionId: agent.parentSessionId };
	}

	async wait(agentId: string, timeoutMs?: number): Promise<AgentSummary> {
		if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 0))
			throw new Error("timeoutMs must be non-negative");
		await this.ensureAgent(agentId);
		const agent = this.get(agentId);
		if (agent.state === "running" || agent.state === "awaitingInput") {
			await new Promise<void>((resolve) => {
				agent.waiters.push(resolve);
				if (timeoutMs !== undefined) setTimeout(resolve, timeoutMs);
			});
		}
		return this.snapshot(agent);
	}

	async message(agentId: string, message: string): Promise<void> {
		if (message.trim().length === 0) throw new Error("Agent message must not be empty");
		await this.ensureAgent(agentId);
		const agent = this.get(agentId);
		const characters = agent.inbox.reduce((total, item) => total + item.length, 0);
		if (agent.inbox.length >= MAX_AGENT_INBOX_MESSAGES || characters + message.length > MAX_AGENT_INBOX_CHARACTERS)
			throw new Error("Agent message inbox limit exceeded");
		agent.inbox.push(message);
		await this.persist(agent);
	}

	async followUp(agentId: string, message: string): Promise<AgentSummary> {
		if (message.trim().length === 0) throw new Error("Agent message must not be empty");
		await this.ensureAgent(agentId);
		const agent = this.get(agentId);
		if (agent.state === "complete" || agent.state === "interrupted" || agent.state === "failed") {
			agent.state = "running";
			await this.persist(agent);
			void this.run(agent, "turn/start", message);
		} else {
			const characters = agent.followUps.reduce((total, item) => total + item.length, 0);
			if (
				agent.followUps.length >= MAX_AGENT_INBOX_MESSAGES ||
				characters + message.length > MAX_AGENT_INBOX_CHARACTERS
			)
				throw new Error("Agent follow-up queue limit exceeded");
			agent.followUps.push(message);
			await this.persist(agent);
		}
		return this.snapshot(agent);
	}

	async interrupt(agentId: string): Promise<AgentSummary> {
		await this.ensureAgent(agentId);
		const agent = this.get(agentId);
		if (agent.state === "running" || agent.state === "awaitingInput") {
			try {
				const operationId = randomUUID();
				await agent.runtime.accept(operationId);
				await agent.runtime.run(operationId, {
					command: "turn/abort",
					sessionId: agent.childSessionId,
					payload: {},
				});
			} finally {
				agent.state = "interrupted";
				await this.persist(agent);
				await this.queueCompletion(agent);
				this.resolveWaiters(agent);
			}
		}
		return this.snapshot(agent);
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		const agents = [...this.agents.values()];
		this.agents.clear();
		await Promise.all(
			agents.map(async (agent) => {
				if (agent.state !== "running" && agent.state !== "awaitingInput") return;
				agent.state = "interrupted";
				await this.persist(agent);
				await this.queueCompletion(agent);
			}),
		);
		await Promise.allSettled(agents.map((agent) => agent.runtime.dispose()));
		for (const agent of agents) this.resolveWaiters(agent);
	}

	private async run(agent: ChildAgent, command: "turn/start", text: string): Promise<void> {
		try {
			const inbox = agent.inbox.slice();
			const prompt = [...inbox, text].join("\n\n");
			const operationId = randomUUID();
			await agent.runtime.accept(operationId);
			await agent.runtime.run(operationId, {
				command,
				sessionId: agent.childSessionId,
				payload: { text: prompt },
			});
			if (inbox.length > 0) agent.inbox.splice(0, inbox.length);
			agent.state = "complete";
			const next = agent.followUps.shift();
			await this.persist(agent);
			if (next !== undefined) {
				agent.state = "running";
				await this.persist(agent);
				void this.run(agent, "turn/start", next);
			} else await this.queueCompletion(agent);
		} catch {
			agent.state = "failed";
			await this.persist(agent);
			await this.queueCompletion(agent);
		} finally {
			if (agent.state !== "running") this.resolveWaiters(agent);
		}
	}

	private async queueCompletion(agent: ChildAgent): Promise<void> {
		const parent = await this.service.openSession(agent.parentSessionId);
		if (!parent.appendCustomEntry) return;
		await parent.appendCustomEntry(AGENT_COMPLETION, {
			version: 1,
			agentId: agent.summary.id,
			path: agent.summary.path,
			taskName: agent.summary.taskName,
			state: agent.state,
			model: agent.summary.model,
		});
	}

	private validateRequest(request: V2AgentRequest): void {
		if (
			request.forkTurns !== undefined &&
			request.forkTurns !== "none" &&
			request.forkTurns !== "all" &&
			(!Number.isInteger(request.forkTurns) || request.forkTurns < 1 || request.forkTurns > 32)
		)
			throw new Error("forkTurns must be none, all, or an integer from 1 to 32");
		const depth = request.parentPath.split("/").filter(Boolean).length - 1;
		if (depth >= this.maxDepth) throw new Error(`Agent maximum depth ${this.maxDepth} exceeded`);
		if (!/^[A-Za-z0-9._-]+$/.test(request.taskName))
			throw new Error("Agent taskName contains unsupported characters");
		if (request.taskMessage.trim().length === 0) throw new Error("Agent taskMessage must not be empty");
	}

	private async resolveModel(request: V2AgentRequest): Promise<{ provider: string; id: string }> {
		if (request.model.provider !== "inherit" && request.model.id !== "inherit") return request.model;
		const parent = await this.service.openSession(request.sessionId);
		const inherited = (await parent.snapshot()).model;
		return {
			provider: request.model.provider === "inherit" ? inherited.provider : request.model.provider,
			id: request.model.id === "inherit" ? inherited.id : request.model.id,
		};
	}

	private async readForkedContext(request: V2AgentRequest): Promise<string | undefined> {
		if (request.forkTurns === undefined || request.forkTurns === "none") return undefined;
		const snapshot = await (await this.service.openSession(request.sessionId)).snapshot();
		const transcript = snapshot.transcript;
		const userIndexes = transcript.flatMap((item, index) => (item.role === "user" ? [index] : []));
		const start =
			request.forkTurns === "all"
				? 0
				: (userIndexes[Math.max(0, userIndexes.length - request.forkTurns)] ?? transcript.length);
		const selected = transcript.slice(start);
		if (selected.length === 0) return undefined;
		const serialized = selected.map((item) => `${item.role}: ${JSON.stringify(item.content)}`).join("\n");
		const bounded = serialized.slice(0, 32_000);
		return `[forked context]\n${bounded}`;
	}

	private activeCount(): number {
		return [...this.agents.values()].filter((agent) => agent.state === "running").length;
	}

	private activeCountForParent(sessionId: string): number {
		return [...this.agents.values()].filter(
			(agent) => agent.parentSessionId === sessionId && agent.state === "running",
		).length;
	}

	private async ensureAgent(agentId: string): Promise<void> {
		if (this.agents.has(agentId)) return;
		const sessions = await this.service.listSessions();
		for (const metadata of sessions) {
			if (metadata.parentSessionId === undefined) continue;
			await this.hydrate(metadata.parentSessionId);
			if (this.agents.has(agentId)) return;
		}
	}

	private async hydrate(parentSessionId: string): Promise<void> {
		if (this.hydratedParents.has(parentSessionId)) return;
		this.hydratedParents.add(parentSessionId);
		const sessions = await this.service.listSessions();
		for (const metadata of sessions) {
			if (metadata.parentSessionId !== parentSessionId || this.agents.has(metadata.id)) continue;
			const runtime = await this.service.openSession(metadata.id);
			const snapshot = await runtime.snapshot();
			const persisted = await this.readState(runtime);
			const taskName = metadata.sessionName ?? metadata.id;
			const parentPath = this.agents.get(metadata.parentSessionId)?.summary.path ?? "/root";
			const summary: AgentSummary = {
				id: metadata.id,
				path: `${parentPath}/${taskName}`,
				taskName,
				state: persisted?.state ?? (snapshot.phase === "idle" ? "complete" : "running"),
				model: snapshot.model,
			};
			this.agents.set(metadata.id, {
				summary,
				parentSessionId,
				childSessionId: metadata.id,
				runtime,
				state: summary.state,
				inbox: persisted?.inbox.slice() ?? [],
				followUps: persisted?.followUps.slice() ?? [],
				waiters: [],
				persistence: Promise.resolve(),
			});
		}
	}

	private async persist(agent: ChildAgent): Promise<void> {
		const append = agent.runtime.appendCustomEntry;
		if (!append) return;
		const state: PersistedAgentState = {
			version: 1,
			state: agent.state,
			inbox: agent.inbox.slice(),
			followUps: agent.followUps.slice(),
		};
		agent.persistence = agent.persistence.then(() =>
			append.call(agent.runtime, AGENT_REGISTRY_STATE, state).then(() => undefined),
		);
		await agent.persistence;
	}

	private async readState(runtime: CodingAgentV2Runtime): Promise<PersistedAgentState | undefined> {
		if (!runtime.readCustomEntries) return undefined;
		const entries = await runtime.readCustomEntries(AGENT_REGISTRY_STATE);
		for (const entry of entries) {
			if (entry.type !== "custom" || !isPersistedAgentState(entry.data)) continue;
			return entry.data;
		}
		return undefined;
	}

	private resolveWaiters(agent: ChildAgent): void {
		const waiters = agent.waiters.splice(0);
		for (const resolve of waiters) resolve();
	}

	private snapshot(agent: ChildAgent): AgentSummary {
		return structuredClone({ ...agent.summary, state: agent.state });
	}

	private get(agentId: string): ChildAgent {
		const agent = this.agents.get(agentId);
		if (!agent) throw new Error(`Unknown agent ${agentId}`);
		return agent;
	}
}

export function createCodingAgentV2AgentRegistry(
	service: CodingAgentV2Service,
	options?: CodingAgentV2AgentRegistryOptions,
): CodingAgentV2AgentRegistry {
	return new CodingAgentV2AgentRegistry(service, options);
}

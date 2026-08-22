import { randomUUID } from "node:crypto";

export interface AgentSummary {
	readonly id: string;
	readonly path: string;
	readonly taskName: string;
	readonly state: "running" | "awaitingInput" | "complete" | "interrupted";
	readonly model: { readonly provider: string; readonly id: string };
	readonly role?: string;
}

export interface V2AgentRequest {
	readonly sessionId: string;
	readonly parentPath: string;
	readonly taskName: string;
	readonly taskMessage: string;
	readonly role?: string;
	readonly model: { readonly provider: string; readonly id: string };
}

export interface V2AgentSnapshot extends AgentSummary {
	readonly sessionId: string;
}

export interface V2AgentRegistry {
	spawn(request: V2AgentRequest): Promise<AgentSummary>;
	list(sessionId: string): Promise<readonly AgentSummary[]>;
	getSnapshot(agentId: string): Promise<V2AgentSnapshot>;
	wait(agentId: string, timeoutMs?: number): Promise<AgentSummary>;
	message(agentId: string, message: string): Promise<void>;
	followUp(agentId: string, message: string): Promise<AgentSummary>;
	interrupt(agentId: string): Promise<AgentSummary>;
	complete(agentId: string): Promise<AgentSummary>;
}

interface AgentState {
	readonly summary: AgentSummary;
	readonly sessionId: string;
	readonly parentPath: string;
	state: AgentSummary["state"];
	messages: string[];
}

const DEFAULT_MAX_MESSAGE_LENGTH = 64 * 1024;
const DEFAULT_MAX_MESSAGES = 1024;
const DEFAULT_MAX_TOTAL_AGENTS = 1024;

const validateLimit = (name: string, value: number, minimum: number): number => {
	if (!Number.isFinite(value) || !Number.isInteger(value) || value < minimum)
		throw new Error(`${name} must be a finite integer greater than or equal to ${minimum}`);
	return value;
};

export class InMemoryV2AgentRegistry implements V2AgentRegistry {
	private readonly maxDepth: number;
	private readonly maxActive: number;
	private readonly maxMessageLength: number;
	private readonly maxMessages: number;
	private readonly maxTotalAgents: number;
	private readonly agents = new Map<string, AgentState>();
	private readonly waiters = new Map<string, Set<() => void>>();

	constructor(
		options: {
			maxDepth?: number;
			maxActive?: number;
			maxMessageLength?: number;
			maxMessages?: number;
			maxTotalAgents?: number;
		} = {},
	) {
		this.maxDepth = options.maxDepth === undefined ? 1 : validateLimit("maxDepth", options.maxDepth, 0);
		this.maxActive = options.maxActive === undefined ? 8 : validateLimit("maxActive", options.maxActive, 0);
		this.maxMessageLength =
			options.maxMessageLength === undefined
				? DEFAULT_MAX_MESSAGE_LENGTH
				: validateLimit("maxMessageLength", options.maxMessageLength, 1);
		this.maxMessages =
			options.maxMessages === undefined
				? DEFAULT_MAX_MESSAGES
				: validateLimit("maxMessages", options.maxMessages, 1);
		this.maxTotalAgents =
			options.maxTotalAgents === undefined
				? DEFAULT_MAX_TOTAL_AGENTS
				: validateLimit("maxTotalAgents", options.maxTotalAgents, 1);
	}

	async spawn(request: V2AgentRequest): Promise<AgentSummary> {
		const depth = request.parentPath.split("/").filter(Boolean).length - 1;
		if (depth >= this.maxDepth) throw new Error(`Agent maximum depth ${this.maxDepth} exceeded`);
		if (this.activeCount() >= this.maxActive) throw new Error(`Agent active limit ${this.maxActive} exceeded`);
		if (!/^[A-Za-z0-9._-]+$/.test(request.taskName))
			throw new Error("Agent taskName contains unsupported characters");
		this.validateMessage(request.taskMessage);
		const path = `${request.parentPath.replace(/\/$/, "")}/${request.taskName}`;
		if (
			[...this.agents.values()].some((agent) => agent.sessionId === request.sessionId && agent.summary.path === path)
		)
			throw new Error(`Agent path ${path} already exists`);
		this.cleanupTerminalAgents();
		if (this.agents.size >= this.maxTotalAgents)
			throw new Error(`Agent total limit ${this.maxTotalAgents} exceeded`);
		const summary: AgentSummary = {
			id: randomUUID(),
			path,
			taskName: request.taskName,
			state: "running",
			model: structuredClone(request.model),
			...(request.role === undefined ? {} : { role: request.role }),
		};
		this.agents.set(summary.id, {
			summary,
			sessionId: request.sessionId,
			parentPath: request.parentPath,
			state: summary.state,
			messages: [request.taskMessage],
		});
		return this.snapshot(this.get(summary.id));
	}

	async list(sessionId: string): Promise<readonly AgentSummary[]> {
		return [...this.agents.values()]
			.filter((agent) => agent.sessionId === sessionId)
			.map((agent) => this.snapshot(agent));
	}

	getSnapshot(agentId: string): Promise<V2AgentSnapshot> {
		const agent = this.get(agentId);
		return Promise.resolve(structuredClone({ ...this.snapshot(agent), sessionId: agent.sessionId }));
	}

	async wait(agentId: string, timeoutMs?: number): Promise<AgentSummary> {
		if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 0))
			throw new Error("timeoutMs must be non-negative");
		const agent = this.get(agentId);
		if (agent.state === "complete" || agent.state === "interrupted" || timeoutMs === 0) return this.snapshot(agent);
		await new Promise<void>((resolve) => {
			const callbacks = this.waiters.get(agentId) ?? new Set<() => void>();
			let timer: ReturnType<typeof setTimeout> | undefined;
			const finish = (): void => {
				if (timer !== undefined) clearTimeout(timer);
				callbacks.delete(finish);
				if (callbacks.size === 0) this.waiters.delete(agentId);
				resolve();
			};
			callbacks.add(finish);
			this.waiters.set(agentId, callbacks);
			timer = timeoutMs === undefined ? undefined : setTimeout(finish, timeoutMs);
		});
		return this.snapshot(agent);
	}

	async message(agentId: string, message: string): Promise<void> {
		const agent = this.get(agentId);
		if (agent.state === "complete" || agent.state === "interrupted")
			throw new Error(`Cannot message terminal agent ${agentId}`);
		this.appendMessage(agent, message);
	}

	async followUp(agentId: string, message: string): Promise<AgentSummary> {
		const agent = this.get(agentId);
		if (
			(agent.state === "complete" || agent.state === "interrupted" || agent.state === "awaitingInput") &&
			this.activeCount() >= this.maxActive
		)
			throw new Error(`Agent active limit ${this.maxActive} exceeded`);
		this.appendMessage(agent, message);
		if (agent.state === "complete" || agent.state === "interrupted" || agent.state === "awaitingInput")
			this.setState(agent, "running");
		return this.snapshot(agent);
	}

	async interrupt(agentId: string): Promise<AgentSummary> {
		const agent = this.get(agentId);
		if (agent.state === "running" || agent.state === "awaitingInput") this.setState(agent, "interrupted");
		return this.snapshot(agent);
	}

	async complete(agentId: string): Promise<AgentSummary> {
		const agent = this.get(agentId);
		this.setState(agent, "complete");
		return this.snapshot(agent);
	}

	private activeCount(): number {
		return [...this.agents.values()].filter((agent) => agent.state === "running").length;
	}

	private appendMessage(agent: AgentState, message: string): void {
		this.validateMessage(message);
		if (agent.messages.length >= this.maxMessages) agent.messages.shift();
		agent.messages.push(message);
	}

	private cleanupTerminalAgents(): void {
		while (this.agents.size >= this.maxTotalAgents) {
			const terminalId = [...this.agents].find(
				([, agent]) => agent.state === "complete" || agent.state === "interrupted",
			)?.[0];
			if (terminalId === undefined) return;
			this.agents.delete(terminalId);
			this.waiters.delete(terminalId);
		}
	}

	private snapshot(agent: AgentState): AgentSummary {
		return structuredClone({ ...agent.summary, state: agent.state });
	}

	private validateMessage(message: string): void {
		if (message.trim().length === 0) throw new Error("Agent message must not be empty");
		if (message.length > this.maxMessageLength)
			throw new Error(`Agent message exceeds maximum length ${this.maxMessageLength}`);
	}

	private setState(agent: AgentState, state: AgentSummary["state"]): void {
		agent.state = state;
		if (state === "complete" || state === "interrupted") {
			for (const resolve of this.waiters.get(agent.summary.id) ?? []) resolve();
		}
	}

	private get(agentId: string): AgentState {
		const agent = this.agents.get(agentId);
		if (!agent) throw new Error(`Unknown agent ${agentId}`);
		return agent;
	}
}

import { randomUUID } from "node:crypto";
import type { AgentSummary } from "@earendil-works/pi-protocol";
import type { V2AgentRegistry, V2AgentRequest, V2AgentSnapshot } from "@earendil-works/pi-server";
import type { CodingAgentV2Runtime, CodingAgentV2Service } from "./v2-service.ts";

interface ChildAgent {
	readonly summary: AgentSummary;
	readonly parentSessionId: string;
	readonly childSessionId: string;
	readonly runtime: CodingAgentV2Runtime;
	state: AgentSummary["state"];
	messages: string[];
	followUps: string[];
	waiters: Array<() => void>;
	activeOperationId?: string;
	activeOperationAccepted: boolean;
	abortRequested: boolean;
}

export interface CodingAgentV2AgentRegistryOptions {
	readonly maxDepth?: number;
	readonly maxActive?: number;
	readonly maxMessageLength?: number;
	readonly maxMessages?: number;
}

const DEFAULT_MAX_MESSAGE_LENGTH = 64 * 1024;
const DEFAULT_MAX_MESSAGES = 1024;

function validatePositiveLimit(name: string, value: number): number {
	if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`);
	return value;
}

/** Executes server-owned child agents through the durable coding-agent service. */
export class CodingAgentV2AgentRegistry implements V2AgentRegistry {
	private readonly maxDepth: number;
	private readonly maxActive: number;
	private readonly maxMessageLength: number;
	private readonly maxMessages: number;
	private readonly agents = new Map<string, ChildAgent>();
	private readonly service: CodingAgentV2Service;
	private spawnTail: Promise<void> = Promise.resolve();
	private disposePromise?: Promise<void>;

	constructor(service: CodingAgentV2Service, options: CodingAgentV2AgentRegistryOptions = {}) {
		this.service = service;
		this.maxDepth = options.maxDepth ?? 1;
		this.maxActive = options.maxActive ?? 8;
		this.maxMessageLength = validatePositiveLimit("maxMessageLength", options.maxMessageLength ?? DEFAULT_MAX_MESSAGE_LENGTH);
		this.maxMessages = validatePositiveLimit("maxMessages", options.maxMessages ?? DEFAULT_MAX_MESSAGES);
	}

	async spawn(request: V2AgentRequest): Promise<AgentSummary> {
		if (this.disposePromise) throw new Error("Agent registry is disposed");
		const previous = this.spawnTail;
		let release!: () => void;
		this.spawnTail = new Promise<void>((resolve) => (release = resolve));
		try {
			await previous;
			return await this.spawnUnlocked(request);
		} finally {
			release();
		}
	}

	private async spawnUnlocked(request: V2AgentRequest): Promise<AgentSummary> {
		this.validateRequest(request);
		if (this.activeCount() >= this.maxActive) throw new Error(`Agent active limit ${this.maxActive} exceeded`);
		if (!this.service.createSession) throw new Error("Coding-agent service does not support child sessions");
		const model = await this.resolveModel(request);
		const path = `${request.parentPath.replace(/\/$/, "")}/${request.taskName}`;
		if ([...this.agents.values()].some((agent) => agent.summary.path === path))
			throw new Error(`Agent path ${path} already exists`);
		const created = await this.service.createSession({
			parentSessionId: request.sessionId,
			name: request.taskName,
			model,
		});
		const summary: AgentSummary = {
			id: randomUUID(),
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
			messages: [request.taskMessage],
			followUps: [],
			waiters: [],
			activeOperationAccepted: false,
			abortRequested: false,
		};
		this.agents.set(summary.id, agent);
		void this.run(agent, "turn/start", request.taskMessage);
		return this.snapshot(agent);
	}

	async list(sessionId: string): Promise<readonly AgentSummary[]> {
		return [...this.agents.values()]
			.filter((agent) => agent.parentSessionId === sessionId)
			.map((agent) => this.snapshot(agent));
	}

	async dispose(): Promise<void> {
		if (this.disposePromise) return this.disposePromise;
		this.disposePromise = (async () => {
			await this.spawnTail;
			const results = await Promise.allSettled([...this.agents.values()].map((agent) => agent.runtime.dispose()));
			this.agents.clear();
			const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
			if (failures.length === 1) throw failures[0]!.reason;
			if (failures.length > 1) throw new AggregateError(failures.map((failure) => failure.reason), "Failed to dispose child agent runtimes");
		})();
		return this.disposePromise;
	}

	async getSnapshot(agentId: string): Promise<V2AgentSnapshot> {
		const agent = this.get(agentId);
		return { ...this.snapshot(agent), sessionId: agent.parentSessionId };
	}

	async wait(agentId: string, timeoutMs?: number): Promise<AgentSummary> {
		if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 0))
			throw new Error("timeoutMs must be non-negative");
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
		const agent = this.get(agentId);
		this.validateMessage(message);
		this.appendMessage(agent, message);
	}

	async followUp(agentId: string, message: string): Promise<AgentSummary> {
		const agent = this.get(agentId);
		this.validateMessage(message);
		this.appendMessage(agent, message);
		if (agent.state === "complete" || agent.state === "interrupted" || agent.state === "failed") {
			agent.state = "running";
			void this.run(agent, "turn/followUp", message);
		} else agent.followUps.push(message);
		return this.snapshot(agent);
	}

	async interrupt(agentId: string): Promise<AgentSummary> {
		const agent = this.get(agentId);
		if (agent.state === "running" || agent.state === "awaitingInput") {
			agent.abortRequested = true;
			try {
				const operationId = agent.activeOperationId;
				if (operationId !== undefined && agent.activeOperationAccepted) await agent.runtime.abort(operationId);
			} finally {
				agent.state = "interrupted";
				this.resolveWaiters(agent);
			}
		}
		return this.snapshot(agent);
	}

	private async run(agent: ChildAgent, command: "turn/start" | "turn/followUp", text: string): Promise<void> {
		let nextFollowUp: string | undefined;
		try {
			const operationId = randomUUID();
			agent.activeOperationId = operationId;
			agent.activeOperationAccepted = false;
			await agent.runtime.accept(operationId);
			agent.activeOperationAccepted = true;
			if (agent.abortRequested || agent.state === "interrupted") {
				await agent.runtime.abort(operationId);
				return;
			}
			await agent.runtime.run(operationId, {
				command,
				sessionId: agent.childSessionId,
				payload: { text },
			});
			if (agent.state !== "interrupted") {
				nextFollowUp = agent.followUps.shift();
				if (nextFollowUp === undefined) agent.state = "complete";
				else {
					agent.state = "running";
				}
			}
		} catch {
			if (agent.state !== "interrupted") agent.state = "failed";
		} finally {
			agent.activeOperationId = undefined;
			agent.activeOperationAccepted = false;
			agent.abortRequested = false;
			if (nextFollowUp !== undefined) void this.run(agent, "turn/followUp", nextFollowUp);
			else if (agent.state !== "running") this.resolveWaiters(agent);
		}
	}

	private validateRequest(request: V2AgentRequest): void {
		const depth = request.parentPath.split("/").filter(Boolean).length - 1;
		if (depth >= this.maxDepth) throw new Error(`Agent maximum depth ${this.maxDepth} exceeded`);
		if (!/^[A-Za-z0-9._-]+$/.test(request.taskName))
			throw new Error("Agent taskName contains unsupported characters");
		this.validateMessage(request.taskMessage, "Agent taskMessage");
	}

	private validateMessage(message: string, label = "Agent message"): void {
		if (message.trim().length === 0) throw new Error(`${label} must not be empty`);
		if (message.length > this.maxMessageLength) throw new Error(`${label} exceeds maximum length ${this.maxMessageLength}`);
	}

	private appendMessage(agent: ChildAgent, message: string): void {
		if (agent.messages.length >= this.maxMessages) agent.messages.shift();
		agent.messages.push(message);
	}

	private async resolveModel(request: V2AgentRequest): Promise<{ provider: string; id: string }> {
		if (request.model.provider !== "inherit" && request.model.id !== "inherit") return request.model;
		const parent = await this.service.openSession(request.sessionId);
		try {
			const inherited = (await parent.snapshot()).model;
			return {
				provider: request.model.provider === "inherit" ? inherited.provider : request.model.provider,
				id: request.model.id === "inherit" ? inherited.id : request.model.id,
			};
		} finally {
			await parent.dispose();
		}
	}

	private activeCount(): number {
		return [...this.agents.values()].filter((agent) => agent.state === "running" || agent.state === "awaitingInput").length;
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

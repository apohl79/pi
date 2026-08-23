import { randomUUID } from "node:crypto";
import type { AgentSummary } from "@earendil-works/pi-protocol";

export interface V2AgentRequest {
	readonly sessionId: string;
	readonly parentPath: string;
	readonly taskName: string;
	readonly taskMessage: string;
	readonly role?: string;
	/** Internal server hint preserving whether the model was caller-selected or inherited. */
	readonly modelResolution?: "explicit" | "inherited";
	readonly forkTurns?: "none" | "all" | number;
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
	/** Release child runtimes owned by the server lifecycle, when applicable. */
	dispose?(): Promise<void>;
}

interface AgentState {
	readonly summary: AgentSummary;
	readonly sessionId: string;
	readonly parentPath: string;
	state: AgentSummary["state"];
	messages: string[];
}

export class InMemoryV2AgentRegistry implements V2AgentRegistry {
	private readonly maxDepth: number;
	private readonly maxActive: number;
	private readonly maxActivePerParent: number;
	private readonly agents = new Map<string, AgentState>();

	constructor(options: { maxDepth?: number; maxActive?: number; maxActivePerParent?: number } = {}) {
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
		if (
			request.forkTurns !== undefined &&
			request.forkTurns !== "none" &&
			request.forkTurns !== "all" &&
			(!Number.isInteger(request.forkTurns) || request.forkTurns < 1 || request.forkTurns > 32)
		)
			throw new Error("forkTurns must be none, all, or an integer from 1 to 32");
		const depth = request.parentPath.split("/").filter(Boolean).length - 1;
		if (depth >= this.maxDepth) throw new Error(`Agent maximum depth ${this.maxDepth} exceeded`);
		if (this.activeCount() >= this.maxActive) throw new Error(`Agent active limit ${this.maxActive} exceeded`);
		if (this.activeCountForParent(request.sessionId) >= this.maxActivePerParent)
			throw new Error(`Agent active limit ${this.maxActivePerParent} exceeded for parent ${request.sessionId}`);
		if (!/^[A-Za-z0-9._-]+$/.test(request.taskName))
			throw new Error("Agent taskName contains unsupported characters");
		const path = `${request.parentPath.replace(/\/$/, "")}/${request.taskName}`;
		if ([...this.agents.values()].some((agent) => agent.summary.path === path))
			throw new Error(`Agent path ${path} already exists`);
		const summary: AgentSummary = {
			id: randomUUID(),
			path,
			taskName: request.taskName,
			state: "running",
			model: request.model,
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
		if (timeoutMs && timeoutMs > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(timeoutMs, 10)));
		return this.snapshot(this.get(agentId));
	}

	async message(agentId: string, message: string): Promise<void> {
		if (message.trim().length === 0) throw new Error("Agent message must not be empty");
		this.get(agentId).messages.push(message);
	}

	async followUp(agentId: string, message: string): Promise<AgentSummary> {
		const agent = this.get(agentId);
		await this.message(agentId, message);
		if (agent.state === "complete" || agent.state === "interrupted") agent.state = "running";
		return this.snapshot(agent);
	}

	async interrupt(agentId: string): Promise<AgentSummary> {
		const agent = this.get(agentId);
		if (agent.state === "running" || agent.state === "awaitingInput") agent.state = "interrupted";
		return this.snapshot(agent);
	}

	async dispose(): Promise<void> {
		for (const agent of this.agents.values()) {
			if (agent.state === "running" || agent.state === "awaitingInput") agent.state = "interrupted";
		}
	}

	async complete(agentId: string): Promise<AgentSummary> {
		const agent = this.get(agentId);
		agent.state = "complete";
		return this.snapshot(agent);
	}

	private activeCount(): number {
		return [...this.agents.values()].filter((agent) => agent.state === "running").length;
	}

	private activeCountForParent(sessionId: string): number {
		return [...this.agents.values()].filter((agent) => agent.sessionId === sessionId && agent.state === "running")
			.length;
	}

	private snapshot(agent: AgentState): AgentSummary {
		return structuredClone({ ...agent.summary, state: agent.state });
	}

	private get(agentId: string): AgentState {
		const agent = this.agents.get(agentId);
		if (!agent) throw new Error(`Unknown agent ${agentId}`);
		return agent;
	}
}

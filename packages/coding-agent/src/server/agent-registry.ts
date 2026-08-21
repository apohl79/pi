import { randomUUID } from "node:crypto";
import type { AgentSummary } from "@earendil-works/pi-protocol";
import type { V2AgentRegistry, V2AgentRequest, V2AgentSnapshot } from "@earendil-works/pi-server";
import type { CodingAgentV2Runtime, CodingAgentV2Service } from "./v2-service.ts";

interface ChildAgent {
	readonly summary: AgentSummary;
	readonly sessionId: string;
	readonly runtime: CodingAgentV2Runtime;
	state: AgentSummary["state"];
	messages: string[];
	waiters: Array<() => void>;
}

export interface CodingAgentV2AgentRegistryOptions {
	readonly maxDepth?: number;
	readonly maxActive?: number;
}

/** Executes server-owned child agents through the durable coding-agent service. */
export class CodingAgentV2AgentRegistry implements V2AgentRegistry {
	private readonly maxDepth: number;
	private readonly maxActive: number;
	private readonly agents = new Map<string, ChildAgent>();
	private readonly service: CodingAgentV2Service;

	constructor(service: CodingAgentV2Service, options: CodingAgentV2AgentRegistryOptions = {}) {
		this.service = service;
		this.maxDepth = options.maxDepth ?? 1;
		this.maxActive = options.maxActive ?? 8;
	}

	async spawn(request: V2AgentRequest): Promise<AgentSummary> {
		this.validateRequest(request);
		if (this.activeCount() >= this.maxActive) throw new Error(`Agent active limit ${this.maxActive} exceeded`);
		if (!this.service.createSession) throw new Error("Coding-agent service does not support child sessions");
		const path = `${request.parentPath.replace(/\/$/, "")}/${request.taskName}`;
		if ([...this.agents.values()].some((agent) => agent.summary.path === path))
			throw new Error(`Agent path ${path} already exists`);
		const created = await this.service.createSession({
			parentSessionId: request.sessionId,
			name: request.taskName,
			model: request.model,
		});
		const summary: AgentSummary = {
			id: randomUUID(),
			path,
			taskName: request.taskName,
			state: "running",
			model: request.model,
		};
		const agent: ChildAgent = {
			summary,
			sessionId: created.sessionId,
			runtime: created.runtime,
			state: "running",
			messages: [request.taskMessage],
			waiters: [],
		};
		this.agents.set(summary.id, agent);
		void this.run(agent, "turn/start", request.taskMessage);
		return this.snapshot(agent);
	}

	async list(sessionId: string): Promise<readonly AgentSummary[]> {
		return [...this.agents.values()]
			.filter((agent) => agent.sessionId === sessionId)
			.map((agent) => this.snapshot(agent));
	}

	async getSnapshot(agentId: string): Promise<V2AgentSnapshot> {
		const agent = this.get(agentId);
		return { ...this.snapshot(agent), sessionId: agent.sessionId };
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
		if (message.trim().length === 0) throw new Error("Agent message must not be empty");
		this.get(agentId).messages.push(message);
	}

	async followUp(agentId: string, message: string): Promise<AgentSummary> {
		if (message.trim().length === 0) throw new Error("Agent message must not be empty");
		const agent = this.get(agentId);
		await this.message(agentId, message);
		if (agent.state === "complete" || agent.state === "interrupted" || agent.state === "failed") {
			agent.state = "running";
			void this.run(agent, "turn/followUp", message);
		}
		return this.snapshot(agent);
	}

	async interrupt(agentId: string): Promise<AgentSummary> {
		const agent = this.get(agentId);
		if (agent.state === "running" || agent.state === "awaitingInput") {
			try {
				const operationId = randomUUID();
				await agent.runtime.accept(operationId);
				await agent.runtime.run(operationId, {
					command: "turn/abort",
					sessionId: agent.sessionId,
					payload: {},
				});
			} finally {
				agent.state = "interrupted";
				this.resolveWaiters(agent);
			}
		}
		return this.snapshot(agent);
	}

	private async run(agent: ChildAgent, command: "turn/start" | "turn/followUp", text: string): Promise<void> {
		try {
			const operationId = randomUUID();
			await agent.runtime.accept(operationId);
			await agent.runtime.run(operationId, {
				command,
				sessionId: agent.sessionId,
				payload: { text },
			});
			agent.state = "complete";
		} catch {
			agent.state = "failed";
		} finally {
			this.resolveWaiters(agent);
		}
	}

	private validateRequest(request: V2AgentRequest): void {
		const depth = request.parentPath.split("/").filter(Boolean).length - 1;
		if (depth >= this.maxDepth) throw new Error(`Agent maximum depth ${this.maxDepth} exceeded`);
		if (!/^[A-Za-z0-9._-]+$/.test(request.taskName))
			throw new Error("Agent taskName contains unsupported characters");
		if (request.taskMessage.trim().length === 0) throw new Error("Agent taskMessage must not be empty");
	}

	private activeCount(): number {
		return [...this.agents.values()].filter((agent) => agent.state === "running").length;
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

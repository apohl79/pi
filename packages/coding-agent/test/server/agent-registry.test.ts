import type { Entry } from "@earendil-works/pi-agent-core";
import type { CommandV2, OperationAccepted, SessionSnapshotV2 } from "@earendil-works/pi-protocol";
import { InMemoryForensicRecorder } from "@earendil-works/pi-server";
import { describe, expect, test } from "vitest";
import { CodingAgentV2AgentRegistry } from "../../src/server/agent-registry.ts";
import type { CodingAgentV2Runtime, CodingAgentV2Service } from "../../src/server/v2-service.ts";

class FixtureRuntime implements CodingAgentV2Runtime {
	readonly commands: CommandV2[] = [];
	disposed = false;
	blocked = false;
	fail = false;
	readonly customEntries: Entry[] = [];
	private releasePromise: Promise<void> | undefined;
	private releaseBlocked: (() => void) | undefined;
	async snapshot(): Promise<SessionSnapshotV2> {
		return {
			model: { provider: "parent-provider", id: "parent-model" },
			transcript: [
				{ id: "old", role: "user", content: [{ type: "text", text: "old context" }], timestamp: 1 },
				{ id: "recent", role: "user", content: [{ type: "text", text: "recent context" }], timestamp: 2 },
			],
		} as SessionSnapshotV2;
	}
	async accept(operationId: string): Promise<OperationAccepted> {
		return { operationId, sessionRevision: 1, eventSeq: 1 };
	}
	async run(_operationId: string, command: CommandV2): Promise<void> {
		this.commands.push(command);
		if (this.fail) throw new Error("fixture failure");
		if (this.blocked) {
			this.releasePromise ??= new Promise<void>((resolve) => {
				this.releaseBlocked = resolve;
			});
			await this.releasePromise;
		}
	}
	async appendCustomEntry(customType: string, data?: unknown): Promise<string> {
		const id = `entry-${this.customEntries.length}`;
		this.customEntries.unshift({
			type: "custom",
			id,
			seq: this.customEntries.length + 1,
			parentId: null,
			timestamp: 1,
			customType,
			data,
		});
		return id;
	}
	async readCustomEntries(customType: string): Promise<readonly Entry[]> {
		return this.customEntries.filter((entry) => entry.type === "custom" && entry.customType === customType);
	}
	release(): void {
		this.releaseBlocked?.();
	}
	async dispose(): Promise<void> {
		this.disposed = true;
	}
}

function fixture() {
	const runtime = new FixtureRuntime();
	const service: CodingAgentV2Service = {
		listSessions: async () => [],
		listModels: async () => [],
		openSession: async () => runtime,
		createSession: async () => ({ sessionId: "child-session", runtime }),
	};
	return { runtime, registry: new CodingAgentV2AgentRegistry(service) };
}

describe("CodingAgentV2AgentRegistry", () => {
	test("executes spawned work and routes follow-up and interrupt commands", async () => {
		const { registry, runtime } = fixture();
		const agent = await registry.spawn({
			sessionId: "parent-session",
			parentPath: "root",
			taskName: "worker",
			taskMessage: "inspect the repository",
			model: { provider: "inherit", id: "inherit" },
		});
		expect((await registry.wait(agent.id)).state).toBe("complete");
		expect(await registry.list("parent-session")).toHaveLength(1);
		expect(await registry.list("child-session")).toHaveLength(0);
		expect((await registry.getSnapshot(agent.id)).model).toEqual({
			provider: "parent-provider",
			id: "parent-model",
		});
		expect(runtime.commands[0]?.command).toBe("turn/start");
		await registry.message(agent.id, "urgent context");
		await registry.followUp(agent.id, "continue with the tests");
		expect((await registry.wait(agent.id)).state).toBe("complete");
		expect(runtime.commands[1]?.command).toBe("turn/start");
		expect(runtime.commands[1]?.payload).toEqual({ text: "urgent context\n\ncontinue with the tests" });
		// A completed child is stable until a follow-up is requested.
		await registry.interrupt(agent.id);
		expect((await registry.getSnapshot(agent.id)).state).toBe("complete");
	});

	test("enforces depth, duplicate paths, and active limits", async () => {
		const { registry } = fixture();
		await expect(
			registry.spawn({
				sessionId: "parent",
				parentPath: "root/parent",
				taskName: "child",
				taskMessage: "work",
				model: { provider: "faux", id: "model" },
			}),
		).rejects.toThrow("maximum depth");
	});

	test("preserves canonical parent paths for nested child requests", async () => {
		const runtime = new FixtureRuntime();
		let childNumber = 0;
		const registry = new CodingAgentV2AgentRegistry(
			{
				listSessions: async () => [],
				listModels: async () => [],
				openSession: async () => runtime,
				createSession: async () => ({ sessionId: `child-session-${++childNumber}`, runtime }),
			},
			{ maxDepth: 2 },
		);
		const parent = await registry.spawn({
			sessionId: "root-session",
			parentPath: "/root",
			taskName: "parent",
			taskMessage: "start parent",
			model: { provider: "inherit", id: "inherit" },
		});
		const nested = await registry.spawn({
			sessionId: "child-session-1",
			parentPath: "/child-session-1",
			taskName: "nested",
			taskMessage: "start nested",
			model: { provider: "inherit", id: "inherit" },
		});

		expect(parent.path).toBe("/root/parent");
		expect(nested.path).toBe("/root/parent/nested");
		expect((await registry.list("root-session")).map((agent) => agent.path)).toEqual([
			"/root/parent",
			"/root/parent/nested",
		]);
		expect((await registry.list("child-session-1")).map((agent) => agent.path)).toEqual(["/root/parent/nested"]);
	});

	test("disposes child runtimes exactly once", async () => {
		const { registry, runtime } = fixture();
		await registry.spawn({
			sessionId: "parent-session",
			parentPath: "root",
			taskName: "worker",
			taskMessage: "inspect the repository",
			model: { provider: "inherit", id: "inherit" },
		});
		await registry.dispose();
		await registry.dispose();
		expect(runtime.disposed).toBe(true);
		await expect(
			registry.spawn({
				sessionId: "parent-session",
				parentPath: "root/",
				taskName: "second",
				taskMessage: "continue",
				model: { provider: "inherit", id: "inherit" },
			}),
		).rejects.toThrow("disposed");
	});

	test("runs follow-ups queued during an active child turn", async () => {
		const { registry, runtime } = fixture();
		runtime.blocked = true;
		const agent = await registry.spawn({
			sessionId: "parent-session",
			parentPath: "root",
			taskName: "worker",
			taskMessage: "initial task",
			model: { provider: "inherit", id: "inherit" },
		});
		await registry.followUp(agent.id, "queued task");
		expect((await registry.getSnapshot(agent.id)).state).toBe("running");
		runtime.release();
		expect((await registry.wait(agent.id)).state).toBe("complete");
		expect(runtime.commands.map((command) => command.command)).toEqual(["turn/start", "turn/start"]);
	});

	test("enforces the active-child limit per parent", async () => {
		const runtime = new FixtureRuntime();
		runtime.blocked = true;
		let childNumber = 0;
		const registry = new CodingAgentV2AgentRegistry(
			{
				listSessions: async () => [],
				listModels: async () => [],
				openSession: async () => runtime,
				createSession: async () => ({ sessionId: `child-session-${childNumber++}`, runtime }),
			},
			{ maxActivePerParent: 1 },
		);
		await registry.spawn({
			sessionId: "parent-session",
			parentPath: "root",
			taskName: "first",
			taskMessage: "first task",
			model: { provider: "inherit", id: "inherit" },
		});
		await registry.spawn({
			sessionId: "parent-session",
			parentPath: "other",
			taskName: "first",
			taskMessage: "first task",
			model: { provider: "inherit", id: "inherit" },
		});
		await expect(
			registry.spawn({
				sessionId: "parent-session",
				parentPath: "root",
				taskName: "second",
				taskMessage: "second task",
				model: { provider: "inherit", id: "inherit" },
			}),
		).rejects.toThrow("for parent root");
	});

	test("enforces active limits when a terminal child receives a follow-up", async () => {
		const firstRuntime = new FixtureRuntime();
		const secondRuntime = new FixtureRuntime();
		secondRuntime.blocked = true;
		let childNumber = 0;
		const registry = new CodingAgentV2AgentRegistry(
			{
				listSessions: async () => [],
				listModels: async () => [],
				openSession: async () => firstRuntime,
				createSession: async () => ({
					sessionId: `child-session-${++childNumber}`,
					runtime: childNumber === 1 ? firstRuntime : secondRuntime,
				}),
			},
			{ maxActive: 1 },
		);
		const first = await registry.spawn({
			sessionId: "parent-session",
			parentPath: "/root",
			taskName: "first",
			taskMessage: "finish first",
			model: { provider: "inherit", id: "inherit" },
		});
		await registry.wait(first.id);
		await registry.spawn({
			sessionId: "parent-session",
			parentPath: "/root",
			taskName: "second",
			taskMessage: "keep the slot",
			model: { provider: "inherit", id: "inherit" },
		});
		await expect(registry.followUp(first.id, "must wait")).rejects.toThrow("active limit 1");
		secondRuntime.release();
		await registry.dispose();
	});

	test("bounds queued child messages", async () => {
		const { registry } = fixture();
		const agent = await registry.spawn({
			sessionId: "parent-session",
			parentPath: "root",
			taskName: "worker",
			taskMessage: "inspect the repository",
			model: { provider: "inherit", id: "inherit" },
		});
		for (let index = 0; index < 32; index++) await registry.message(agent.id, `message-${index}`);
		await expect(registry.message(agent.id, "overflow")).rejects.toThrow("inbox limit");
	});

	test("persists failed terminal state", async () => {
		const { registry, runtime } = fixture();
		runtime.fail = true;
		const agent = await registry.spawn({
			sessionId: "parent-session",
			parentPath: "root",
			taskName: "worker",
			taskMessage: "fail this task",
			model: { provider: "inherit", id: "inherit" },
		});
		expect((await registry.wait(agent.id)).state).toBe("failed");
		expect(runtime.customEntries[0]).toMatchObject({
			type: "custom",
			customType: "agent_registry_state",
			data: { state: "failed" },
		});
	});

	test("queues bounded child completion metadata in the parent session", async () => {
		const { registry, runtime } = fixture();
		const agent = await registry.spawn({
			sessionId: "parent-session",
			parentPath: "root",
			taskName: "worker",
			taskMessage: "complete this task",
			role: "reviewer",
			model: { provider: "inherit", id: "inherit" },
		});
		await registry.wait(agent.id);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(
			runtime.customEntries.find((entry) => entry.type === "custom" && entry.customType === "agent_completion"),
		).toMatchObject({
			data: { version: 1, agentId: agent.id, path: "root/worker", state: "complete", role: "reviewer" },
		});
	});

	test("records child spawn and terminal state transitions in diagnostics", async () => {
		const { runtime } = fixture();
		const diagnostics = new InMemoryForensicRecorder();
		const registry = new CodingAgentV2AgentRegistry(
			{
				listSessions: async () => [],
				listModels: async () => [],
				openSession: async () => runtime,
				createSession: async () => ({ sessionId: "child-session", runtime }),
			},
			{ diagnostics },
		);
		const agent = await registry.spawn({
			sessionId: "parent-session",
			parentPath: "root",
			taskName: "worker",
			taskMessage: "complete this task",
			model: { provider: "inherit", id: "inherit" },
		});
		await registry.wait(agent.id);
		await new Promise((resolve) => setTimeout(resolve, 0));
		const events = await diagnostics.read();
		expect(events.map((event) => event.kind)).toEqual(["agent_spawned", "agent_state_changed"]);
		expect(events.every((event) => event.agentId === agent.id && event.sessionId === "parent-session")).toBe(true);
	});

	test("records queued child messages and follow-ups in diagnostics", async () => {
		const { runtime } = fixture();
		const diagnostics = new InMemoryForensicRecorder();
		const registry = new CodingAgentV2AgentRegistry(
			{
				listSessions: async () => [],
				listModels: async () => [],
				openSession: async () => runtime,
				createSession: async () => ({ sessionId: "child-session", runtime }),
			},
			{ diagnostics },
		);
		const agent = await registry.spawn({
			sessionId: "parent-session",
			parentPath: "root",
			taskName: "worker",
			taskMessage: "complete this task",
			model: { provider: "inherit", id: "inherit" },
		});
		await registry.message(agent.id, "context update");
		await registry.followUp(agent.id, "continue the task");
		await registry.wait(agent.id);
		await new Promise((resolve) => setTimeout(resolve, 0));
		const kinds = (await diagnostics.read()).map((event) => event.kind);
		expect(kinds).toContain("agent_message_queued");
		expect(kinds).toContain("agent_followup_queued");
	});

	test("queues terminal completion metadata exactly once across an interrupt race", async () => {
		const { registry, runtime } = fixture();
		runtime.blocked = true;
		const agent = await registry.spawn({
			sessionId: "parent-session",
			parentPath: "root",
			taskName: "worker",
			taskMessage: "complete this task",
			model: { provider: "inherit", id: "inherit" },
		});
		const interruption = registry.interrupt(agent.id);
		runtime.release();
		await interruption;
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(
			runtime.customEntries.filter((entry) => entry.type === "custom" && entry.customType === "agent_completion"),
		).toHaveLength(1);
	});

	test("does not duplicate a completion already present in the parent journal", async () => {
		const { registry, runtime } = fixture();
		runtime.blocked = true;
		const agent = await registry.spawn({
			sessionId: "parent-session",
			parentPath: "root",
			taskName: "worker",
			taskMessage: "complete this task",
			model: { provider: "inherit", id: "inherit" },
		});
		await runtime.appendCustomEntry("agent_completion", { version: 1, agentId: agent.id });
		runtime.release();
		await registry.wait(agent.id);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(
			runtime.customEntries.filter((entry) => entry.type === "custom" && entry.customType === "agent_completion"),
		).toHaveLength(1);
	});

	test("snapshots bounded parent context into a forked child turn", async () => {
		const { registry, runtime } = fixture();
		const agent = await registry.spawn({
			sessionId: "parent-session",
			parentPath: "root",
			taskName: "worker",
			taskMessage: "continue the task",
			forkTurns: 1,
			model: { provider: "inherit", id: "inherit" },
		});
		await registry.wait(agent.id);
		expect(runtime.commands[0]?.payload).toEqual({
			text: '[forked context]\nuser: [{"type":"text","text":"recent context"}]\n\ncontinue the task',
		});
	});

	test("rejects unsafe agent registry limits", () => {
		const service: CodingAgentV2Service = {
			listSessions: async () => [],
			listModels: async () => [],
			openSession: async () => fixture().runtime,
		};
		expect(() => new CodingAgentV2AgentRegistry(service, { maxActive: 9 })).toThrow(
			"maxActive must be an integer from 1 to 8",
		);
		expect(() => new CodingAgentV2AgentRegistry(service, { maxActivePerParent: 0 })).toThrow("maxActivePerParent");
	});

	test("persists interruption when the daemon disposes running children", async () => {
		const { registry, runtime } = fixture();
		runtime.blocked = true;
		await registry.spawn({
			sessionId: "parent-session",
			parentPath: "root",
			taskName: "worker",
			taskMessage: "long task",
			model: { provider: "inherit", id: "inherit" },
		});
		await registry.dispose();
		expect(runtime.customEntries[0]).toMatchObject({ data: { state: "interrupted" } });
	});
});

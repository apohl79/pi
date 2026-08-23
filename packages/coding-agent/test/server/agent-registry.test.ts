import type { CommandV2, OperationAccepted, SessionSnapshotV2 } from "@earendil-works/pi-protocol";
import { describe, expect, test, vi } from "vitest";
import { CodingAgentV2AgentRegistry } from "../../src/server/agent-registry.ts";
import type { CodingAgentV2Runtime, CodingAgentV2Service } from "../../src/server/v2-service.ts";

class FixtureRuntime implements CodingAgentV2Runtime {
	readonly commands: CommandV2[] = [];
	disposeCount = 0;
	blocked = false;
	private releasePromise: Promise<void> | undefined;
	private releaseBlocked: (() => void) | undefined;
	async snapshot(): Promise<SessionSnapshotV2> {
		return { model: { provider: "parent-provider", id: "parent-model" } } as SessionSnapshotV2;
	}
	async accept(operationId: string): Promise<OperationAccepted> {
		return { operationId, sessionRevision: 1, eventSeq: 1 };
	}
	async run(_operationId: string, command: CommandV2): Promise<void> {
		this.commands.push(command);
		if (this.blocked) {
			this.releasePromise ??= new Promise<void>((resolve) => {
				this.releaseBlocked = resolve;
			});
			await this.releasePromise;
		}
	}
	release(): void {
		this.releaseBlocked?.();
	}
	async abort(_operationId: string): Promise<void> {}
	async dispose(): Promise<void> {
		this.disposeCount += 1;
	}
}

function fixture(options?: ConstructorParameters<typeof CodingAgentV2AgentRegistry>[1]) {
	const runtime = new FixtureRuntime();
	const service: CodingAgentV2Service = {
		listSessions: async () => [],
		listModels: async () => [],
		openSession: async () => runtime,
		createSession: async () => ({ sessionId: "child-session", runtime }),
	};
	return { runtime, registry: new CodingAgentV2AgentRegistry(service, options) };
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
		await registry.followUp(agent.id, "queued follow-up");
		expect(await registry.list("parent-session")).toEqual([agent]);
		expect(await registry.list("child-session")).toEqual([]);
		expect((await registry.wait(agent.id)).state).toBe("complete");
		expect((await registry.getSnapshot(agent.id)).model).toEqual({
			provider: "parent-provider",
			id: "parent-model",
		});
		expect(runtime.commands[0]?.command).toBe("turn/start");
		await registry.followUp(agent.id, "continue with the tests");
		expect((await registry.wait(agent.id)).state).toBe("complete");
		expect(runtime.commands[1]?.command).toBe("turn/followUp");
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

	test("bounds retained child messages", async () => {
		const { registry } = fixture();
		const agent = await registry.spawn({
			sessionId: "parent",
			parentPath: "root",
			taskName: "worker",
			taskMessage: "work",
			model: { provider: "faux", id: "model" },
		});
		await expect(registry.message(agent.id, "x".repeat(64 * 1024 + 1))).rejects.toThrow("maximum length");
	});

	test("disposes child runtimes exactly once", async () => {
		const { registry, runtime } = fixture();
		await registry.spawn({
			sessionId: "parent",
			parentPath: "root",
			taskName: "worker",
			taskMessage: "work",
			model: { provider: "faux", id: "model" },
		});
		await registry.dispose();
		await registry.dispose();
		expect(runtime.disposeCount).toBe(1);
	});

	test("disposes the parent lookup runtime after model inheritance", async () => {
		const { registry, runtime } = fixture();
		const agent = await registry.spawn({
			sessionId: "parent",
			parentPath: "root",
			taskName: "worker",
			taskMessage: "work",
			model: { provider: "inherit", id: "inherit" },
		});
		expect(agent.model).toEqual({ provider: "parent-provider", id: "parent-model" });
		expect(runtime.disposeCount).toBe(1);
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
		expect(runtime.commands.map((command) => command.command)).toEqual(["turn/start", "turn/followUp"]);
	});

	test("does not restart while an interrupted operation is still releasing", async () => {
		const { registry, runtime } = fixture();
		runtime.blocked = true;
		const agent = await registry.spawn({
			sessionId: "parent-session",
			parentPath: "root",
			taskName: "worker",
			taskMessage: "initial task",
			model: { provider: "inherit", id: "inherit" },
		});
		await vi.waitFor(() => expect(runtime.commands).toHaveLength(1));
		await registry.interrupt(agent.id);
		await expect(registry.followUp(agent.id, "restart too soon")).rejects.toThrow("active agent");
		runtime.release();
	});

	test("bounds queued follow-ups", async () => {
		const { registry, runtime } = fixture({ maxMessages: 1 });
		runtime.blocked = true;
		const agent = await registry.spawn({
			sessionId: "parent-session",
			parentPath: "root",
			taskName: "worker",
			taskMessage: "initial task",
			model: { provider: "inherit", id: "inherit" },
		});
		await vi.waitFor(() => expect(runtime.commands).toHaveLength(1));
		await registry.followUp(agent.id, "queued task");
		await expect(registry.followUp(agent.id, "overflow task")).rejects.toThrow("queue limit");
		runtime.release();
	});
});

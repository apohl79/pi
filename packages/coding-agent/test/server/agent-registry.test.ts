import type { CommandV2, OperationAccepted, SessionSnapshotV2 } from "@earendil-works/pi-protocol";
import { describe, expect, test } from "vitest";
import { CodingAgentV2AgentRegistry } from "../../src/server/agent-registry.ts";
import type { CodingAgentV2Runtime, CodingAgentV2Service } from "../../src/server/v2-service.ts";

class FixtureRuntime implements CodingAgentV2Runtime {
	readonly commands: CommandV2[] = [];
	disposed = false;
	async snapshot(): Promise<SessionSnapshotV2> {
		return { model: { provider: "parent-provider", id: "parent-model" } } as SessionSnapshotV2;
	}
	async accept(operationId: string): Promise<OperationAccepted> {
		return { operationId, sessionRevision: 1, eventSeq: 1 };
	}
	async run(_operationId: string, command: CommandV2): Promise<void> {
		this.commands.push(command);
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
				parentPath: "root",
				taskName: "second",
				taskMessage: "continue",
				model: { provider: "inherit", id: "inherit" },
			}),
		).rejects.toThrow("disposed");
	});
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { PiClientV2 } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";
import { afterEach, describe, expect, test } from "vitest";
import { RemoteV2Session } from "../../src/index.ts";
import { createConfiguredCodingAgentDaemonRuntime } from "../../src/server/daemon-runtime.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("production remote v2 scenario: goal, agents, input, and reattach", () => {
	test("keeps server-owned work alive across detach and completes with bounded usage", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-remote-scenario-"));
		directories.push(directory);
		const models = createModels();
		const parent = fauxProvider({
			provider: "coding-agent-remote-scenario-parent-faux",
			models: [{ id: "parent-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		const child = fauxProvider({
			provider: "coding-agent-remote-scenario-child-faux",
			models: [{ id: "child-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		models.setProvider(parent.provider);
		models.setProvider(child.provider);
		parent.setResponses([
			fauxAssistantMessage(
				fauxToolCall("request_user_input", {
					questions: [{ id: "choice", prompt: "Choose", options: [{ label: "Continue" }] }],
				}),
			),
			fauxAssistantMessage("parent completed after input"),
		]);
		child.setResponses([fauxAssistantMessage("child completed")]);
		const socketPath = join(directory, "server.sock");
		const runtime = await createConfiguredCodingAgentDaemonRuntime({
			agentDir: directory,
			cwd: directory,
			models,
			model: parent.getModel(),
			socketPath,
			harness: { activeToolNames: ["request_user_input"] },
			write: () => {},
		});
		const client = new PiClientV2({ transportFactory: createUnixTransportFactory({ path: socketPath }) });
		try {
			await runtime.daemon.start();
			await client.connect();
			const first = await RemoteV2Session.create(client, { cwd: directory }, { mode: "control" });
			const sessionId = first.id;
			if (!sessionId) throw new Error("Session id unavailable");
			try {
				const goalOperation = await first.createGoal("finish the remote task", 10_000);
				await first.waitForOperation(goalOperation);
				const childAgent = await first.spawnAgent("specialist", "complete the child task", {
					model: { provider: child.provider.id, id: "child-model" },
				});
				expect((await first.waitAgent(childAgent.id)).state).toBe("complete");
				const operationId = await first.submit("ask for the final decision");
				const requestId = await waitForPendingInput(first);
				expect(first.snapshot?.phase).toBe("awaitingInput");
				await first.dispose();

				const reattached = await RemoteV2Session.open(client, sessionId, { mode: "control" });
				try {
					expect(reattached.snapshot?.queues.pendingInputRequestId).toBe(requestId);
					await reattached.respondInput(requestId, { choice: "Continue" });
					await reattached.waitForOperation(operationId);
					await reattached.refresh();
					expect(reattached.snapshot?.phase).toBe("idle");
					expect(reattached.snapshot?.transcript).toEqual(
						expect.arrayContaining([
							expect.objectContaining({
								role: "assistant",
								content: expect.arrayContaining([
									expect.objectContaining({ text: "parent completed after input" }),
								]),
							}),
						]),
					);
					expect((await reattached.listAgents()).find((agent) => agent.id === childAgent.id)?.state).toBe(
						"complete",
					);
					const usage = await reattached.readUsage({ sessionId });
					expect(usage.aggregate).toMatchObject({ pricingState: "known" });
					expect(usage.aggregate.responses).toBeGreaterThan(0);
				} finally {
					await reattached.dispose();
				}
			} catch (error) {
				if (first.state.lifecycle.status !== "disposed") await first.dispose();
				throw error;
			}
		} finally {
			client.dispose();
			await runtime.close();
		}
	});
});

async function waitForPendingInput(session: RemoteV2Session): Promise<string> {
	for (let attempt = 0; attempt < 100; attempt++) {
		await session.refresh();
		const requestId = session.snapshot?.queues.pendingInputRequestId;
		if (requestId) return requestId;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("Timed out waiting for pending input");
}

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { PiClientV2 } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";
import { afterEach, describe, expect, test } from "vitest";
import { createConfiguredCodingAgentDaemonRuntime } from "../../src/server/daemon-runtime.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function response(content: Parameters<typeof fauxAssistantMessage>[0], cost: number, responseId: string) {
	return {
		...fauxAssistantMessage(content, { responseId }),
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: cost, cacheRead: 0, cacheWrite: 0, total: cost },
		},
	};
}

function resultOf<T>(value: unknown): T {
	return (value as { result: T }).result;
}

function createModelsWithResponses() {
	const models = createModels();
	const parent = fauxProvider({
		provider: "coding-agent-goal-reattach-parent-faux",
		models: [{ id: "parent-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
	});
	const child = fauxProvider({
		provider: "coding-agent-goal-reattach-child-faux",
		models: [{ id: "child-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
	});
	models.setProvider(parent.provider);
	models.setProvider(child.provider);
	parent.setResponses([
		response(
			fauxToolCall("request_user_input", {
				questions: [{ id: "approval", prompt: "Continue?", options: [{ label: "Yes" }] }],
			}),
			0.1,
			"parent-question",
		),
		response("parent completed", 0.3, "parent-final"),
	]);
	child.setResponses([response("child completed", 0.2, "child-final")]);
	return { models, parent };
}

async function createRuntime(directory: string, socketPath: string) {
	const { models, parent } = createModelsWithResponses();
	return createConfiguredCodingAgentDaemonRuntime({
		agentDir: directory,
		cwd: directory,
		models,
		model: parent.getModel(),
		socketPath,
		harness: { activeToolNames: ["request_user_input"] },
		write: () => {},
	});
}

async function waitForPendingInput(client: PiClientV2, sessionId: string): Promise<string> {
	await expect
		.poll(
			async () =>
				resultOf<{ session: { queues: { pendingInputRequestId?: string } } }>(
					await client.request({ command: "session/read", sessionId }),
				).session.queues.pendingInputRequestId ?? "",
			{ timeout: 2_000 },
		)
		.toMatch(/.+/);
	return resultOf<{ session: { queues: { pendingInputRequestId: string } } }>(
		await client.request({ command: "session/read", sessionId }),
	).session.queues.pendingInputRequestId;
}

async function waitForIdle(client: PiClientV2, sessionId: string): Promise<void> {
	await expect
		.poll(
			async () =>
				resultOf<{ session: { phase: string } }>(await client.request({ command: "session/read", sessionId }))
					.session.phase,
			{ timeout: 2_000 },
		)
		.toBe("idle");
}

describe("coding-agent daemon combined goal flow", () => {
	async function runFirstAttachment(
		directory: string,
		socketPath: string,
	): Promise<{ sessionId: string; requestId: string }> {
		const runtime = await createRuntime(directory, socketPath);
		const client = new PiClientV2({ transportFactory: createUnixTransportFactory({ path: socketPath }) });
		try {
			await runtime.daemon.start();
			await client.connect();
			const sessionId = resultOf<{ session: { id: string } }>(
				await client.request({ command: "session/create", payload: { cwd: directory } }),
			).session.id;
			await client.request({ command: "session/attach", sessionId, payload: { mode: "control" } });
			await client.request({ command: "goal/create", sessionId, payload: { objective: "finish the flow" } });
			const spawned = await client.request({
				command: "agent/spawn",
				sessionId,
				payload: {
					taskName: "specialist",
					taskMessage: "inspect the task",
					model: { provider: "coding-agent-goal-reattach-child-faux", id: "child-model" },
				},
			});
			const agentId = resultOf<{ agent: { id: string } }>(spawned).agent.id;
			await expect(client.request({ command: "agent/wait", payload: { agentId } })).resolves.toMatchObject({
				result: { agent: { state: "complete", model: { provider: "coding-agent-goal-reattach-child-faux" } } },
			});
			await client.request({ command: "turn/start", sessionId, payload: { text: "ask before continuing" } });
			const requestId = await waitForPendingInput(client, sessionId);
			await client.request({ command: "session/detach", sessionId });
			return { sessionId, requestId };
		} finally {
			client.dispose();
			await runtime.close();
		}
	}

	async function verifyReattachedFlow(directory: string, socketPath: string, sessionId: string, requestId: string) {
		const runtime = await createRuntime(directory, socketPath);
		const client = new PiClientV2({ transportFactory: createUnixTransportFactory({ path: socketPath }) });
		try {
			await runtime.daemon.start();
			await client.connect();
			await client.request({ command: "session/attach", sessionId, payload: { mode: "control" } });
			expect(await client.request({ command: "goal/read", sessionId })).toMatchObject({
				result: { goal: { objective: "finish the flow", status: "active" } },
			});
			expect(await client.request({ command: "agent/list", sessionId })).toMatchObject({
				result: { agents: [{ taskName: "specialist", state: "complete" }] },
			});
			expect(await client.request({ command: "input/request/read", payload: { requestId } })).toMatchObject({
				result: { request: { status: "pending", id: requestId } },
			});
			await client.request({
				command: "input/request/respond",
				payload: { requestId, answers: { approval: "Yes" } },
			});
			await waitForIdle(client, sessionId);
			expect(await client.request({ command: "usage/read" })).toMatchObject({
				result: { aggregate: { responses: 3, costUsd: 0, pricingState: "known" } },
			});
		} finally {
			client.dispose();
			await runtime.close();
		}
	}

	test("preserves goal, mixed-provider child, pending input, and usage across reattach", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-daemon-goal-reattach-"));
		directories.push(directory);
		const socketPath = join(directory, "server.sock");
		const { sessionId, requestId } = await runFirstAttachment(directory, socketPath);
		await verifyReattachedFlow(directory, socketPath, sessionId, requestId);
	});
});

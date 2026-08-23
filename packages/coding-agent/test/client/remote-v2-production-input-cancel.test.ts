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

describe("production remote v2 input cancellation", () => {
	test("cancels a pending server-owned request through the public client", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-remote-input-cancel-"));
		directories.push(directory);
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-remote-input-cancel-faux",
			models: [{ id: "remote-input-cancel-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		models.setProvider(faux.provider);
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("request_user_input", {
					questions: [{ id: "choice", prompt: "Choose", options: [{ label: "Yes" }] }],
				}),
			),
		]);
		const socketPath = join(directory, "server.sock");
		const runtime = await createConfiguredCodingAgentDaemonRuntime({
			agentDir: directory,
			cwd: directory,
			models,
			model: faux.getModel(),
			socketPath,
			harness: { activeToolNames: ["request_user_input"] },
			write: () => {},
		});
		const client = new PiClientV2({ transportFactory: createUnixTransportFactory({ path: socketPath }) });
		try {
			await runtime.daemon.start();
			await client.connect();
			const session = await RemoteV2Session.create(client, { cwd: directory }, { mode: "control" });
			try {
				const operationId = await session.submit("ask for a choice");
				const requestId = await waitForPendingInput(session);
				expect(await session.readInputRequest(requestId)).toMatchObject({ id: requestId, status: "pending" });
				await session.cancelInput(requestId);
				expect(await session.readInputRequest(requestId)).toMatchObject({ id: requestId, status: "cancelled" });
				await session.waitForOperation(operationId);
				const terminal = await session.readOperation(operationId);
				expect(["failed", "aborted"]).toContain(terminal.state);
				expect(session.snapshot?.queues.pendingInputRequestId).toBeUndefined();
			} finally {
				await session.dispose();
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

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { PiClientV2 } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";
import { afterEach, describe, expect, test } from "vitest";
import { RemoteV2InteractiveAttachment, RemoteV2SessionSelector } from "../../src/index.ts";
import { createConfiguredCodingAgentDaemonRuntime } from "../../src/server/daemon-runtime.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function waitForIdle(attachment: {
	readonly session: { refresh(): Promise<unknown>; phase?: string };
}): Promise<void> {
	for (let attempt = 0; attempt < 50; attempt++) {
		await attachment.session.refresh();
		if (attachment.session.phase === "idle") return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("Timed out waiting for remote input turn");
}

describe("production remote v2 input", () => {
	test("answers /input and resumes the suspended daemon turn", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-remote-input-"));
		directories.push(directory);
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-remote-input-faux",
			models: [{ id: "remote-input-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("request_user_input", {
					questions: [{ id: "choice", prompt: "Choose", options: [{ label: "Yes" }] }],
				}),
			),
			fauxAssistantMessage("input handled"),
		]);
		models.setProvider(faux.provider);
		const runtime = await createConfiguredCodingAgentDaemonRuntime({
			agentDir: directory,
			cwd: directory,
			models,
			model: faux.getModel(),
			socketPath: join(directory, "server.sock"),
			harness: { activeToolNames: ["request_user_input"] },
			write: () => {},
		});
		const client = new PiClientV2({
			transportFactory: createUnixTransportFactory({ path: join(directory, "server.sock") }),
		});
		try {
			await runtime.daemon.start();
			await client.connect();
			const created = await client.request({ command: "session/create", payload: { cwd: directory } });
			const sessionId = (created as unknown as { result: { session: { id: string } } }).result.session.id;
			const attachment = await new RemoteV2SessionSelector(client).attachView(sessionId, { mode: "control" });
			const adapter = new RemoteV2InteractiveAttachment(attachment);
			try {
				const started = await adapter.submit("ask me");
				await attachment.session.waitForOperation(started);
				const requestId = attachment.session.snapshot?.queues.pendingInputRequestId;
				expect(requestId).toEqual(expect.any(String));
				if (!requestId) throw new Error("Remote input request was not created");
				expect(await adapter.execute(`/input ${requestId} {"choice":"Yes"}`)).toEqual({
					kind: "status",
					text: "input answered",
				});
				await waitForIdle(attachment);
				expect(attachment.session.snapshot?.transcript).toEqual(
					expect.arrayContaining([expect.objectContaining({ role: "assistant", text: "input handled" })]),
				);
			} finally {
				await adapter.dispose();
			}
		} finally {
			client.dispose();
			await runtime.close();
		}
	});
});

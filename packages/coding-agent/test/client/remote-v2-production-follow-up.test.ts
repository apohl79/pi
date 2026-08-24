import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { PiClientV2 } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";
import { afterEach, describe, expect, test } from "vitest";
import { RemoteV2InteractiveAttachment, type RemoteV2Session, RemoteV2SessionSelector } from "../../src/index.ts";
import { createConfiguredCodingAgentDaemonRuntime } from "../../src/server/daemon-runtime.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("production remote v2 follow-up", () => {
	test("runs a queued follow-up turn through /follow-up", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-remote-follow-up-"));
		directories.push(directory);
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-remote-follow-up-faux",
			models: [{ id: "remote-follow-up-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		models.setProvider(faux.provider);
		faux.setResponses([
			async () => {
				await new Promise((resolve) => setTimeout(resolve, 1_000));
				return fauxAssistantMessage("initial answer");
			},
			fauxAssistantMessage("follow-up answer"),
		]);
		const runtime = await createConfiguredCodingAgentDaemonRuntime({
			agentDir: directory,
			cwd: directory,
			models,
			model: faux.getModel(),
			socketPath: join(directory, "server.sock"),
			harness: { tools: [], activeToolNames: [] },
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
				const initial = await adapter.submit("start the work");
				await waitForPhase(attachment.session, "turn");
				const followUp = await adapter.execute("/follow-up continue with verification");
				expect(followUp.kind).toBe("operation");
				await attachment.session.waitForOperation(initial);
				await waitForTranscript(attachment.session, "follow-up answer");
			} finally {
				await adapter.dispose();
			}
		} finally {
			client.dispose();
			await runtime.close();
		}
	});
});

async function waitForTranscript(session: RemoteV2Session, text: string): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		await session.refresh();
		if (
			session.snapshot?.transcript.some(
				(item) =>
					item.role === "assistant" && item.content.some((part) => part.type === "text" && part.text === text),
			)
		)
			return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Timed out waiting for assistant text: ${text}`);
}

async function waitForPhase(session: RemoteV2Session, phase: "turn"): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		await session.refresh();
		if (session.snapshot?.phase === phase) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Timed out waiting for session phase: ${phase}`);
}

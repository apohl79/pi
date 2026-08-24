import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { PiClientV2 } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";
import { afterEach, describe, expect, test } from "vitest";
import { RemoteV2Session } from "../../src/index.ts";
import { createConfiguredCodingAgentDaemonRuntime } from "../../src/server/daemon-runtime.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("production remote v2 queue recall", () => {
	test("cancels a queued follow-up through RemoteV2Session", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-remote-queue-recall-"));
		directories.push(directory);
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-remote-queue-recall-faux",
			models: [{ id: "remote-queue-recall-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		models.setProvider(faux.provider);
		let release!: (response: ReturnType<typeof fauxAssistantMessage>) => void;
		const response = new Promise<ReturnType<typeof fauxAssistantMessage>>((resolve) => {
			release = resolve;
		});
		faux.setResponses([() => response]);
		const socketPath = join(directory, "server.sock");
		const runtime = await createConfiguredCodingAgentDaemonRuntime({
			agentDir: directory,
			cwd: directory,
			models,
			model: faux.getModel(),
			socketPath,
			harness: { tools: [], activeToolNames: [] },
			write: () => {},
		});
		const client = new PiClientV2({ transportFactory: createUnixTransportFactory({ path: socketPath }) });
		try {
			await runtime.daemon.start();
			await client.connect();
			const session = await RemoteV2Session.create(client, { cwd: directory }, { mode: "control" });
			try {
				const operationId = await session.submit("start");
				await waitForPhase(session, "turn");
				await session.followUp("queued follow-up");
				const entry = await waitForFollowUp(session);
				expect(await session.cancelQueued(entry.id)).toEqual(entry.content);
				await session.refresh();
				expect(session.snapshot?.queues.followUp).toEqual([]);
				release(fauxAssistantMessage("completed"));
				await session.waitForOperation(operationId);
			} finally {
				await session.dispose();
			}
		} finally {
			client.dispose();
			await runtime.close();
		}
	});
});

async function waitForPhase(session: RemoteV2Session, phase: string): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		await session.refresh();
		if (session.phase === phase) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Timed out waiting for phase ${phase}`);
}

async function waitForFollowUp(session: RemoteV2Session): Promise<{ id: string; content: readonly unknown[] }> {
	for (let attempt = 0; attempt < 100; attempt++) {
		await session.refresh();
		const entry = session.snapshot?.queues.followUp[0];
		if (entry !== undefined) return entry;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("Timed out waiting for queued follow-up");
}

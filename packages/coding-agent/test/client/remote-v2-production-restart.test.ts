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

describe("production remote v2 daemon restart", () => {
	test("reopens persisted session state through a fresh daemon instance", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-remote-restart-"));
		directories.push(directory);
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-remote-restart-faux",
			models: [{ id: "remote-restart-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		models.setProvider(faux.provider);
		faux.setResponses([fauxAssistantMessage("persisted across restart")]);
		const socketPath = join(directory, "server.sock");
		const createRuntime = () =>
			createConfiguredCodingAgentDaemonRuntime({
				agentDir: directory,
				cwd: directory,
				models,
				model: faux.getModel(),
				socketPath,
				harness: { tools: [], activeToolNames: [] },
				write: () => {},
			});
		const firstRuntime = await createRuntime();
		const firstClient = new PiClientV2({ transportFactory: createUnixTransportFactory({ path: socketPath }) });
		let sessionId: string;
		try {
			await firstRuntime.daemon.start();
			await firstClient.connect();
			const session = await RemoteV2Session.create(firstClient, { cwd: directory }, { mode: "control" });
			try {
				if (session.id === undefined) throw new Error("Created remote session has no id");
				sessionId = session.id;
				const operationId = await session.submit("persist this before restart");
				await session.waitForOperation(operationId);
				expect(session.snapshot?.transcript).toEqual(
					expect.arrayContaining([expect.objectContaining({ text: "persisted across restart" })]),
				);
			} finally {
				await session.dispose();
			}
		} finally {
			firstClient.dispose();
			await firstRuntime.close();
		}

		const secondRuntime = await createRuntime();
		const secondClient = new PiClientV2({ transportFactory: createUnixTransportFactory({ path: socketPath }) });
		try {
			await secondRuntime.daemon.start();
			await secondClient.connect();
			const restored = await RemoteV2Session.open(secondClient, sessionId!, { mode: "control" });
			try {
				expect(restored.snapshot?.transcript).toEqual(
					expect.arrayContaining([expect.objectContaining({ text: "persisted across restart" })]),
				);
				expect(restored.state.lifecycle).toEqual({ status: "ready" });
			} finally {
				await restored.dispose();
			}
		} finally {
			secondClient.dispose();
			await secondRuntime.close();
		}
	});
});

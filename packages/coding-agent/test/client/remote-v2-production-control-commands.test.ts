import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { PiClientV2 } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";
import { afterEach, describe, expect, test } from "vitest";
import { RemoteV2InteractiveAttachment, RemoteV2Session, RemoteV2SessionSelector } from "../../src/index.ts";
import { createConfiguredCodingAgentDaemonRuntime } from "../../src/server/daemon-runtime.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("production remote v2 control commands", () => {
	test("release and take control through slash commands", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-remote-control-commands-"));
		directories.push(directory);
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-remote-control-commands-faux",
			models: [{ id: "remote-control-commands-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		models.setProvider(faux.provider);
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
		const firstClient = new PiClientV2({ transportFactory: createUnixTransportFactory({ path: socketPath }) });
		const secondClient = new PiClientV2({ transportFactory: createUnixTransportFactory({ path: socketPath }) });
		try {
			await runtime.daemon.start();
			await firstClient.connect();
			await secondClient.connect();
			const created = await RemoteV2Session.create(firstClient, { cwd: directory }, { mode: "control" });
			const sessionId = created.id;
			if (!sessionId) throw new Error("Session id unavailable");
			await created.dispose();
			const firstAttachment = await new RemoteV2SessionSelector(firstClient).attachView(sessionId, {
				mode: "control",
			});
			const secondAttachment = await new RemoteV2SessionSelector(secondClient).attachView(sessionId, {
				mode: "observer",
			});
			try {
				const firstCommands = new RemoteV2InteractiveAttachment(firstAttachment);
				const secondCommands = new RemoteV2InteractiveAttachment(secondAttachment);
				expect(await firstCommands.execute("/release-control")).toEqual({ kind: "control", mode: "observer" });
				expect(await secondCommands.execute("/take-control")).toEqual({ kind: "control", mode: "control" });
			} finally {
				await secondAttachment.dispose();
				await firstAttachment.dispose();
			}
		} finally {
			firstClient.dispose();
			secondClient.dispose();
			await runtime.close();
		}
	});
});

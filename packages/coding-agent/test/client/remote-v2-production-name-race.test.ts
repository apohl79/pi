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

describe("production remote v2 naming race", () => {
	test("keeps an explicit name when generated naming is already sampling", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-remote-name-race-"));
		directories.push(directory);
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-remote-name-race-faux",
			models: [{ id: "remote-name-race-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		models.setProvider(faux.provider);
		let namingStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			namingStarted = resolve;
		});
		let releaseNaming!: (message: ReturnType<typeof fauxAssistantMessage>) => void;
		const namingResponse = new Promise<ReturnType<typeof fauxAssistantMessage>>((resolve) => {
			releaseNaming = resolve;
		});
		faux.setResponses([
			fauxAssistantMessage("turn complete"),
			() => {
				namingStarted();
				return namingResponse;
			},
		]);
		const socketPath = join(directory, "server.sock");
		const runtime = await createConfiguredCodingAgentDaemonRuntime({
			agentDir: directory,
			cwd: directory,
			models,
			model: faux.getModel(),
			fastModel: faux.getModel(),
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
				const turn = await session.submit("name this task");
				await session.waitForOperation(turn);
				await started;
				const explicit = await session.setName("Explicit title");
				await session.waitForOperation(explicit);
				releaseNaming(fauxAssistantMessage("Generated title"));
				for (let attempt = 0; attempt < 50; attempt++) {
					await session.refresh();
					if (session.snapshot?.name === "Explicit title") break;
					await new Promise((resolve) => setTimeout(resolve, 10));
				}
				expect(session.snapshot).toMatchObject({ name: "Explicit title", nameSource: "explicit" });
			} finally {
				await session.dispose();
			}
		} finally {
			client.dispose();
			await runtime.close();
		}
	});
});

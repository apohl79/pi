import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { PiClientV2 } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";
import { afterEach, describe, expect, test } from "vitest";
import { RemoteV2Session } from "../../src/client/remote-v2-session.ts";
import { createConfiguredCodingAgentDaemonRuntime } from "../../src/server/daemon-runtime.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("production remote v2 naming reattach", () => {
	test("persists one generated name while the client detaches during naming", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-remote-name-reattach-"));
		directories.push(directory);
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-remote-name-reattach-faux",
			models: [{ id: "session-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		models.setProvider(faux.provider);
		let namingStarted!: () => void;
		const namingStartedSignal = new Promise<void>((resolve) => {
			namingStarted = resolve;
		});
		let releaseNaming!: () => void;
		const namingReleased = new Promise<void>((resolve) => {
			releaseNaming = resolve;
		});
		faux.setResponses([
			fauxAssistantMessage("turn complete"),
			async () => {
				namingStarted();
				await namingReleased;
				return fauxAssistantMessage("Detached title");
			},
		]);
		const socketPath = join(directory, "server.sock");
		const runtime = await createConfiguredCodingAgentDaemonRuntime({
			agentDir: directory,
			cwd: directory,
			models,
			model: faux.getModel("session-model")!,
			fastModel: faux.getModel("session-model"),
			socketPath,
			harness: { tools: [], activeToolNames: [] },
			write: () => {},
		});
		const client = new PiClientV2({ transportFactory: createUnixTransportFactory({ path: socketPath }) });
		try {
			await runtime.daemon.start();
			await client.connect();
			const first = await RemoteV2Session.create(client, { cwd: directory }, { mode: "control" });
			const sessionId = first.id;
			if (sessionId === undefined) throw new Error("Remote session did not expose an id");
			const operation = await first.submit("name this task");
			await first.waitForOperation(operation);
			await namingStartedSignal;
			await first.detach();
			await first.dispose();
			const reattached = await RemoteV2Session.open(client, sessionId, { mode: "control" });
			try {
				releaseNaming();
				for (let attempt = 0; attempt < 50; attempt++) {
					await reattached.refresh();
					if (reattached.snapshot?.name === "Detached title") break;
					if (attempt === 49) throw new Error("Timed out waiting for reattached automatic naming");
					await new Promise((resolve) => setTimeout(resolve, 10));
				}
				expect(reattached.snapshot?.nameSource).toBe("generated");
				expect((await reattached.readUsage({ sessionId, purpose: "sessionName" })).entries).toHaveLength(1);
			} finally {
				await reattached.dispose();
			}
		} finally {
			client.dispose();
			await runtime.close();
		}
	});
});

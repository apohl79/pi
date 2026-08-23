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

describe("production remote v2 naming safety", () => {
	test("replaces secret-shaped generated output with a safe generic title", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-remote-name-safety-"));
		directories.push(directory);
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-remote-name-safety-faux",
			models: [{ id: "session-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		models.setProvider(faux.provider);
		faux.setResponses([
			fauxAssistantMessage("turn complete"),
			fauxAssistantMessage("api_key=secret-value leaked title"),
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
			const session = await RemoteV2Session.create(client, { cwd: directory }, { mode: "control" });
			try {
				const operation = await session.submit("name this task");
				await session.waitForOperation(operation);
				for (let attempt = 0; attempt < 50; attempt++) {
					await session.refresh();
					if (session.snapshot?.name === "Untitled session") break;
					if (attempt === 49) throw new Error("Timed out waiting for safe generated naming");
					await new Promise((resolve) => setTimeout(resolve, 10));
				}
				expect(session.snapshot).toMatchObject({ name: "Untitled session", nameSource: "generated" });
			} finally {
				await session.dispose();
			}
		} finally {
			client.dispose();
			await runtime.close();
		}
	});
});

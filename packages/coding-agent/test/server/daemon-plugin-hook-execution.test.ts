import { access, mkdtemp, rm } from "node:fs/promises";
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

describe("production daemon plugin hook execution", () => {
	test("executes an enabled turn hook in the server execution environment", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-daemon-plugin-hook-execution-"));
		directories.push(directory);
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-daemon-plugin-hook-execution-faux",
			models: [
				{
					id: "coding-agent-daemon-plugin-hook-execution-model",
					reasoning: false,
					contextWindow: 32_000,
					maxTokens: 1_000,
				},
			],
		});
		models.setProvider(faux.provider);
		faux.setResponses([fauxAssistantMessage("hooked response")]);
		const runtime = await createConfiguredCodingAgentDaemonRuntime({
			agentDir: directory,
			cwd: directory,
			models,
			model: faux.getModel(),
			socketPath: join(directory, "server.sock"),
			write: () => {},
		});
		const client = new PiClientV2({
			transportFactory: createUnixTransportFactory({ path: join(directory, "server.sock") }),
		});
		try {
			await runtime.daemon.start();
			await client.connect();
			await client.request({
				command: "marketplace/add",
				payload: { name: "local", source: "file:///tmp/marketplace" },
			});
			await client.request({
				command: "plugin/install",
				payload: {
					name: "hook-plugin",
					marketplace: "local",
					version: "1.0.0",
					manifest: {
						name: "hook-plugin",
						version: "1.0.0",
						hooks: [{ event: "turn/accepted", command: "touch hook-fired" }],
					},
				},
			});
			const session = await RemoteV2Session.create(client, { cwd: directory }, { mode: "control" });
			try {
				const operationId = await session.submit("run the hook");
				await session.waitForOperation(operationId);
				await expect(access(join(directory, "hook-fired"))).resolves.toBeUndefined();
			} finally {
				await session.dispose();
			}
		} finally {
			client.dispose();
			await runtime.close();
		}
	});
});

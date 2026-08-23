import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { PiClientV2 } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";
import { afterEach, describe, expect, test } from "vitest";
import { createConfiguredCodingAgentDaemonRuntime } from "../../src/server/daemon-runtime.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("coding-agent daemon remote plugin acquisition", () => {
	test("routes an npm marketplace entry through the injected adapter", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-daemon-remote-plugin-"));
		const packageRoot = await mkdtemp(join(tmpdir(), "pi-daemon-remote-plugin-package-"));
		directories.push(directory, packageRoot);
		await mkdir(join(packageRoot, ".codex-plugin"), { recursive: true });
		await writeFile(
			join(packageRoot, ".codex-plugin", "plugin.json"),
			JSON.stringify({ name: "remote-reviewer", version: "1.0.0", skills: [], commands: [] }),
		);
		const marketplace = join(directory, "marketplace");
		await mkdir(join(marketplace, ".agents", "plugins"), { recursive: true });
		await writeFile(
			join(marketplace, ".agents", "plugins", "marketplace.json"),
			JSON.stringify({ plugins: [{ name: "remote-reviewer", source: "npm:@example/remote-reviewer" }] }),
		);

		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-daemon-remote-plugin-faux",
			models: [
				{
					id: "coding-agent-daemon-remote-plugin-model",
					reasoning: false,
					contextWindow: 32_000,
					maxTokens: 1_000,
				},
			],
		});
		models.setProvider(faux.provider);
		faux.setResponses([fauxAssistantMessage("installed")]);
		const sources: string[] = [];
		const runtime = await createConfiguredCodingAgentDaemonRuntime({
			agentDir: directory,
			cwd: directory,
			models,
			model: faux.getModel(),
			socketPath: join(directory, "server.sock"),
			pluginAcquisition: {
				npm: async (source) => {
					sources.push(source);
					return packageRoot;
				},
			},
			harness: { tools: [], activeToolNames: [] },
			write: () => {},
		});
		const client = new PiClientV2({
			transportFactory: createUnixTransportFactory({ path: join(directory, "server.sock") }),
		});
		try {
			await runtime.daemon.start();
			await client.connect();
			await client.request({ command: "marketplace/add", payload: { name: "remote", source: marketplace } });
			const installed = await client.request({
				command: "plugin/install",
				payload: { name: "remote-reviewer", marketplace: "remote", version: "1.0.0", scope: "project" },
			});
			expect(sources).toEqual(["npm:@example/remote-reviewer"]);
			expect(installed).toMatchObject({
				ok: true,
				result: { plugin: { id: "remote-reviewer@remote", version: "1.0.0", provenance: "package" } },
			});
		} finally {
			client.dispose();
			await runtime.close();
		}
	});
});

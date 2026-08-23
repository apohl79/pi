import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { PiClientV2 } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";
import { afterEach, describe, expect, test } from "vitest";
import { createConfiguredCodingAgentDaemonRuntime } from "../../src/server/daemon-runtime.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("coding-agent daemon marketplace upgrade failures", () => {
	test("keeps the previous package active when the acquired upgrade is invalid", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-daemon-plugin-upgrade-failure-"));
		const marketplace = await mkdtemp(join(tmpdir(), "pi-daemon-plugin-upgrade-failure-marketplace-"));
		directories.push(directory, marketplace);
		const pluginRoot = join(marketplace, "plugins", "reviewer");
		await mkdir(join(pluginRoot, ".codex-plugin"), { recursive: true });
		await mkdir(join(pluginRoot, "skills", "review"), { recursive: true });
		await writeFile(join(pluginRoot, "skills", "review", "SKILL.md"), "# Review\n");
		await writeFile(
			join(pluginRoot, ".codex-plugin", "plugin.json"),
			JSON.stringify({ name: "reviewer", version: "1.0.0", skills: ["skills/review"] }),
		);
		await mkdir(join(marketplace, ".agents", "plugins"), { recursive: true });
		await writeFile(
			join(marketplace, ".agents", "plugins", "marketplace.json"),
			JSON.stringify({ plugins: [{ name: "reviewer", source: "plugins/reviewer" }] }),
		);
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-daemon-plugin-upgrade-failure-faux",
			models: [
				{
					id: "coding-agent-daemon-plugin-upgrade-failure-model",
					reasoning: false,
					contextWindow: 32_000,
					maxTokens: 1_000,
				},
			],
		});
		models.setProvider(faux.provider);
		const runtime = await createConfiguredCodingAgentDaemonRuntime({
			agentDir: directory,
			cwd: directory,
			models,
			model: faux.getModel(),
			socketPath: join(directory, "server.sock"),
			pluginAcquisition: {},
			harness: { tools: [], activeToolNames: [] },
			write: () => {},
		});
		const client = new PiClientV2({
			transportFactory: createUnixTransportFactory({ path: join(directory, "server.sock") }),
		});
		try {
			await runtime.daemon.start();
			await client.connect();
			await client.request({ command: "marketplace/add", payload: { name: "local", source: marketplace } });
			const installed = await client.request({
				command: "plugin/install",
				payload: { name: "reviewer", marketplace: "local", version: "1.0.0", scope: "project" },
			});
			expect(installed).toMatchObject({ ok: true, result: { plugin: { version: "1.0.0" } } });
			await writeFile(
				join(pluginRoot, ".codex-plugin", "plugin.json"),
				JSON.stringify({ name: "reviewer", version: "2.0.0", skills: ["skills/missing"] }),
			);
			const upgraded = await client.request({
				command: "plugin/upgrade",
				payload: { id: "reviewer@local", version: "2.0.0" },
			});
			expect(upgraded).toMatchObject({ ok: false });
			expect(await client.request({ command: "plugin/read", payload: { id: "reviewer@local" } })).toMatchObject({
				ok: true,
				result: { plugin: { version: "1.0.0", enabled: true, resources: { skills: ["skills/review"] } } },
			});
		} finally {
			client.dispose();
			await runtime.close();
		}
	});
});

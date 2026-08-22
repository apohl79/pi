import { mkdtemp, rm } from "node:fs/promises";
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

describe("coding-agent daemon plugin hooks", () => {
	test("persists normalized hook descriptors and enablement", async () => {
		const result = await runPluginHooksScenario();
		expect(result.installed).toMatchObject({
			ok: true,
			result: {
				plugin: {
					hookDescriptors: [{ id: "hooks-plugin@local:hook-0", event: "turn/accepted", command: "audit" }],
				},
			},
		});
		expect(result.disabled).toMatchObject({
			ok: true,
			result: { plugin: { hookDescriptors: [{ id: "hooks-plugin@local:hook-0", enabled: false }] } },
		});
	});
});

async function runPluginHooksScenario(): Promise<{ installed: unknown; disabled: unknown }> {
	const directory = await mkdtemp(join(tmpdir(), "pi-daemon-plugin-hooks-"));
	directories.push(directory);
	const models = createModels();
	const faux = fauxProvider({
		provider: "coding-agent-daemon-plugin-hooks-faux",
		models: [
			{ id: "coding-agent-daemon-plugin-hooks-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 },
		],
	});
	models.setProvider(faux.provider);
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
		await client.request({
			command: "marketplace/add",
			payload: { name: "local", source: "file:///tmp/marketplace" },
		});
		const installed = await client.request({
			command: "plugin/install",
			payload: {
				name: "hooks-plugin",
				marketplace: "local",
				version: "1.0.0",
				manifest: {
					name: "hooks-plugin",
					version: "1.0.0",
					hooks: [{ event: "turn/accepted", command: "audit" }],
				},
			},
		});
		const disabled = await client.request({ command: "plugin/disable", payload: { id: "hooks-plugin@local" } });
		return { installed, disabled };
	} finally {
		client.dispose();
		await runtime.close();
	}
}

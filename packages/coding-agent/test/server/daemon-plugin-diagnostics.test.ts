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

describe("coding-agent daemon plugin diagnostics", () => {
	test("returns an explicit unsupported MCP warning without disabling other resources", async () => {
		const result = await runPluginDiagnosticsScenario();
		expect(result).toMatchObject({
			ok: true,
			result: {
				plugin: {
					resources: { skills: ["skills/review"] },
					diagnostics: [
						{
							code: "unsupported_mcp_resource",
							severity: "warning",
							message: "MCP resources are not started by Pi; supported plugin resources may still activate",
						},
					],
				},
			},
		});
	});
});

async function runPluginDiagnosticsScenario(): Promise<unknown> {
	const directory = await mkdtemp(join(tmpdir(), "pi-daemon-plugin-diagnostics-"));
	directories.push(directory);
	const models = createModels();
	const faux = fauxProvider({
		provider: "coding-agent-daemon-plugin-diagnostics-faux",
		models: [
			{
				id: "coding-agent-daemon-plugin-diagnostics-model",
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
		await client.request({
			command: "plugin/install",
			payload: {
				name: "diagnostics-plugin",
				marketplace: "local",
				version: "1.0.0",
				manifest: {
					name: "diagnostics-plugin",
					version: "1.0.0",
					skills: ["skills/review"],
					mcpServers: { local: { command: "not-started" } },
				},
			},
		});
		return await client.request({ command: "plugin/read", payload: { id: "diagnostics-plugin@local" } });
	} finally {
		client.dispose();
		await runtime.close();
	}
}

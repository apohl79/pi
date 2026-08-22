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

describe("coding-agent daemon plugin apps", () => {
	test("projects installed plugin apps through app/list and app/read", async () => {
		const result = await runPluginAppsScenario();
		expect(result.listed).toMatchObject({
			ok: true,
			result: {
				apps: [{ id: "calendar-plugin@local:calendar", name: "Calendar", auth: "unauthenticated", enabled: true }],
			},
		});
		expect(result.read).toMatchObject({
			ok: true,
			result: { app: { id: "calendar-plugin@local:calendar", name: "Calendar", description: "Plugin calendar" } },
		});
	});
});

async function runPluginAppsScenario(): Promise<{ listed: unknown; read: unknown }> {
	const directory = await mkdtemp(join(tmpdir(), "pi-daemon-plugin-apps-"));
	directories.push(directory);
	const models = createModels();
	const faux = fauxProvider({
		provider: "coding-agent-daemon-plugin-apps-faux",
		models: [
			{ id: "coding-agent-daemon-plugin-apps-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 },
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
				name: "calendar-plugin",
				marketplace: "local",
				version: "1.0.0",
				manifest: {
					name: "calendar-plugin",
					version: "1.0.0",
					apps: [{ id: "calendar", name: "Calendar", description: "Plugin calendar", auth: "unauthenticated" }],
				},
			},
		});
		const listed = await client.request({ command: "app/list" });
		const read = await client.request({ command: "app/read", payload: { id: "calendar-plugin@local:calendar" } });
		return { listed, read };
	} finally {
		client.dispose();
		await runtime.close();
	}
}

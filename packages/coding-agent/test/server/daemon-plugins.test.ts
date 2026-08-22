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

async function createPluginRuntime(directory: string) {
	const models = createModels();
	const faux = fauxProvider({
		provider: "coding-agent-daemon-plugins-faux",
		models: [{ id: "coding-agent-daemon-plugins-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
	});
	models.setProvider(faux.provider);
	return createConfiguredCodingAgentDaemonRuntime({
		agentDir: directory,
		cwd: directory,
		models,
		model: faux.getModel(),
		socketPath: join(directory, "server.sock"),
		harness: { tools: [], activeToolNames: [] },
		write: () => {},
	});
}

async function connect(directory: string): Promise<PiClientV2> {
	const client = new PiClientV2({
		transportFactory: createUnixTransportFactory({ path: join(directory, "server.sock") }),
	});
	await client.connect();
	return client;
}

const manifest = {
	name: "reviewer",
	version: "1.2.0",
	skills: ["skills/review"],
	commands: ["commands/review"],
	interface: {
		displayName: "Review Assistant",
		description: "Reviews repository changes",
		developer: "Pi Team",
		category: "development",
		capabilities: ["review"],
		websiteUrl: "https://example.test/reviewer",
		defaultPrompts: ["Review this change"],
		colors: { primary: "#123456" },
		icons: { light: "icon-light.svg", dark: "icon-dark.svg" },
		logos: ["logo.svg"],
		screenshots: ["screen.png"],
	},
	context: {
		sampling: [{ id: "reminder", slot: "contextual_user", position: "supplement", text: "Check project context" }],
	},
};

async function installPlugin(client: PiClientV2): Promise<void> {
	await client.request({
		command: "marketplace/add",
		payload: { name: "local", source: "file:///tmp/local-marketplace" },
	});
	await client.request({
		command: "plugin/install",
		payload: { name: "reviewer", marketplace: "local", version: "1.2.0", scope: "project", manifest },
	});
}

describe("coding-agent daemon plugin lifecycle", () => {
	test("installs, toggles, and reads a plugin through the production daemon", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-daemon-plugins-"));
		directories.push(directory);
		const first = await createPluginRuntime(directory);
		const firstClient = await connectAfterStart(first, directory);
		try {
			await installPlugin(firstClient);
			const installed = await firstClient.request({ command: "plugin/read", payload: { id: "reviewer@local" } });
			expect(installed).toMatchObject({
				ok: true,
				result: {
					plugin: {
						id: "reviewer@local",
						enabled: true,
						scope: "project",
						resources: { skills: ["skills/review"], commands: ["commands/review"] },
						interface: manifest.interface,
						sampling: [{ id: "reminder", position: "supplement" }],
					},
				},
			});
			const disabled = await firstClient.request({
				command: "plugin/disable",
				payload: { id: "reviewer@local", scope: "project" },
			});
			expect(disabled).toMatchObject({ ok: true, result: { plugin: { enabled: false, scope: "project" } } });
			const enabled = await firstClient.request({ command: "plugin/enable", payload: { id: "reviewer@local" } });
			expect(enabled).toMatchObject({ ok: true, result: { plugin: { enabled: true } } });
		} finally {
			firstClient.dispose();
			await first.close();
		}
	});

	test("restores and removes plugin state through a production daemon restart", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-daemon-plugins-restart-"));
		directories.push(directory);
		const first = await createPluginRuntime(directory);
		const firstClient = await connectAfterStart(first, directory);
		await installPlugin(firstClient);
		firstClient.dispose();
		await first.close();
		const second = await createPluginRuntime(directory);
		const secondClient = await connectAfterStart(second, directory);
		try {
			const listed = await secondClient.request({ command: "plugin/list", payload: { installedOnly: true } });
			expect(listed).toMatchObject({ ok: true, result: { plugins: [{ id: "reviewer@local", enabled: true }] } });
			const upgraded = await secondClient.request({
				command: "plugin/upgrade",
				payload: {
					id: "reviewer@local",
					version: "2",
					manifest: { skills: ["new-skill"], commands: ["new-command"] },
				},
			});
			expect(upgraded).toMatchObject({
				ok: true,
				result: { plugin: { version: "2", resources: { skills: ["new-skill"], commands: ["new-command"] } } },
			});
			await secondClient.request({ command: "plugin/uninstall", payload: { id: "reviewer@local" } });
			await secondClient.request({ command: "marketplace/remove", payload: { name: "local" } });
			expect(await secondClient.request({ command: "plugin/list" })).toMatchObject({
				ok: true,
				result: { plugins: [] },
			});
		} finally {
			secondClient.dispose();
			await second.close();
		}
	});
});

async function connectAfterStart(
	runtime: Awaited<ReturnType<typeof createPluginRuntime>>,
	directory: string,
): Promise<PiClientV2> {
	await runtime.daemon.start();
	return connect(directory);
}

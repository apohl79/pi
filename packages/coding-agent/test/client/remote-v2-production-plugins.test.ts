import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { PiClientV2 } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";
import { InMemoryV2PluginRegistry } from "@earendil-works/pi-server";
import { afterEach, describe, expect, test } from "vitest";
import { RemoteV2InteractiveAttachment, RemoteV2Session, RemoteV2SessionSelector } from "../../src/index.ts";
import { createConfiguredCodingAgentDaemonRuntime } from "../../src/server/daemon-runtime.ts";

const directories: string[] = [];
const manifest = { name: "reviewer", version: "1.2.0", skills: ["skills/review"], commands: ["commands/review"] };

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("production remote v2 plugin commands", () => {
	test("runs the marketplace and plugin lifecycle through RemoteV2Session", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-remote-plugin-lifecycle-"));
		directories.push(directory);
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-remote-plugin-lifecycle-faux",
			models: [{ id: "remote-plugin-lifecycle-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		models.setProvider(faux.provider);
		const socketPath = join(directory, "server.sock");
		const runtime = await createConfiguredCodingAgentDaemonRuntime({
			agentDir: directory,
			cwd: directory,
			models,
			model: faux.getModel(),
			socketPath,
			pluginRegistry: new InMemoryV2PluginRegistry(),
			harness: { tools: [], activeToolNames: [] },
			write: () => {},
		});
		const client = new PiClientV2({ transportFactory: createUnixTransportFactory({ path: socketPath }) });
		try {
			await runtime.daemon.start();
			await client.connect();
			const session = await RemoteV2Session.create(client, { cwd: directory }, { mode: "control" });
			try {
				expect(await session.listMarketplaces()).toEqual([]);
				expect(await session.addMarketplace("local", "/workspace/plugins")).toMatchObject({ name: "local" });
				const installed = await session.installPlugin({
					name: manifest.name,
					marketplace: "local",
					version: manifest.version,
					manifest,
					scope: "project",
				});
				expect(installed).toMatchObject({ id: "reviewer@local", version: "1.2.0", enabled: true });
				expect(await session.readPlugin("reviewer@local")).toMatchObject({ id: "reviewer@local" });
				expect(await session.setPluginEnabled("reviewer@local", false, "project")).toMatchObject({
					enabled: false,
					scope: "project",
				});
				expect(
					await session.upgradePlugin("reviewer@local", "2.0.0", {
						manifest: { ...manifest, version: "2.0.0" },
					}),
				).toMatchObject({
					version: "2.0.0",
				});
				await session.uninstallPlugin("reviewer@local");
				await session.removeMarketplace("local");
				expect(await session.listPlugins(true)).toEqual([]);
			} finally {
				await session.dispose();
			}
		} finally {
			client.dispose();
			await runtime.close();
		}
	});

	test("preserves supported resources and reports unsupported MCP declarations", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-remote-plugin-compatibility-"));
		directories.push(directory);
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-remote-plugin-compatibility-faux",
			models: [
				{ id: "remote-plugin-compatibility-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 },
			],
		});
		models.setProvider(faux.provider);
		const socketPath = join(directory, "server.sock");
		const runtime = await createConfiguredCodingAgentDaemonRuntime({
			agentDir: directory,
			cwd: directory,
			models,
			model: faux.getModel(),
			socketPath,
			pluginRegistry: new InMemoryV2PluginRegistry(),
			harness: { tools: [], activeToolNames: [] },
			write: () => {},
		});
		const client = new PiClientV2({ transportFactory: createUnixTransportFactory({ path: socketPath }) });
		try {
			await runtime.daemon.start();
			await client.connect();
			const session = await RemoteV2Session.create(client, { cwd: directory }, { mode: "control" });
			try {
				await session.addMarketplace("local", "/workspace/plugins");
				const plugin = await session.installPlugin({
					name: "compatibility",
					marketplace: "local",
					version: "1.0.0",
					manifest: {
						name: "compatibility",
						version: "1.0.0",
						skills: ["skills/review"],
						commands: ["commands/review"],
						apps: [{ id: "tracker", name: "Tracker", auth: "authenticated" }],
						hooks: [{ event: "afterTurn", command: "hooks/after-turn" }],
						mcpServers: { tracker: { command: "tracker-mcp" } },
						context: {
							thread: [
								{ id: "thread-policy", slot: "developer_policy", position: "preamble", text: "Persist this" },
							],
							sampling: [
								{ id: "sample-reminder", slot: "contextual_user", position: "supplement", text: "Per request" },
							],
						},
					},
				});
				expect(plugin).toMatchObject({
					resources: { skills: ["skills/review"], commands: ["commands/review"], apps: 1, hooks: 1 },
					appDescriptors: [expect.objectContaining({ id: "compatibility@local:tracker", auth: "authenticated" })],
					hookDescriptors: [expect.objectContaining({ event: "afterTurn", enabled: true })],
					threadContext: [expect.objectContaining({ id: "thread-policy", text: "Persist this" })],
					sampling: [expect.objectContaining({ id: "sample-reminder", text: "Per request" })],
					diagnostics: [expect.objectContaining({ code: "unsupported_mcp_resource" })],
				});
			} finally {
				await session.dispose();
			}
		} finally {
			client.dispose();
			await runtime.close();
		}
	});

	test("lists installed plugins through /plugins", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-remote-plugins-"));
		directories.push(directory);
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-remote-plugins-faux",
			models: [{ id: "remote-plugins-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		models.setProvider(faux.provider);
		const socketPath = join(directory, "server.sock");
		const runtime = await createConfiguredCodingAgentDaemonRuntime({
			agentDir: directory,
			cwd: directory,
			models,
			model: faux.getModel(),
			socketPath,
			harness: { tools: [], activeToolNames: [] },
			write: () => {},
		});
		const client = new PiClientV2({ transportFactory: createUnixTransportFactory({ path: socketPath }) });
		try {
			await runtime.daemon.start();
			await client.connect();
			await client.request({
				command: "marketplace/add",
				payload: { name: "local", source: "file:///tmp/local-marketplace" },
			});
			await client.request({
				command: "plugin/install",
				payload: {
					name: manifest.name,
					marketplace: "local",
					version: manifest.version,
					scope: "project",
					manifest,
				},
			});
			const created = await client.request({ command: "session/create", payload: { cwd: directory } });
			const sessionId = (created as unknown as { result: { session: { id: string } } }).result.session.id;
			const attachment = await new RemoteV2SessionSelector(client).attachView(sessionId, { mode: "control" });
			const adapter = new RemoteV2InteractiveAttachment(attachment);
			try {
				expect(await adapter.execute("/plugins")).toEqual({ kind: "status", text: "reviewer@local" });
			} finally {
				await adapter.dispose();
			}
		} finally {
			client.dispose();
			await runtime.close();
		}
	});
});

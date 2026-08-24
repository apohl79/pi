import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Context, createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { PiClientV2 } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";
import { afterEach, describe, expect, test } from "vitest";
import { createConfiguredCodingAgentDaemonRuntime } from "../../src/server/daemon-runtime.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const pluginName = "reviewer";

async function waitForIdle(client: PiClientV2, sessionId: string): Promise<void> {
	for (let attempt = 0; attempt < 50; attempt++) {
		const snapshot = await client.request({ command: "session/read", sessionId });
		if (snapshot.ok && "result" in snapshot) {
			const session = (snapshot.result as { session: { phase: string } }).session;
			if (session.phase === "idle") return;
			if (session.phase === "failed") throw new Error(`Daemon turn failed: ${JSON.stringify(snapshot.result)}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("Timed out waiting for daemon turn completion");
}

async function writePlugin(root: string, version: string, context: string): Promise<void> {
	await mkdir(join(root, ".codex-plugin"), { recursive: true });
	await mkdir(join(root, "skills", "review"), { recursive: true });
	await mkdir(join(root, "commands"), { recursive: true });
	await writeFile(
		join(root, ".codex-plugin", "plugin.json"),
		JSON.stringify({
			name: pluginName,
			version,
			skills: ["skills/review"],
			commands: ["commands/review"],
			context: { sampling: [{ id: "reminder", slot: "contextual_user", position: "supplement", text: context }] },
		}),
	);
	await writeFile(join(root, "skills", "review", "SKILL.md"), `# ${version} review\n`);
	await writeFile(join(root, "commands", "review"), `Review ${version}\n`);
}

describe("coding-agent daemon marketplace plugin upgrades", () => {
	test("re-resolves and activates the marketplace package for the next turn", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-daemon-plugin-upgrade-"));
		const marketplace = await mkdtemp(join(tmpdir(), "pi-daemon-plugin-upgrade-marketplace-"));
		directories.push(directory, marketplace);
		const pluginRoot = join(marketplace, "plugins", pluginName);
		await writePlugin(pluginRoot, "1.0.0", "Use version one");
		await mkdir(join(marketplace, ".agents", "plugins"), { recursive: true });
		await writeFile(
			join(marketplace, ".agents", "plugins", "marketplace.json"),
			JSON.stringify({ plugins: [{ name: pluginName, source: `plugins/${pluginName}` }] }),
		);

		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-daemon-plugin-upgrade-faux",
			models: [
				{
					id: "coding-agent-daemon-plugin-upgrade-model",
					reasoning: false,
					contextWindow: 32_000,
					maxTokens: 1_000,
				},
			],
		});
		models.setProvider(faux.provider);
		const observed: string[][] = [];
		const recordResponse = (context: Context) => {
			observed.push(
				context.messages.flatMap((message) =>
					message.role === "user" && typeof message.content === "string" ? [message.content] : [],
				),
			);
			return fauxAssistantMessage("done");
		};
		faux.setResponses([recordResponse, recordResponse, recordResponse, recordResponse]);
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
				payload: { name: pluginName, marketplace: "local", version: "1.0.0", scope: "project" },
			});
			expect(installed).toMatchObject({ ok: true, result: { plugin: { version: "1.0.0", provenance: "package" } } });
			const created = await client.request({ command: "session/create", payload: { cwd: directory } });
			if (!created.ok || !("result" in created)) throw new Error("Session creation failed");
			const sessionId = (created.result as { session: { id: string } }).session.id;
			await client.request({ command: "session/attach", sessionId, payload: { mode: "control" } });
			await client.request({ command: "turn/start", sessionId, payload: { text: "before upgrade" } });
			await waitForIdle(client, sessionId);

			await writePlugin(pluginRoot, "2.0.0", "Use version two");
			const upgraded = await client.request({
				command: "plugin/upgrade",
				payload: { id: `${pluginName}@local`, version: "2.0.0" },
			});
			expect(upgraded).toMatchObject({
				ok: true,
				result: {
					plugin: { version: "2.0.0", provenance: "package", root: expect.stringContaining("plugins-cache") },
				},
			});
			await client.request({ command: "turn/start", sessionId, payload: { text: "after upgrade" } });
			await waitForIdle(client, sessionId);
			expect(observed).toHaveLength(4);
			expect(observed.slice(0, 2).flat()).toContain("Use version one");
			expect(observed.slice(0, 2).flat()).not.toContain("Use version two");
			expect(observed.slice(2).flat()).toContain("Use version two");
			expect(observed.slice(2).flat()).not.toContain("Use version one");
		} finally {
			client.dispose();
			await runtime.close();
		}
	});
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { PiClientV2 } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";
import { afterEach, describe, expect, test } from "vitest";
import { parseCodexPluginManifest } from "../../src/core/codex-plugin.ts";
import { createConfiguredCodingAgentDaemonRuntime } from "../../src/server/daemon-runtime.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const manifest = {
	name: "representative-plugin",
	version: "1.0.0",
	skills: ["skills/review"],
	commands: ["commands/review"],
	apps: [{ id: "calendar" }],
	hooks: [{ event: "turn" }],
	context: {
		sampling: [{ id: "reminder", slot: "contextual_user", position: "supplement", text: "Use the plugin context" }],
	},
	mcpServers: { local: { command: "not-started" } },
};

async function waitForIdle(client: PiClientV2, sessionId: string): Promise<readonly unknown[]> {
	for (let attempt = 0; attempt < 50; attempt++) {
		const snapshot = await client.request({ command: "session/read", sessionId });
		if (snapshot.ok && "result" in snapshot) {
			const session = (snapshot.result as unknown as { session: { phase: string; transcript: readonly unknown[] } })
				.session;
			if (session.phase === "idle") return session.transcript;
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("Timed out waiting for daemon turn completion");
}

describe("coding-agent daemon plugin compatibility", () => {
	test("projects representative resources and sampling through the production daemon", async () => {
		const result = await runPluginCompatibilityScenario();
		expect(result.installed).toMatchObject({
			ok: true,
			result: {
				plugin: {
					resources: { skills: ["skills/review"], commands: ["commands/review"], apps: 1, hooks: 1 },
					sampling: [{ id: "reminder", position: "supplement" }],
				},
			},
		});
		expect(parseCodexPluginManifest(manifest).diagnostics).toContainEqual({
			code: "unsupported_mcp_resource",
			severity: "warning",
			message: "MCP resources are not started by Pi; supported plugin resources may still activate",
		});
		expect(result.observedRequests).toEqual([expect.arrayContaining(["Use the plugin context"])]);
		expect(JSON.stringify(result.transcript)).not.toContain("Use the plugin context");
	});
});

async function runPluginCompatibilityScenario(): Promise<{
	installed: unknown;
	observedRequests: readonly (readonly string[])[];
	transcript: readonly unknown[];
}> {
	const directory = await mkdtemp(join(tmpdir(), "pi-daemon-plugin-compatibility-"));
	directories.push(directory);
	const observedRequests: string[][] = [];
	const models = createModels();
	const faux = fauxProvider({
		provider: "coding-agent-daemon-plugin-compatibility-faux",
		models: [
			{
				id: "coding-agent-daemon-plugin-compatibility-model",
				reasoning: false,
				contextWindow: 32_000,
				maxTokens: 1_000,
			},
		],
	});
	models.setProvider(faux.provider);
	faux.setResponses([
		(context) => {
			observedRequests.push(
				context.messages.flatMap((message) =>
					message.role === "user" && typeof message.content === "string" ? [message.content] : [],
				),
			);
			return fauxAssistantMessage("plugin-compatible response");
		},
	]);
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
			payload: { name: "local", source: "file:///tmp/local-marketplace" },
		});
		const installed = await client.request({
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
		expect(created).toMatchObject({ ok: true, result: { session: { id: expect.any(String) } } });
		if (!created.ok || !("result" in created)) throw new Error("Session creation failed");
		const sessionId = (created.result as { session: { id: string } }).session.id;
		await client.request({ command: "session/attach", sessionId, payload: { mode: "control" } });
		await client.request({ command: "turn/start", sessionId, payload: { text: "review this change" } });
		const transcript = await waitForIdle(client, sessionId);
		return { installed, observedRequests, transcript };
	} finally {
		client.dispose();
		await runtime.close();
	}
}

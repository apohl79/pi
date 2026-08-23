import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Context, createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { PiClientV2 } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";
import { afterEach, describe, expect, test } from "vitest";
import { RemoteV2Session } from "../../src/client/remote-v2-session.ts";
import { parseCodexPluginManifest } from "../../src/core/codex-plugin.ts";
import { createConfiguredCodingAgentDaemonRuntime } from "../../src/server/daemon-runtime.ts";

const directories: string[] = [];
const threadText = "combined plugin thread context";
const samplingText = "combined plugin sampling context";

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("coding-agent daemon plugin end-to-end compatibility", () => {
	test("exercises every supported resource while leaving MCP inactive", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-daemon-plugin-e2e-"));
		directories.push(directory);
		const pluginRoot = join(directory, "plugin");
		await mkdir(join(pluginRoot, "skills", "review"), { recursive: true });
		await mkdir(join(pluginRoot, "commands"), { recursive: true });
		await writeFile(
			join(pluginRoot, "skills", "review", "SKILL.md"),
			"---\nname: review\ndescription: Review changes\n---\nInspect the diff carefully.",
		);
		await writeFile(
			join(pluginRoot, "commands", "review.md"),
			"---\ndescription: Review changes\n---\nReview $ARGUMENTS",
		);
		const manifest = {
			name: "combined-plugin",
			version: "1.0.0",
			skills: ["skills/review"],
			commands: ["commands/review.md"],
			apps: [{ id: "calendar", name: "Calendar", description: "Plugin calendar", auth: "unauthenticated" }],
			hooks: [{ event: "turn/accepted", command: "touch combined-hook" }],
			context: {
				thread: [{ id: "thread", slot: "developer_policy", position: "preamble", text: threadText }],
				sampling: [{ id: "sampling", slot: "contextual_user", position: "supplement", text: samplingText }],
			},
			mcpServers: { local: { command: "not-started" } },
		};
		const observed: Context[] = [];
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-daemon-plugin-e2e-faux",
			models: [{ id: "plugin-e2e-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		models.setProvider(faux.provider);
		faux.setResponses([
			(context) => {
				observed.push(context);
				return fauxAssistantMessage("command resource exercised");
			},
			(context) => {
				observed.push(context);
				return fauxAssistantMessage("app resource exercised");
			},
		]);
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
				payload: { name: "local", source: "file:///tmp/marketplace" },
			});
			const installed = await client.request({
				command: "plugin/install",
				payload: {
					name: manifest.name,
					marketplace: "local",
					version: manifest.version,
					root: pluginRoot,
					manifest,
				},
			});
			expect(installed).toMatchObject({
				ok: true,
				result: {
					plugin: {
						resources: { skills: ["skills/review"], commands: ["commands/review.md"], apps: 1, hooks: 1 },
					},
				},
			});
			expect(parseCodexPluginManifest(manifest).diagnostics).toContainEqual(
				expect.objectContaining({ code: "unsupported_mcp_resource", severity: "warning" }),
			);
			expect(await client.request({ command: "app/list" })).toMatchObject({
				ok: true,
				result: { apps: [{ id: "combined-plugin@local:calendar", enabled: true }] },
			});
			const session = await RemoteV2Session.create(client, { cwd: directory }, { mode: "control" });
			try {
				const namingOperation = await session.setAutoName(false);
				await session.waitForOperation(namingOperation);
				const commandOperation = await session.submit("/combined-plugin@local:review changed files");
				await session.waitForOperation(commandOperation);
				const appOperation = await session.submit([
					{ type: "text", text: "Inspect this connector" },
					{ type: "mention", name: "Calendar", path: "app://combined-plugin@local:calendar" },
				]);
				await session.waitForOperation(appOperation);
				await access(join(directory, "combined-hook"));
			} finally {
				await session.dispose();
			}
		} finally {
			client.dispose();
			await runtime.close();
		}
		expect(observed).toHaveLength(2);
		for (const context of observed) {
			expect(JSON.stringify(context)).toContain(threadText);
			expect(
				context.messages.some(
					(message) =>
						message.role === "user" &&
						typeof message.content === "string" &&
						message.content.includes(samplingText),
				),
			).toBe(true);
		}
		expect(JSON.stringify(observed)).toContain("Review changed files");
		expect(JSON.stringify(observed)).toContain("@Calendar");
	});
});

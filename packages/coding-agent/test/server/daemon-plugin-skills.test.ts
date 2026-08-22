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

describe("coding-agent daemon plugin skills", () => {
	test("loads enabled plugin skills into the model system prompt", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-daemon-plugin-skills-"));
		directories.push(directory);
		const pluginRoot = join(directory, "plugin");
		await mkdir(join(pluginRoot, "skills", "review"), { recursive: true });
		await writeFile(
			join(pluginRoot, "skills", "review", "SKILL.md"),
			"---\nname: review\ndescription: Review changes\n---\nInspect the diff carefully.",
		);
		const models = createModels();
		let systemPrompt = "";
		const faux = fauxProvider({
			provider: "coding-agent-daemon-plugin-skills-faux",
			models: [{ id: "plugin-skills-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		models.setProvider(faux.provider);
		faux.setResponses([
			(context: Context) => {
				systemPrompt = context.systemPrompt ?? "";
				return fauxAssistantMessage("skill response");
			},
		]);
		const runtime = await createConfiguredCodingAgentDaemonRuntime({
			agentDir: directory,
			cwd: directory,
			models,
			model: faux.getModel(),
			socketPath: join(directory, "server.sock"),
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
					name: "review-plugin",
					marketplace: "local",
					version: "1.0.0",
					root: pluginRoot,
					manifest: { name: "review-plugin", version: "1.0.0", skills: ["skills/review"] },
				},
			});
			const sessionId = await createSession(client, directory);
			await client.request({ command: "turn/start", sessionId, payload: { text: "review" } });
			await waitForIdle(client, sessionId);
			expect(systemPrompt).toContain("review-plugin@local:review");
			expect(systemPrompt).toContain("Review changes");
		} finally {
			client.dispose();
			await runtime.close();
		}
	});
});

async function createSession(client: PiClientV2, directory: string): Promise<string> {
	const created = await client.request({ command: "session/create", payload: { cwd: directory } });
	if (!created.ok || !("result" in created)) throw new Error("Session creation failed");
	const sessionId = (created.result as { session: { id: string } }).session.id;
	await client.request({ command: "session/attach", sessionId, payload: { mode: "control" } });
	return sessionId;
}

async function waitForIdle(client: PiClientV2, sessionId: string): Promise<void> {
	for (let attempt = 0; attempt < 50; attempt++) {
		const snapshot = await client.request({ command: "session/read", sessionId });
		if (
			snapshot.ok &&
			"result" in snapshot &&
			(snapshot.result as { session: { phase: string } }).session.phase === "idle"
		)
			return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("Timed out waiting for daemon turn completion");
}

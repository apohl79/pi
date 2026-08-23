import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { PiClientV2 } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";
import { afterEach, describe, expect, test } from "vitest";
import { createConfiguredCodingAgentDaemonRuntime } from "../../src/server/daemon-runtime.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("production daemon plan prompt projection", () => {
	test("injects the latest durable plan into the next provider request", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-daemon-plan-prompt-"));
		directories.push(directory);
		const prompts: string[] = [];
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-daemon-plan-prompt-faux",
			models: [{ id: "plan-prompt-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		faux.setResponses([
			(context) => {
				prompts.push(context.systemPrompt ?? "");
				return fauxAssistantMessage("plan observed");
			},
		]);
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
			const created = await client.createSession({ cwd: directory });
			await client.request({ command: "session/attach", sessionId: created.id, payload: { mode: "control" } });
			await client.request({
				command: "plan/update",
				sessionId: created.id,
				payload: { items: [{ step: "ship the plan projection", status: "in_progress" }] },
			});
			await client.request({ command: "turn/start", sessionId: created.id, payload: { text: "continue" } });
			await expect.poll(() => prompts.length, { timeout: 2_000 }).toBe(1);
			expect(prompts).toHaveLength(1);
			expect(prompts[0]).toContain("# Active Plan (v1)");
			expect(prompts[0]).toContain("[in_progress] ship the plan projection");
		} finally {
			client.dispose();
			await runtime.close();
		}
	});
});

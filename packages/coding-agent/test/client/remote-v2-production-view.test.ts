import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { PiClientV2 } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";
import { afterEach, describe, expect, test } from "vitest";
import { RemoteV2SessionSelector } from "../../src/client/remote-v2-selector.ts";
import { createConfiguredCodingAgentDaemonRuntime } from "../../src/server/daemon-runtime.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createRemoteRuntime(directory: string) {
	const models = createModels();
	const faux = fauxProvider({
		provider: "coding-agent-remote-view-faux",
		models: [{ id: "coding-agent-remote-view-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
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

describe("production remote v2 view", () => {
	test("renders goal and plan state from a production daemon snapshot", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-remote-view-"));
		directories.push(directory);
		const runtime = await createRemoteRuntime(directory);
		const client = new PiClientV2({
			transportFactory: createUnixTransportFactory({ path: join(directory, "server.sock") }),
		});
		try {
			await runtime.daemon.start();
			await client.connect();
			const created = await client.request({ command: "session/create", payload: { cwd: directory } });
			expect(created).toMatchObject({ ok: true, result: { session: { id: expect.any(String) } } });
			const sessionId = (created as unknown as { result: { session: { id: string } } }).result.session.id;
			const attachment = await new RemoteV2SessionSelector(client).attachView(sessionId, { mode: "control" });
			try {
				const goalOperation = await attachment.session.createGoal("finish the remote implementation");
				await attachment.session.waitForOperation(goalOperation);
				const plan = await client.request({
					command: "plan/update",
					sessionId,
					payload: { items: [{ step: "verify the daemon", status: "in_progress" }] },
				});
				expect(plan).toMatchObject({ ok: true, result: { plan: { version: 1 } } });
				await attachment.session.refresh();
				const rendered = attachment.view.render(120).join("\n");
				expect(rendered).toContain("Goal active · finish the remote implementation");
				expect(rendered).toContain("Plan v1");
				expect(rendered).toContain("Plan in_progress · verify the daemon");
			} finally {
				await attachment.dispose();
			}
		} finally {
			client.dispose();
			await runtime.close();
		}
	});
});

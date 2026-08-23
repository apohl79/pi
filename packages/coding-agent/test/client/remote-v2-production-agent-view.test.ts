import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { PiClientV2 } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";
import { afterEach, describe, expect, test } from "vitest";
import { RemoteV2SessionSelector } from "../../src/index.ts";
import { createConfiguredCodingAgentDaemonRuntime } from "../../src/server/daemon-runtime.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("production remote v2 agent view", () => {
	test("renders a live child from the server-authoritative snapshot", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-remote-agent-view-"));
		directories.push(directory);
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-remote-agent-view-faux",
			models: [{ id: "remote-agent-view-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		models.setProvider(faux.provider);
		faux.setResponses([() => new Promise(() => {})]);
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
			const attachment = await new RemoteV2SessionSelector(client).attachView(created.id, { mode: "control" });
			try {
				const child = await attachment.session.spawnAgent("long-lived", "keep working");
				await waitForAgent(attachment.session, child.id);
				const rendered = attachment.view.render(120).join("\n");
				expect(rendered).toContain(`Agent ${child.path} · running · ${faux.provider.id}/remote-agent-view-model`);
			} finally {
				await attachment.dispose();
			}
		} finally {
			client.dispose();
			await runtime.close();
		}
	});
});

async function waitForAgent(session: { listAgents(): Promise<readonly { id: string; state: string }[]> }, id: string) {
	for (let attempt = 0; attempt < 100; attempt++) {
		if ((await session.listAgents()).some((agent) => agent.id === id && agent.state === "running")) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Timed out waiting for child agent ${id}`);
}

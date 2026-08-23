import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { PiClientV2 } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";
import { afterEach, describe, expect, test } from "vitest";
import { RemoteV2InteractiveAttachment, RemoteV2SessionSelector } from "../../src/index.ts";
import { createConfiguredCodingAgentDaemonRuntime } from "../../src/server/daemon-runtime.ts";

const directories: string[] = [];
const manifest = { name: "reviewer", version: "1.2.0", skills: ["skills/review"], commands: ["commands/review"] };

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("production remote v2 plugin commands", () => {
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

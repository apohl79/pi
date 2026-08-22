import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { PiClientV2 } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";
import { afterEach, describe, expect, test } from "vitest";
import { RemoteV2Session } from "../../src/index.ts";
import { createConfiguredCodingAgentDaemonRuntime } from "../../src/server/daemon-runtime.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("production remote v2 control lease", () => {
	test("transfers control between two daemon clients", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-remote-lease-"));
		directories.push(directory);
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-remote-lease-faux",
			models: [{ id: "remote-lease-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
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
		const firstClient = new PiClientV2({ transportFactory: createUnixTransportFactory({ path: socketPath }) });
		const secondClient = new PiClientV2({ transportFactory: createUnixTransportFactory({ path: socketPath }) });
		try {
			await runtime.daemon.start();
			await firstClient.connect();
			await secondClient.connect();
			const first = await RemoteV2Session.create(firstClient, { cwd: directory }, { mode: "control" });
			const sessionId = first.id;
			if (!sessionId) throw new Error("Session id unavailable");
			const second = await RemoteV2Session.open(secondClient, sessionId, { mode: "observer" });
			try {
				await expect(second.acquireControl()).rejects.toThrow();
				await first.relinquishControl();
				await second.acquireControl();
				expect(second.state.lifecycle).toEqual({ status: "ready" });
			} finally {
				await second.dispose();
				await first.dispose();
			}
		} finally {
			firstClient.dispose();
			secondClient.dispose();
			await runtime.close();
		}
	});
});

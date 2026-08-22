import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { PiClientV2 } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";
import { afterEach, describe, expect, test } from "vitest";
import { RemoteV2Session } from "../../src/client/remote-v2-session.ts";
import { createConfiguredCodingAgentDaemonRuntime } from "../../src/server/daemon-runtime.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("production daemon retry policy", () => {
	test("toggles only retry enablement through the server-owned session", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-daemon-retry-"));
		directories.push(directory);
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-daemon-retry-faux",
			models: [{ id: "coding-agent-daemon-retry-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		models.setProvider(faux.provider);
		const runtime = await createConfiguredCodingAgentDaemonRuntime({
			agentDir: directory,
			cwd: directory,
			models,
			model: faux.getModel(),
			socketPath: join(directory, "server.sock"),
			harness: { retry: { enabled: false, maxRetries: 3, baseDelayMs: 17 }, tools: [], activeToolNames: [] },
			write: () => {},
		});
		const client = new PiClientV2({
			transportFactory: createUnixTransportFactory({ path: join(directory, "server.sock") }),
		});
		try {
			await runtime.daemon.start();
			await client.connect();
			const session = await RemoteV2Session.create(client, { cwd: directory }, { mode: "control" });
			try {
				expect(session.snapshot?.autoRetryEnabled).toBe(false);
				const operationId = await session.setAutoRetry(true);
				await session.waitForOperation(operationId);
				expect(session.snapshot?.autoRetryEnabled).toBe(true);
				const policy = await session.readOperation(operationId);
				expect(policy.state).toBe("complete");
			} finally {
				await session.dispose();
			}
		} finally {
			client.dispose();
			await runtime.close();
		}
	});
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { PiClientV2 } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";
import type { ForensicEventInput, ForensicRecorder } from "@earendil-works/pi-server";
import { afterEach, describe, expect, test } from "vitest";
import { createConfiguredCodingAgentDaemonRuntime } from "../../src/server/daemon-runtime.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("production daemon diagnostic failure isolation", () => {
	test("keeps startup and session creation available when forensic writes fail", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-daemon-diagnostics-failure-"));
		directories.push(directory);
		const diagnostics: ForensicRecorder = {
			record: async (_event: ForensicEventInput) => {
				throw new Error("diagnostic storage unavailable");
			},
			read: async () => [],
		};
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-daemon-diagnostics-failure-faux",
			models: [{ id: "diagnostics-failure-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		models.setProvider(faux.provider);
		const socketPath = join(directory, "server.sock");
		const runtime = await createConfiguredCodingAgentDaemonRuntime({
			agentDir: directory,
			cwd: directory,
			models,
			model: faux.getModel(),
			socketPath,
			diagnostics,
			harness: { tools: [], activeToolNames: [] },
			write: () => {},
		});
		const client = new PiClientV2({ transportFactory: createUnixTransportFactory({ path: socketPath }) });
		try {
			await runtime.daemon.start();
			await client.connect();
			const created = await client.request({ command: "session/create", payload: { cwd: directory } });
			expect(created).toMatchObject({ ok: true, result: { session: { id: expect.any(String), phase: "idle" } } });
		} finally {
			client.dispose();
			await runtime.close();
		}
	});
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { PiClientV2 } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";
import type { V2OperationStore } from "@earendil-works/pi-server";
import { afterEach, describe, expect, test } from "vitest";
import { createConfiguredCodingAgentDaemonRuntime } from "../../src/server/daemon-runtime.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

class DiskFullOperationStore implements V2OperationStore {
	async load(): Promise<{ operations: never[]; events: never[] }> {
		return { operations: [], events: [] };
	}

	async putOperation(): Promise<void> {
		throw new Error("ENOSPC: no space left on device");
	}

	async appendEvent(): Promise<void> {}
}

describe("production daemon disk-full recovery", () => {
	test("rejects turn admission before provider execution and remains readable", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-daemon-disk-full-"));
		directories.push(directory);
		const models = createModels();
		let providerCalls = 0;
		const faux = fauxProvider({
			provider: "coding-agent-daemon-disk-full-faux",
			models: [{ id: "disk-full-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		faux.setResponses([
			() => {
				providerCalls += 1;
				return fauxAssistantMessage("must not run");
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
			operationStore: new DiskFullOperationStore(),
			harness: { tools: [], activeToolNames: [] },
			write: () => {},
		});
		const client = new PiClientV2({ transportFactory: createUnixTransportFactory({ path: socketPath }) });
		try {
			await runtime.daemon.start();
			await client.connect();
			const created = await client.request({ command: "session/create", payload: { cwd: directory } });
			expect(created).toMatchObject({ ok: true, result: { session: { id: expect.any(String) } } });
			if (!created.ok || !("result" in created)) throw new Error("Session creation failed");
			const sessionId = (created.result as { session: { id: string } }).session.id;
			await client.request({ command: "session/attach", sessionId, payload: { mode: "control" } });
			const turn = await client.request({ command: "turn/start", sessionId, payload: { text: "persist this" } });
			expect(turn).toMatchObject({ ok: false, error: { message: expect.stringContaining("ENOSPC") } });
			expect(providerCalls).toBe(0);
			const reread = await client.request({ command: "session/read", sessionId });
			expect(reread).toMatchObject({ ok: true, result: { session: { id: sessionId, phase: "failed" } } });
		} finally {
			client.dispose();
			await runtime.close();
		}
	});
});

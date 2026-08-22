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

describe("coding-agent daemon queue recall", () => {
	test("cancels an exact queued image reference in the production daemon", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-daemon-queue-recall-"));
		directories.push(directory);
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-daemon-queue-recall-faux",
			models: [{ id: "queue-recall-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		models.setProvider(faux.provider);
		let release!: (response: ReturnType<typeof fauxAssistantMessage>) => void;
		const response = new Promise<ReturnType<typeof fauxAssistantMessage>>((resolve) => {
			release = resolve;
		});
		faux.setResponses([() => response]);
		const runtime = await createConfiguredCodingAgentDaemonRuntime({
			agentDir: directory,
			cwd: directory,
			models,
			model: faux.getModel(),
			socketPath: join(directory, "server.sock"),
			harness: { tools: [], activeToolNames: [] },
			write: () => {},
		});
		const client = new PiClientV2({
			transportFactory: createUnixTransportFactory({ path: join(directory, "server.sock") }),
		});
		try {
			await runtime.daemon.start();
			await client.connect();
			const created = await client.request({ command: "session/create", payload: { cwd: directory } });
			if (!created.ok || !("result" in created)) throw new Error("Session creation failed");
			const sessionId = (created.result as { session: { id: string } }).session.id;
			await client.request({ command: "session/attach", sessionId, payload: { mode: "control" } });
			await client.request({ command: "session/name/auto/set", sessionId, payload: { enabled: false } });
			const blob = await client.request({
				command: "blob/put",
				payload: { data: "aGVsbG8=", mimeType: "image/png" },
			});
			if (!blob.ok || !("result" in blob)) throw new Error("Blob upload failed");
			const digest = (blob.result as { blob: { digest: string } }).blob.digest;
			const accepted = await client.request({ command: "turn/start", sessionId, payload: { text: "start" } });
			if (!accepted.ok || !("accepted" in accepted)) throw new Error("Turn was not accepted");
			await waitForPhase(client, sessionId, "turn");
			await client.request({
				command: "turn/steer",
				sessionId,
				payload: {
					content: [
						{ type: "text", text: "queued" },
						{ type: "image", digest, mimeType: "image/png" },
					],
				},
			});
			const queued = await waitForQueue(client, sessionId);
			expect(queued.content).toEqual([
				{ type: "text", text: "queued" },
				{ type: "image", digest, mimeType: "image/png" },
			]);
			const cancelled = await client.request({
				command: "turn/queue/cancel",
				sessionId,
				payload: { entryId: queued.id },
			});
			expect(cancelled).toMatchObject({ ok: true, result: { cancelled: true, entryId: queued.id } });
			const after = await client.request({ command: "session/read", sessionId });
			expect(after).toMatchObject({ ok: true, result: { session: { queues: { steer: [] } } } });
			release(fauxAssistantMessage("completed"));
			await waitForPhase(client, sessionId, "idle");
		} finally {
			client.dispose();
			await runtime.close();
		}
	});
});

async function waitForPhase(client: PiClientV2, sessionId: string, phase: string): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		const response = await client.request({ command: "session/read", sessionId });
		if (
			response.ok &&
			"result" in response &&
			(response.result as { session: { phase: string } }).session.phase === phase
		)
			return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Timed out waiting for phase ${phase}`);
}

async function waitForQueue(
	client: PiClientV2,
	sessionId: string,
): Promise<{ id: string; content: readonly unknown[] }> {
	for (let attempt = 0; attempt < 100; attempt++) {
		const response = await client.request({ command: "session/read", sessionId });
		if (response.ok && "result" in response) {
			const steer = (
				response.result as {
					session: { queues: { steer: readonly { id: string; content: readonly unknown[] }[] } };
				}
			).session.queues.steer;
			if (steer[0] !== undefined) return steer[0];
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("Timed out waiting for queued steer");
}

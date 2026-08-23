import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { PiClientV2 } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";
import { afterEach, describe, expect, test } from "vitest";
import { createConfiguredCodingAgentDaemonRuntime } from "../../src/server/daemon-runtime.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createFilesystemRuntime(directory: string) {
	const models = createModels();
	const faux = fauxProvider({
		provider: "coding-agent-daemon-filesystem-faux",
		models: [
			{ id: "coding-agent-daemon-filesystem-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 },
		],
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

describe("production daemon filesystem completion", () => {
	test("completes project-scoped references through the Unix daemon", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-daemon-filesystem-completion-"));
		directories.push(directory);
		await writeFile(join(directory, "notes.ts"), "export const answer = 42;");
		const runtime = await createFilesystemRuntime(directory);
		const client = new PiClientV2({
			transportFactory: createUnixTransportFactory({ path: join(directory, "server.sock") }),
		});
		try {
			await runtime.daemon.start();
			await client.connect();
			const created = await client.request({ command: "session/create", payload: { cwd: directory } });
			expect(created).toMatchObject({ ok: true, result: { session: { id: expect.any(String) } } });
			const sessionId = (created as unknown as { result: { session: { id: string } } }).result.session.id;
			const completed = await client.request({
				command: "filesystem/complete",
				sessionId,
				payload: { prefix: "@project:n" },
			});
			expect(completed).toMatchObject({
				ok: true,
				result: { items: [{ reference: "project:notes.ts", kind: "file" }] },
			});
		} finally {
			client.dispose();
			await runtime.close();
		}
	});
});

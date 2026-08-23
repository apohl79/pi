import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

describe("production remote v2 filesystem references", () => {
	test("completes, resolves, reads, and uploads scoped file references", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-remote-files-"));
		directories.push(directory);
		await writeFile(join(directory, "host-note.txt"), "host content", "utf8");
		const localPath = join(directory, "client-note.txt");
		await writeFile(localPath, "client content", "utf8");
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-remote-files-faux",
			models: [{ id: "remote-files-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
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
			const session = await RemoteV2Session.create(client, { cwd: directory }, { mode: "control" });
			try {
				expect(await session.completeFiles("project:")).toEqual(
					expect.arrayContaining([expect.objectContaining({ reference: "project:host-note.txt", kind: "file" })]),
				);
				expect(await session.resolveFile("host-note.txt")).toMatchObject({
					reference: "host-note.txt",
					kind: "file",
				});
				expect(await session.readFile("host-note.txt")).toMatchObject({
					encoding: "base64",
					data: Buffer.from("host content").toString("base64"),
				});
				expect(await session.uploadLocalFileReference(localPath, "text/plain")).toMatchObject({
					reference: `@local:${localPath}`,
					kind: "file",
					size: Buffer.byteLength("client content"),
				});
			} finally {
				await session.dispose();
			}
		} finally {
			client.dispose();
			await runtime.close();
		}
	});
});

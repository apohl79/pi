import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
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

	test("resolves an absolute @server reference outside the project root", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-remote-files-server-scope-"));
		const outsideDirectory = await mkdtemp(join(tmpdir(), "pi-remote-files-server-target-"));
		directories.push(directory, outsideDirectory);
		const outsidePath = join(outsideDirectory, "outside.txt");
		await writeFile(outsidePath, "execution host content", "utf8");
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-remote-files-server-faux",
			models: [{ id: "remote-files-server-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
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
				const completion = await session.completeFiles(`@server:${outsidePath}`);
				expect(completion).toEqual([expect.objectContaining({ reference: `server:${outsidePath}`, kind: "file" })]);
				const resolved = await session.resolveFile(`@server:${outsidePath}`);
				expect(resolved.path).toBe(await realpath(outsidePath));
				expect(await session.readFile(`@server:${outsidePath}`)).toMatchObject({
					data: Buffer.from("execution host content").toString("base64"),
				});
			} finally {
				await session.dispose();
			}
		} finally {
			client.dispose();
			await runtime.close();
		}
	});

	test("preserves server and local references in one prompt across reattach", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-remote-files-prompt-"));
		const localDirectory = await mkdtemp(join(tmpdir(), "pi-remote-files-local-"));
		directories.push(directory, localDirectory);
		const serverPath = join(directory, "server-note.txt");
		const localPath = join(localDirectory, "client-note.txt");
		await writeFile(serverPath, "server prompt content", "utf8");
		await writeFile(localPath, "client prompt content", "utf8");
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-remote-files-prompt-faux",
			models: [{ id: "remote-files-prompt-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		const prompts: string[] = [];
		faux.setResponses([
			(context) => {
				prompts.push(JSON.stringify(context.messages));
				return fauxAssistantMessage("references received");
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
			harness: { tools: [], activeToolNames: [] },
			write: () => {},
		});
		const client = new PiClientV2({ transportFactory: createUnixTransportFactory({ path: socketPath }) });
		try {
			await runtime.daemon.start();
			await client.connect();
			const first = await RemoteV2Session.create(client, { cwd: directory }, { mode: "control" });
			const sessionId = first.id;
			try {
				const serverFile = await first.resolveFile(`@server:${serverPath}`);
				const localFile = await first.uploadLocalFileReference(localPath, "text/plain");
				const operationId = await first.submit([
					{ type: "text", text: "Compare these files" },
					{ type: "mention", name: "server note", path: serverFile.reference },
					{
						type: "mention",
						name: "client note",
						path: localFile.reference,
						blobDigest: localFile.blobDigest,
						mimeType: localFile.mimeType,
					},
				]);
				await first.waitForOperation(operationId);
				expect(prompts).toHaveLength(1);
				expect(prompts[0]).toContain(serverFile.reference);
				expect(prompts[0]).toContain(localFile.reference);
				expect(first.snapshot?.transcript).toEqual(
					expect.arrayContaining([expect.objectContaining({ role: "assistant", text: "references received" })]),
				);
			} finally {
				await first.dispose();
			}
			if (!sessionId) throw new Error("Session id unavailable");
			const reattached = await RemoteV2Session.open(client, sessionId, { mode: "control" });
			try {
				expect(JSON.stringify(reattached.snapshot?.transcript)).toContain(`@server:${serverPath}`);
				expect(JSON.stringify(reattached.snapshot?.transcript)).toContain(`@local:${localPath}`);
			} finally {
				await reattached.dispose();
			}
		} finally {
			client.dispose();
			await runtime.close();
		}
	});
});

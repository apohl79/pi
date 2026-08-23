import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { PiClientV2 } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";
import { afterEach, describe, expect, test } from "vitest";
import { RemoteV2SessionSelector } from "../../src/client/remote-v2-selector.ts";
import { createConfiguredCodingAgentDaemonRuntime } from "../../src/server/daemon-runtime.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createRemoteRuntime(directory: string) {
	const models = createModels();
	const faux = fauxProvider({
		provider: "coding-agent-remote-view-faux",
		models: [{ id: "coding-agent-remote-view-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
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

describe("production remote v2 view", () => {
	test("renders goal and plan state from a production daemon snapshot", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-remote-view-"));
		directories.push(directory);
		const runtime = await createRemoteRuntime(directory);
		const client = new PiClientV2({
			transportFactory: createUnixTransportFactory({ path: join(directory, "server.sock") }),
		});
		try {
			await runtime.daemon.start();
			await client.connect();
			const created = await client.request({ command: "session/create", payload: { cwd: directory } });
			expect(created).toMatchObject({ ok: true, result: { session: { id: expect.any(String) } } });
			const sessionId = (created as unknown as { result: { session: { id: string } } }).result.session.id;
			const attachment = await new RemoteV2SessionSelector(client).attachView(sessionId, { mode: "control" });
			const goalOperation = await attachment.session.createGoal("finish the remote implementation");
			await attachment.session.waitForOperation(goalOperation);
			const plan = await client.request({
				command: "plan/update",
				sessionId,
				payload: { items: [{ step: "verify the daemon", status: "in_progress" }] },
			});
			expect(plan).toMatchObject({ ok: true, result: { plan: { version: 1 } } });
			await attachment.session.refresh();
			const rendered = attachment.view.render(120).join("\n");
			expect(rendered).toContain("Goal active · finish the remote implementation");
			expect(rendered).toContain("Plan v1");
			expect(rendered).toContain("Plan in_progress · verify the daemon");

			await attachment.dispose();
			const reattached = await new RemoteV2SessionSelector(client).attachView(sessionId, { mode: "control" });
			try {
				const rerendered = reattached.view.render(120).join("\n");
				expect(rerendered).toContain("Goal active · finish the remote implementation");
				expect(rerendered).toContain("Plan v1");
				expect(rerendered).toContain("Plan in_progress · verify the daemon");
			} finally {
				await reattached.dispose();
			}
		} finally {
			client.dispose();
			await runtime.close();
		}
	});

	test("resolves server files and uploads local references through the production daemon", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-remote-files-"));
		directories.push(directory);
		const serverPath = join(directory, "server-note.md");
		const localPath = join(directory, "local-note.txt");
		await writeFile(serverPath, "server content\n", "utf8");
		await writeFile(localPath, "local content\n", "utf8");
		const runtime = await createRemoteRuntime(directory);
		const client = new PiClientV2({
			transportFactory: createUnixTransportFactory({ path: join(directory, "server.sock") }),
		});
		try {
			await runtime.daemon.start();
			await client.connect();
			const created = await client.createSession({ cwd: directory });
			const session = await new RemoteV2SessionSelector(client).attachView(created.id, { mode: "control" });
			try {
				const serverFile = await session.session.resolveFile("@server:server-note.md");
				expect(serverFile).toMatchObject({
					reference: "server:server-note.md",
					kind: "file",
					mimeType: "text/markdown",
				});
				const serverRead = await session.session.readFile(serverFile.reference);
				expect(Buffer.from(serverRead.data, "base64").toString("utf8")).toBe(await readFile(serverPath, "utf8"));

				const localFile = await session.session.uploadLocalFileReference(localPath, "text/plain");
				expect(localFile).toMatchObject({
					reference: `@local:${localPath}`,
					path: localPath,
					kind: "file",
					size: 14,
				});
				const blob = await session.session.statBlob(localFile.blobDigest);
				const blobRead = await session.session.readBlob(localFile.blobDigest);
				expect(blob).toMatchObject({ digest: localFile.blobDigest, mimeType: "text/plain", size: 14 });
				expect(Buffer.from(blobRead.data, "base64").toString("utf8")).toBe("local content\n");
			} finally {
				await session.dispose();
			}
		} finally {
			client.dispose();
			await runtime.close();
		}
	});
});

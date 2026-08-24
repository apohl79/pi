import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { PiClientV2 } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";
import { InMemoryV2AppRegistry } from "@earendil-works/pi-server";
import { afterEach, describe, expect, test } from "vitest";
import { RemoteV2Session } from "../../src/index.ts";
import { createConfiguredCodingAgentDaemonRuntime } from "../../src/server/daemon-runtime.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("production remote v2 app authentication", () => {
	test("lists an app and completes its auth lifecycle through the daemon", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-remote-app-auth-"));
		directories.push(directory);
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-remote-app-auth-faux",
			models: [{ id: "remote-app-auth-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		models.setProvider(faux.provider);
		const apps = new InMemoryV2AppRegistry({
			apps: [{ id: "calendar", name: "Calendar", auth: "unauthenticated", enabled: true }],
		});
		const socketPath = join(directory, "server.sock");
		const runtime = await createConfiguredCodingAgentDaemonRuntime({
			agentDir: directory,
			cwd: directory,
			models,
			model: faux.getModel(),
			apps,
			socketPath,
			harness: { tools: [], activeToolNames: [] },
			write: () => {},
		});
		const client = new PiClientV2({ transportFactory: createUnixTransportFactory({ path: socketPath }) });
		try {
			await runtime.daemon.start();
			await client.connect();
			const session = await RemoteV2Session.create(client, { cwd: directory }, { mode: "observer" });
			try {
				expect(await session.listApps()).toEqual([
					expect.objectContaining({ id: "calendar", auth: "unauthenticated" }),
				]);
				expect(await session.readApp("calendar")).toEqual(
					expect.objectContaining({ id: "calendar", name: "Calendar" }),
				);
				expect(await session.startAppAuth({ id: "calendar", authorizationUrl: "https://auth.test/start" })).toEqual(
					{
						appId: "calendar",
						state: "pending",
						authorizationUrl: "https://auth.test/start",
					},
				);
				expect(await session.completeAppAuth({ id: "calendar", code: "test-code" })).toEqual({
					appId: "calendar",
					state: "authenticated",
				});
				expect((await session.readApp("calendar")).auth).toBe("authenticated");
			} finally {
				await session.dispose();
			}
		} finally {
			client.dispose();
			await runtime.close();
		}
	});
});

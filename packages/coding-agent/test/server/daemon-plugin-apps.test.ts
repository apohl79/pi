import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { PiClientV2 } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";
import { afterEach, describe, expect, test } from "vitest";
import { RemoteV2Session } from "../../src/client/remote-v2-session.ts";
import { createConfiguredCodingAgentDaemonRuntime } from "../../src/server/daemon-runtime.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("coding-agent daemon plugin apps", () => {
	test("projects installed plugin apps through app/list and app/read", async () => {
		const result = await runPluginAppsScenario();
		expect(result.listed).toMatchObject({
			ok: true,
			result: {
				apps: [{ id: "calendar-plugin@local:calendar", name: "Calendar", auth: "unauthenticated", enabled: true }],
			},
		});
		expect(result.read).toMatchObject({
			ok: true,
			result: { app: { id: "calendar-plugin@local:calendar", name: "Calendar", description: "Plugin calendar" } },
		});
		expect(result.auth).toMatchObject({
			ok: true,
			result: {
				auth: { appId: "calendar-plugin@local:calendar", state: "pending", authorizationUrl: "https://auth.local" },
			},
		});
		expect(result.afterAuth).toMatchObject({ ok: true, result: { app: { auth: "authenticated" } } });
		expect(result.completed).toMatchObject({
			ok: true,
			result: { auth: { appId: "calendar-plugin@local:calendar", state: "authenticated" } },
		});
		expect(result.mention).toMatchObject({
			transcript: expect.arrayContaining([
				expect.objectContaining({
					role: "user",
					content: expect.arrayContaining([expect.objectContaining({ type: "text", text: "@Calendar" })]),
				}),
			]),
		});
	});
});

async function runPluginAppsScenario(): Promise<{
	listed: unknown;
	read: unknown;
	auth: unknown;
	completed: unknown;
	afterAuth: unknown;
	mention: unknown;
}> {
	const directory = await mkdtemp(join(tmpdir(), "pi-daemon-plugin-apps-"));
	directories.push(directory);
	const models = createModels();
	const faux = fauxProvider({
		provider: "coding-agent-daemon-plugin-apps-faux",
		models: [
			{ id: "coding-agent-daemon-plugin-apps-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 },
		],
	});
	let providerPrompt = "";
	faux.setResponses([
		(context) => {
			providerPrompt = JSON.stringify(context.messages.at(-1)?.content ?? "");
			return fauxAssistantMessage("mention accepted");
		},
	]);
	models.setProvider(faux.provider);
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
		await client.request({
			command: "marketplace/add",
			payload: { name: "local", source: "file:///tmp/marketplace" },
		});
		await client.request({
			command: "plugin/install",
			payload: {
				name: "calendar-plugin",
				marketplace: "local",
				version: "1.0.0",
				manifest: {
					name: "calendar-plugin",
					version: "1.0.0",
					apps: [{ id: "calendar", name: "Calendar", description: "Plugin calendar", auth: "unauthenticated" }],
				},
			},
		});
		const listed = await client.request({ command: "app/list" });
		const read = await client.request({ command: "app/read", payload: { id: "calendar-plugin@local:calendar" } });
		const auth = await client.request({
			command: "app/auth/start",
			payload: { id: "calendar-plugin@local:calendar", authorizationUrl: "https://auth.local" },
		});
		const completed = await client.request({
			command: "app/auth/complete",
			payload: {
				id: "calendar-plugin@local:calendar",
				code: "redacted-code",
				credentials: { accessToken: "stored-outside-plugin-state" },
			},
		});
		const credentials = JSON.parse(await readFile(join(directory, "app-credentials.json"), "utf8")) as Record<
			string,
			unknown
		>;
		expect(credentials).toEqual({ "calendar-plugin@local:calendar": { accessToken: "stored-outside-plugin-state" } });
		const afterAuth = await client.request({
			command: "app/read",
			payload: { id: "calendar-plugin@local:calendar" },
		});
		const invalidSession = await RemoteV2Session.create(client, { cwd: directory }, { mode: "control" });
		try {
			await expect(
				invalidSession.submit([{ type: "mention", name: "Missing", path: "app://missing" }]),
			).rejects.toThrow("Unknown or disabled app mention");
		} finally {
			await invalidSession.dispose();
		}
		const session = await RemoteV2Session.create(client, { cwd: directory }, { mode: "control" });
		try {
			const operationId = await session.submit([
				{ type: "text", text: "Inspect this connector" },
				{ type: "mention", name: "Calendar", path: "app://calendar-plugin@local:calendar" },
				{ type: "mention", name: "Calendar plugin", path: "plugin://calendar-plugin@local" },
			]);
			await session.waitForOperation(operationId);
		} finally {
			await session.dispose();
		}
		expect(providerPrompt).toContain("@Calendar");
		expect(providerPrompt).toContain("@Calendar plugin");
		return { listed, read, auth, completed, afterAuth, mention: session.snapshot };
	} finally {
		client.dispose();
		await runtime.close();
	}
}

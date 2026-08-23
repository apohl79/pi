import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { PiClientV2 } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";
import type { JsonValue } from "@earendil-works/pi-protocol";
import { afterEach, describe, expect, test } from "vitest";
import { RemoteV2Session } from "../../src/client/remote-v2-session.ts";
import { createConfiguredCodingAgentDaemonRuntime } from "../../src/server/daemon-runtime.ts";

const directories: string[] = [];

async function expectHookDiagnostic(client: PiClientV2, sessionId: string): Promise<void> {
	const diagnostics = await client.request({
		command: "diagnostics/timeline",
		payload: { sessionId },
	});
	expect(diagnostics).toMatchObject({
		ok: true,
		result: {
			events: expect.arrayContaining([
				expect.objectContaining({
					kind: "plugin_hook",
					outcome: "ok",
					payload: expect.objectContaining({ hookId: "hook-plugin@local:hook-0", outputBytes: 0 }),
				}),
			]),
		},
	});
}

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("production daemon plugin hook execution", () => {
	test("executes an enabled turn hook in the server execution environment", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-daemon-plugin-hook-execution-"));
		directories.push(directory);
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-daemon-plugin-hook-execution-faux",
			models: [
				{
					id: "coding-agent-daemon-plugin-hook-execution-model",
					reasoning: false,
					contextWindow: 32_000,
					maxTokens: 1_000,
				},
			],
		});
		models.setProvider(faux.provider);
		faux.setResponses([fauxAssistantMessage("hooked response")]);
		const runtime = await createConfiguredCodingAgentDaemonRuntime({
			agentDir: directory,
			cwd: directory,
			models,
			model: faux.getModel(),
			socketPath: join(directory, "server.sock"),
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
					name: "hook-plugin",
					marketplace: "local",
					version: "1.0.0",
					manifest: {
						name: "hook-plugin",
						version: "1.0.0",
						hooks: [{ event: "turn/accepted", command: "touch hook-fired" }],
					},
				},
			});
			const session = await RemoteV2Session.create(client, { cwd: directory }, { mode: "control" });
			try {
				const sessionId = session.id as string;
				const operationId = await session.submit("run the hook");
				const snapshot = await session.waitForOperation(operationId);
				await expect(access(join(directory, "hook-fired"))).resolves.toBeUndefined();
				await expectHookDiagnostic(client, sessionId);
				expect(snapshot.phase).toBe("idle");
			} finally {
				await session.dispose();
			}
		} finally {
			client.dispose();
			await runtime.close();
		}
	});

	test("preserves plugin and provider failures in an offline-verifiable causal timeline", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-daemon-plugin-provider-failure-"));
		directories.push(directory);
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-daemon-plugin-provider-failure-faux",
			models: [
				{
					id: "coding-agent-daemon-plugin-provider-failure-model",
					reasoning: false,
					contextWindow: 32_000,
					maxTokens: 1_000,
				},
			],
		});
		models.setProvider(faux.provider);
		faux.setResponses([
			fauxAssistantMessage("provider failed", { stopReason: "error", errorMessage: "provider failure" }),
		]);
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
					name: "failing-hook-plugin",
					marketplace: "local",
					version: "1.0.0",
					manifest: {
						name: "failing-hook-plugin",
						version: "1.0.0",
						hooks: [{ event: "turn/accepted", command: "exit 7" }],
					},
				},
			});
			const session = await RemoteV2Session.create(client, { cwd: directory }, { mode: "control" });
			try {
				const sessionId = session.id;
				if (sessionId === undefined) throw new Error("Session id unavailable");
				const operationId = await session.submit("capture failure chain");
				const snapshot = await session.waitForOperation(operationId);
				expect(snapshot.phase).toBe("failed");
				const timeline = await client.request({
					command: "diagnostics/timeline",
					payload: { sessionId },
				});
				expect(timeline).toMatchObject({
					ok: true,
					result: {
						events: expect.arrayContaining([
							expect.objectContaining({ kind: "plugin_hook", outcome: "error" }),
							expect.objectContaining({ kind: "operation_accepted", operationId }),
							expect.objectContaining({ kind: "operation_terminal", operationId, outcome: "error" }),
						]),
					},
				});
				const exported = await client.request({ command: "diagnostics/export" });
				expect(exported).toMatchObject({
					ok: true,
					result: { bundle: expect.objectContaining({ events: expect.any(Array) }) },
				});
				if (!exported.ok || !("result" in exported)) throw new Error("Diagnostic export failed");
				const bundle = (exported.result as { bundle: Record<string, unknown> }).bundle;
				const verified = await client.request({
					command: "diagnostics/verify",
					payload: { bundle: bundle as unknown as JsonValue },
				});
				expect(verified).toMatchObject({ ok: true, result: { valid: true } });
			} finally {
				await session.dispose();
			}
		} finally {
			client.dispose();
			await runtime.close();
		}
	});
});

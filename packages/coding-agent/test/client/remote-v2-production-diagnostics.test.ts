import { mkdtemp, rm } from "node:fs/promises";
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

describe("production remote v2 diagnostics", () => {
	test("exports and verifies a causal bundle through the remote client", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-remote-diagnostics-"));
		directories.push(directory);
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-remote-diagnostics-faux",
			models: [{ id: "remote-diagnostics-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		models.setProvider(faux.provider);
		faux.setResponses([fauxAssistantMessage("diagnostic response")]);
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
				const operationId = await session.submit("capture diagnostics");
				await session.waitForOperation(operationId);
				const status = await session.diagnosticsStatus({ sessionId: session.id });
				const timeline = await session.diagnosticsTimelineEvidence({ sessionId: session.id });
				const bundle = await session.diagnosticsExport({ sessionId: session.id });
				const verification = await session.diagnosticsVerify(bundle);
				const doctor = await session.diagnosticsDoctor();
				expect(status.eventCount).toBeGreaterThan(0);
				expect(timeline.events.length).toBeGreaterThan(0);
				expect(bundle.manifest).toEqual(expect.any(Object));
				expect(verification).toMatchObject({ valid: true });
				expect(doctor).toMatchObject({ ok: true, checks: expect.any(Array) });
			} finally {
				await session.dispose();
			}
		} finally {
			client.dispose();
			await runtime.close();
		}
	});

	test("retains a provider failure in the bundle after daemon recreation", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-remote-diagnostics-provider-failure-"));
		directories.push(directory);
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-remote-diagnostics-provider-failure-faux",
			models: [
				{
					id: "remote-diagnostics-provider-failure-model",
					reasoning: false,
					contextWindow: 32_000,
					maxTokens: 1_000,
				},
			],
		});
		models.setProvider(faux.provider);
		faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider failure" })]);
		const socketPath = join(directory, "server.sock");
		const createRuntime = () =>
			createConfiguredCodingAgentDaemonRuntime({
				agentDir: directory,
				cwd: directory,
				models,
				model: faux.getModel(),
				socketPath,
				harness: { tools: [], activeToolNames: [] },
				write: () => {},
			});
		const firstRuntime = await createRuntime();
		const firstClient = new PiClientV2({ transportFactory: createUnixTransportFactory({ path: socketPath }) });
		let sessionId = "";
		try {
			await firstRuntime.daemon.start();
			await firstClient.connect();
			const session = await RemoteV2Session.create(firstClient, { cwd: directory }, { mode: "control" });
			try {
				sessionId = session.id;
				const operationId = await session.submit("capture provider failure");
				const terminal = await session.waitForOperation(operationId);
				expect(terminal.phase).toBe("failed");
			} finally {
				await session.dispose();
			}
		} finally {
			firstClient.dispose();
			await firstRuntime.close();
		}

		const secondRuntime = await createRuntime();
		const secondClient = new PiClientV2({ transportFactory: createUnixTransportFactory({ path: socketPath }) });
		try {
			await secondRuntime.daemon.start();
			await secondClient.connect();
			const session = await RemoteV2Session.open(secondClient, sessionId, { mode: "observer" });
			try {
				const bundle = await session.diagnosticsExport({ sessionId });
				expect(JSON.stringify(bundle)).toContain("provider failure");
				expect(await session.diagnosticsVerify(bundle)).toMatchObject({ valid: true });
			} finally {
				await session.dispose();
			}
		} finally {
			secondClient.dispose();
			await secondRuntime.close();
		}
	});
});

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

function response(content: string, cost: number, responseId: string) {
	return {
		...fauxAssistantMessage(content, { responseId }),
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: cost, cacheRead: 0, cacheWrite: 0, total: cost },
		},
	};
}

describe("production daemon rollback invariants", () => {
	test("rolls back two turns without changing filesystem or usage history", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-daemon-rollback-invariants-"));
		directories.push(directory);
		const filePath = join(directory, "durable.txt");
		await writeFile(filePath, "unchanged filesystem state");
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-daemon-rollback-invariants-faux",
			models: [
				{
					id: "rollback-invariants-model",
					reasoning: false,
					contextWindow: 32_000,
					maxTokens: 1_000,
					cost: { input: 0, output: 0.1, cacheRead: 0, cacheWrite: 0 },
				},
			],
		});
		models.setProvider(faux.provider);
		faux.setResponses([
			response("first response", 0.1, "rollback-response-1"),
			response("second response", 0.2, "rollback-response-2"),
		]);
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
				const sessionId = session.id;
				if (sessionId === undefined) throw new Error("Session id unavailable");
				const namingOperation = await session.setAutoName(false);
				await session.waitForOperation(namingOperation);
				for (const prompt of ["first request", "second request"]) {
					const operationId = await session.submit(prompt);
					await session.waitForOperation(operationId);
				}
				const before = await client.request({ command: "usage/read", payload: { sessionId } });
				expect(before).toMatchObject({
					result: { aggregate: { responses: 2, costUsd: 0, pricingState: "known" } },
				});
				const rollbackOperation = await session.rollback(2);
				await session.waitForOperation(rollbackOperation);
				expect(await readFile(filePath, "utf8")).toBe("unchanged filesystem state");
				const rolledBack = session.snapshot;
				expect(rolledBack?.transcript?.some((item) => JSON.stringify(item).includes("first request"))).toBe(false);
				expect(rolledBack?.transcript?.some((item) => JSON.stringify(item).includes("second request"))).toBe(false);
				const after = await client.request({ command: "usage/read", payload: { sessionId } });
				expect(after).toMatchObject({ result: { aggregate: { responses: 2, costUsd: 0, pricingState: "known" } } });
			} finally {
				await session.dispose();
			}
		} finally {
			client.dispose();
			await runtime.close();
		}
	});
});

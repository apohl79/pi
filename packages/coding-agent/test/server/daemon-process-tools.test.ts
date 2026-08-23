import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Context, createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { PiClientV2 } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";
import { afterEach, describe, expect, test } from "vitest";
import { RemoteV2Session } from "../../src/client/remote-v2-session.ts";
import { createConfiguredCodingAgentDaemonRuntime } from "../../src/server/daemon-runtime.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("coding-agent daemon process tools", () => {
	test("routes exec_command through the server-owned process registry", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-daemon-process-tools-"));
		directories.push(directory);
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-daemon-process-faux",
			models: [{ id: "process-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		models.setProvider(faux.provider);
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("exec_command", { command: "printf process-output" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("process complete"),
		]);
		const runtime = await createConfiguredCodingAgentDaemonRuntime({
			agentDir: directory,
			cwd: directory,
			models,
			model: faux.getModel(),
			socketPath: join(directory, "server.sock"),
			harness: { activeToolNames: ["exec_command"] },
			write: () => {},
		});
		const client = new PiClientV2({
			transportFactory: createUnixTransportFactory({ path: join(directory, "server.sock") }),
		});
		try {
			await runtime.daemon.start();
			await client.connect();
			const session = await RemoteV2Session.create(client, { cwd: directory }, { mode: "control" });
			try {
				const operationId = await session.submit("run the process");
				const snapshot = await session.waitForOperation(operationId);
				expect(snapshot.transcript.some((item) => item.role === "tool")).toBe(true);
				expect(JSON.stringify(snapshot.transcript)).toContain("process");
			} finally {
				await session.dispose();
			}
		} finally {
			client.dispose();
			await runtime.close();
		}
	});

	test("routes model-facing write_stdin through the same server-owned process", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-daemon-process-tool-input-"));
		directories.push(directory);
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-daemon-process-input-faux",
			models: [{ id: "process-input-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		models.setProvider(faux.provider);
		const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(
			"process.stdin.once('data', data => { process.stdout.write('tool-pty:' + data); process.exit(0); })",
		)}`;
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("exec_command", { command, pty: true, yield_time_ms: 10 }), {
				stopReason: "toolUse",
			}),
			(context: Context) => {
				const toolResult = [...context.messages].reverse().find((message) => message.role === "toolResult");
				if (toolResult === undefined || typeof toolResult.details !== "object" || toolResult.details === null)
					throw new Error("Expected exec_command details before write_stdin");
				const sessionId = (toolResult.details as { session_id?: unknown }).session_id;
				if (typeof sessionId !== "string") throw new Error("Expected exec_command session_id");
				return fauxAssistantMessage(
					fauxToolCall("write_stdin", { session_id: sessionId, chars: "hello\n", yield_time_ms: 10 }),
					{ stopReason: "toolUse" },
				);
			},
			(context: Context) => {
				const toolText = context.messages
					.filter((message) => message.role === "toolResult")
					.flatMap((message) => message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])));
				return fauxAssistantMessage(toolText.join("\\n"));
			},
		]);
		const runtime = await createConfiguredCodingAgentDaemonRuntime({
			agentDir: directory,
			cwd: directory,
			models,
			model: faux.getModel(),
			socketPath: join(directory, "server.sock"),
			harness: { activeToolNames: ["exec_command", "write_stdin"] },
			write: () => {},
		});
		const client = new PiClientV2({
			transportFactory: createUnixTransportFactory({ path: join(directory, "server.sock") }),
		});
		try {
			await runtime.daemon.start();
			await client.connect();
			const session = await RemoteV2Session.create(client, { cwd: directory }, { mode: "control" });
			try {
				const operationId = await session.submit("send input to the process");
				const snapshot = await session.waitForOperation(operationId);
				expect(snapshot.transcript.some((item) => item.role === "tool")).toBe(true);
				expect(JSON.stringify(snapshot.transcript)).toContain("tool-pty:hello\\n");
			} finally {
				await session.dispose();
			}
		} finally {
			client.dispose();
			await runtime.close();
		}
	});
});

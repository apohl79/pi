import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { PiClientV2 } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, test } from "vitest";
import { type RemoteV2CommandResult, RemoteV2InteractiveAttachment, RemoteV2SessionSelector } from "../../src/index.ts";
import { createConfiguredCodingAgentDaemonRuntime } from "../../src/server/daemon-runtime.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createRemoteRuntime(directory: string) {
	const models = createModels();
	const faux = fauxProvider({
		provider: "coding-agent-remote-interactive-faux",
		models: [
			{ id: "coding-agent-remote-interactive-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 },
		],
	});
	const child = fauxProvider({
		provider: "coding-agent-remote-interactive-child-faux",
		models: [{ id: "child-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
	});
	models.setProvider(faux.provider);
	models.setProvider(child.provider);
	child.setResponses([() => new Promise(() => {})]);
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

function operationId(result: RemoteV2CommandResult): string {
	if (result.kind !== "operation") throw new Error("Expected a remote operation result");
	return result.operationId;
}

describe("production remote v2 interactive attachment", () => {
	test("keeps the editable prompt within narrow daemon-attached terminal width", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-remote-interactive-width-"));
		directories.push(directory);
		const runtime = await createRemoteRuntime(directory);
		const client = new PiClientV2({
			transportFactory: createUnixTransportFactory({ path: join(directory, "server.sock") }),
		});
		try {
			await runtime.daemon.start();
			await client.connect();
			const created = await client.request({ command: "session/create", payload: { cwd: directory } });
			const sessionId = (created as unknown as { result: { session: { id: string } } }).result.session.id;
			const attachment = await new RemoteV2SessionSelector(client).attachView(sessionId, { mode: "control" });
			const adapter = new RemoteV2InteractiveAttachment(attachment);
			try {
				for (const character of "a long prompt that exceeds the terminal") adapter.handleInput(character);
				expect(visibleWidth(adapter.render(12).at(-1) ?? "")).toBe(12);
			} finally {
				await adapter.dispose();
			}
		} finally {
			client.dispose();
			await runtime.close();
		}
	});

	test("dispatches goal slash commands and renders the updated goal state", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-remote-interactive-"));
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
			const adapter = new RemoteV2InteractiveAttachment(attachment);
			try {
				const createdGoal = await adapter.execute("/goal ship the remote workflow");
				await attachment.session.waitForOperation(operationId(createdGoal));
				const pausedGoal = await adapter.execute("/goal-pause");
				await attachment.session.waitForOperation(operationId(pausedGoal));
				const rendered = adapter.render(120).join("\n");
				expect(rendered).toContain("Goal paused · ship the remote workflow");
				expect(rendered).toContain("> ");
			} finally {
				await adapter.dispose();
			}
		} finally {
			client.dispose();
			await runtime.close();
		}
	});

	test("completes file references on the execution host", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-remote-interactive-files-"));
		directories.push(directory);
		await writeFile(join(directory, "README.md"), "remote file");
		const runtime = await createRemoteRuntime(directory);
		const client = new PiClientV2({
			transportFactory: createUnixTransportFactory({ path: join(directory, "server.sock") }),
		});
		try {
			await runtime.daemon.start();
			await client.connect();
			const created = await client.request({ command: "session/create", payload: { cwd: directory } });
			const sessionId = (created as unknown as { result: { session: { id: string } } }).result.session.id;
			const attachment = await new RemoteV2SessionSelector(client).attachView(sessionId, { mode: "control" });
			const adapter = new RemoteV2InteractiveAttachment(attachment);
			try {
				for (const character of "@README") adapter.handleInput(character);
				adapter.handleInput("\t");
				await new Promise((resolve) => setTimeout(resolve, 25));
				expect(adapter.render(120).join("\n")).toContain("README.md");
			} finally {
				await adapter.dispose();
			}
		} finally {
			client.dispose();
			await runtime.close();
		}
	});

	test("routes remote steering through the production daemon", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-remote-interactive-steer-"));
		directories.push(directory);
		const runtime = await createRemoteRuntime(directory);
		const client = new PiClientV2({
			transportFactory: createUnixTransportFactory({ path: join(directory, "server.sock") }),
		});
		try {
			await runtime.daemon.start();
			await client.connect();
			const created = await client.request({ command: "session/create", payload: { cwd: directory } });
			const sessionId = (created as unknown as { result: { session: { id: string } } }).result.session.id;
			const attachment = await new RemoteV2SessionSelector(client).attachView(sessionId, { mode: "control" });
			const adapter = new RemoteV2InteractiveAttachment(attachment);
			try {
				const result = await adapter.execute("/steer prioritize tests");
				await attachment.session.waitForOperation(operationId(result));
				expect(attachment.session.phase).toBe("idle");
			} finally {
				await adapter.dispose();
			}
		} finally {
			client.dispose();
			await runtime.close();
		}
	});

	test("interrupts a live child through the production remote command", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-remote-interactive-child-"));
		directories.push(directory);
		const runtime = await createRemoteRuntime(directory);
		const client = new PiClientV2({
			transportFactory: createUnixTransportFactory({ path: join(directory, "server.sock") }),
		});
		try {
			await runtime.daemon.start();
			await client.connect();
			const created = await client.request({ command: "session/create", payload: { cwd: directory } });
			const sessionId = (created as unknown as { result: { session: { id: string } } }).result.session.id;
			const attachment = await new RemoteV2SessionSelector(client).attachView(sessionId, { mode: "control" });
			const adapter = new RemoteV2InteractiveAttachment(attachment);
			try {
				const child = await attachment.session.spawnAgent("stuck", "wait for cancellation", {
					model: { provider: "coding-agent-remote-interactive-child-faux", id: "child-model" },
				});
				expect(child.state).toBe("running");
				expect(await adapter.execute(`/interrupt-child ${child.id}`)).toEqual({
					kind: "status",
					text: "agent interrupted",
				});
				expect((await attachment.session.listAgents()).find((agent) => agent.id === child.id)?.state).toBe(
					"interrupted",
				);
			} finally {
				await adapter.dispose();
			}
		} finally {
			client.dispose();
			await runtime.close();
		}
	});
});

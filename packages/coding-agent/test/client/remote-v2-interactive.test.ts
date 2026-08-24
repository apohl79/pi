import type { ByteTransport, ByteTransportHandlers } from "@earendil-works/pi-client";
import { PiClientV2 } from "@earendil-works/pi-client";
import {
	decodeCbor,
	encodeServerMessageV2,
	type JsonValue,
	PROTOCOL_V2_VERSION,
	parseClientMessageV2,
	type SessionSnapshotV2,
} from "@earendil-works/pi-protocol";
import { TuiMainScreen } from "@earendil-works/pi-tui";
import { describe, expect, test, vi } from "vitest";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal.ts";
import {
	applyRemoteFileCompletion,
	parseRemoteV2Command,
	REMOTE_V2_SLASH_COMMANDS,
	RemoteV2AutocompleteProvider,
	RemoteV2InteractiveAttachment,
} from "../../src/client/remote-v2-interactive.ts";
import { RemoteV2SessionSelector } from "../../src/client/remote-v2-selector.ts";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import { CustomEditor } from "../../src/modes/interactive/components/custom-editor.ts";
import { getEditorTheme, initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";

function snapshot(withQueue = false): SessionSnapshotV2 {
	return {
		id: "session-1",
		nameRevision: 0,
		revision: 1,
		eventSeq: 1,
		phase: "idle",
		model: { provider: "faux", id: "model" },
		thinkingLevel: "off",
		transcript: [],
		queues: {
			steer: withQueue
				? [
						{
							id: "queued-image",
							content: [
								{ type: "text", text: "restore me" },
								{ type: "image", digest: "a".repeat(64), mimeType: "image/png" },
							],
							createdAt: 1,
						},
					]
				: [],
			followUp: [],
		},
		agents: [],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, pricingState: "known" },
		context: { inputTokens: 0, contextWindow: 16_000, usedPercentage: 0 },
		compactionPolicy: {
			enabled: true,
			contextWindow: 16_000,
			reserveTokens: 1_000,
			keepRecentTokens: 2_000,
			triggerTokens: 15_000,
			source: "global",
		},
		pluginSetHash: "plugins-empty",
		diagnostics: { capture: "metadata", degraded: false, lastCriticalEventSeq: 1 },
		persistence: { schemaVersion: 1, recoveryState: "clean" },
		createdAt: 1,
		updatedAt: 1,
	};
}

function clientWithRequests(withQueue = false): { client: PiClientV2; commands: string[] } {
	let handlers: ByteTransportHandlers | undefined;
	const commands: string[] = [];
	const transport: ByteTransport = {
		send: async (chunk) => {
			const message = parseClientMessageV2(decodeCbor(chunk.subarray(4)));
			if (message.type === "hello") {
				handlers?.onData(
					encodeServerMessageV2({
						type: "hello",
						version: PROTOCOL_V2_VERSION,
						connectionId: "connection-1",
						snapshot: {
							serverId: "server-1",
							protocolVersion: 2,
							revision: 1,
							eventSeq: 1,
							sessions: [],
							models: [],
						},
					}),
				);
				return;
			}
			commands.push(message.request.command);
			const isOperation =
				(message.request.command.startsWith("turn/") && message.request.command !== "turn/queue/cancel") ||
				message.request.command === "session/model/set" ||
				message.request.command === "session/thinking/set" ||
				message.request.command.startsWith("goal/");
			const response = isOperation
				? {
						type: "response" as const,
						id: message.id,
						ok: true as const,
						accepted: { operationId: "operation-1", sessionRevision: 2, eventSeq: 2 },
					}
				: {
						type: "response" as const,
						id: message.id,
						ok: true as const,
						result: (message.request.command === "agent/followUp" || message.request.command === "agent/interrupt"
							? {
									agent: {
										id: "agent-1",
										path: "/root/agent-1",
										taskName: "agent-1",
										state: message.request.command === "agent/interrupt" ? "interrupted" : "complete",
										model: { provider: "faux", id: "model" },
									},
								}
							: message.request.command === "session/read"
								? { session: snapshot(withQueue) }
								: message.request.command === "model/list"
									? {
											models: [
												{
													provider: "openai",
													id: "gpt-5",
													name: "GPT-5",
													api: "openai-responses",
													reasoning: true,
													input: ["text"],
													contextWindow: 128_000,
													maxTokens: 16_000,
													cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
													supportedThinkingLevels: ["off"],
													authenticated: true,
												},
											],
										}
									: message.request.command === "plan/update"
										? { plan: { version: 1, items: [{ step: "ship", status: "pending" }] } }
										: message.request.command === "plugin/list"
											? { plugins: [{ id: "demo", enabled: true }] }
											: message.request.command === "process/list"
												? { processes: [] }
												: { command: message.request.command }) as JsonValue,
					};
			handlers?.onData(encodeServerMessageV2(response));
		},
		close: () => {},
	};
	return {
		client: new PiClientV2({
			transportFactory: async (next) => {
				handlers = next;
				return transport;
			},
		}),
		commands,
	};
}

function createEditor(): CustomEditor {
	initTheme(undefined, false);
	return new CustomEditor(new TuiMainScreen(new VirtualTerminal()), getEditorTheme(), new KeybindingsManager());
}

describe("remote v2 interactive command boundary", () => {
	test("keeps directory completions open for descent while files submit exactly", () => {
		expect(applyRemoteFileCompletion("inspect @src", 8, { reference: "src/nested", kind: "directory" })).toBe(
			"inspect @src/nested/",
		);
		expect(applyRemoteFileCompletion("inspect @src/", 8, { reference: "src/nested/", kind: "directory" })).toBe(
			"inspect @src/nested/",
		);
		expect(applyRemoteFileCompletion("inspect @src", 8, { reference: "src/nested.ts", kind: "file" })).toBe(
			"inspect @src/nested.ts",
		);
		expect(applyRemoteFileCompletion("inspect src", 8, { reference: "src/nested.ts", kind: "file" })).toBe(
			"inspect src/nested.ts",
		);
		expect(applyRemoteFileCompletion('inspect @"src', 8, { reference: "src/nested.ts", kind: "file" })).toBe(
			'inspect @"src/nested.ts"',
		);
		expect(applyRemoteFileCompletion('inspect @"src', 8, { reference: "src/nested", kind: "directory" })).toBe(
			'inspect @"src/nested/',
		);
		expect(
			applyRemoteFileCompletion('inspect @server:"src', 8, { reference: "server:src/nested.ts", kind: "file" }),
		).toBe('inspect @server:"src/nested.ts"');
	});

	test("parses discoverable commands without changing v1 slash commands", () => {
		expect(REMOTE_V2_SLASH_COMMANDS).toContain("/detach");
		expect(parseRemoteV2Command("/follow-up  continue this")).toEqual({ name: "follow-up", text: "continue this" });
		expect(parseRemoteV2Command("/agent-follow-up agent-1 continue work")).toEqual({
			name: "agent-follow-up",
			agentId: "agent-1",
			text: "continue work",
		});
		expect(parseRemoteV2Command("/agent-interrupt agent-1")).toEqual({
			name: "agent-interrupt",
			agentId: "agent-1",
		});
		expect(parseRemoteV2Command("/interrupt-child agent-1")).toEqual({
			name: "interrupt-child",
			agentId: "agent-1",
		});
		expect(parseRemoteV2Command("/agent-message agent-1 inspect the logs")).toEqual({
			name: "agent-message",
			agentId: "agent-1",
			text: "inspect the logs",
		});
		expect(parseRemoteV2Command("/compact")).toEqual({ name: "compact" });
		expect(parseRemoteV2Command("/dequeue queued-image")).toEqual({ name: "dequeue", entryId: "queued-image" });
		expect(parseRemoteV2Command("/compact preserve the API contract")).toEqual({
			name: "compact",
			instructions: "preserve the API contract",
		});
		expect(parseRemoteV2Command("/model")).toEqual({ name: "model" });
		expect(parseRemoteV2Command("/model faux/model-2")).toEqual({ name: "model", provider: "faux", id: "model-2" });
		expect(parseRemoteV2Command("/rollback")).toEqual({ name: "rollback", turns: 1 });
		expect(parseRemoteV2Command("/thinking high")).toEqual({ name: "thinking", level: "high" });
		expect(parseRemoteV2Command("/goal ship the feature")).toEqual({ name: "goal", objective: "ship the feature" });
		expect(parseRemoteV2Command("/goal-pause")).toEqual({ name: "goal-pause" });
		expect(parseRemoteV2Command('/input request-1 {"choice":"yes"}')).toEqual({
			name: "input",
			requestId: "request-1",
			answers: { choice: "yes" },
		});
		expect(parseRemoteV2Command("/input-cancel request-1")).toEqual({ name: "input-cancel", requestId: "request-1" });
		expect(parseRemoteV2Command("/name Project work")).toEqual({ name: "name", value: "Project work" });
		expect(parseRemoteV2Command("/name --clear")).toEqual({ name: "name", clear: true });
		expect(parseRemoteV2Command("/name --generate")).toEqual({ name: "name", generate: true });
		expect(parseRemoteV2Command("/name-auto off")).toEqual({ name: "name-auto", enabled: false });
		expect(parseRemoteV2Command("/name --auto on")).toEqual({ name: "name-auto", enabled: true });
		expect(parseRemoteV2Command('/plan [{"step":"ship","status":"pending"}]')).toEqual({
			name: "plan",
			items: [{ step: "ship", status: "pending" }],
		});
		expect(parseRemoteV2Command("/plan-clear")).toEqual({ name: "plan-clear" });
		expect(parseRemoteV2Command("/plugins")).toEqual({ name: "plugins" });
		expect(parseRemoteV2Command("/settings")).toEqual({ name: "settings" });
		expect(() => parseRemoteV2Command("/plugins demo")).toThrow("does not accept arguments");
		expect(parseRemoteV2Command("/statusline /bin/statusline --json")).toEqual({
			name: "statusline",
			command: "/bin/statusline --json",
		});
		expect(parseRemoteV2Command("/statusline off")).toEqual({ name: "statusline" });
		expect(parseRemoteV2Command("/steer prioritize tests")).toEqual({ name: "steer", text: "prioritize tests" });
		expect(() => parseRemoteV2Command("/rollback 0")).toThrow("positive integer");
		expect(() => parseRemoteV2Command("/agent-interrupt")).toThrow("requires <agent-id>");
		expect(() => parseRemoteV2Command('/input request-1 {"choice":true}')).toThrow("only strings");
		expect(() => parseRemoteV2Command('/plan [{"step":"ship","status":"bad"}]')).toThrow("valid status");
	});

	test("dispatches remote actions through the attached controller and shares cleanup", async () => {
		const { client, commands } = clientWithRequests(true);
		await client.connect();
		const statuslineCommands: (string | undefined)[] = [];
		const attached = await new RemoteV2SessionSelector(client).attachView("session-1", { mode: "control" });
		const attachment = {
			...attached,
			setStatusline: (command: string | undefined) => {
				statuslineCommands.push(command);
			},
		};
		const editor = createEditor();
		const adapter = new RemoteV2InteractiveAttachment(attachment, editor);
		const submit = vi.spyOn(attachment.session, "submit");
		expect(await adapter.execute("/follow-up continue")).toEqual({ kind: "operation", operationId: "operation-1" });
		expect(await adapter.execute("/agent-follow-up agent-1 continue work")).toEqual({
			kind: "status",
			text: "agent complete",
		});
		expect(await adapter.execute("/agent-interrupt agent-1")).toEqual({
			kind: "status",
			text: "agent interrupted",
		});
		expect(await adapter.execute("/interrupt-child agent-1")).toEqual({
			kind: "status",
			text: "agent interrupted",
		});
		expect(await adapter.execute("/agent-message agent-1 inspect the logs")).toEqual({
			kind: "status",
			text: "agent message sent",
		});
		expect(await adapter.execute("/compact preserve context")).toEqual({
			kind: "operation",
			operationId: "operation-1",
		});
		expect(await adapter.execute("/dequeue queued-image")).toEqual({
			kind: "status",
			text: "queued message recalled",
		});
		editor.onSubmit?.(editor.getText());
		await vi.waitFor(() => expect(submit).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ type: "image" })])));
		expect(await adapter.execute("/release-control")).toEqual({ kind: "control", mode: "observer" });
		await adapter.execute("/take-control");
		expect(await adapter.execute("/thinking high")).toEqual({ kind: "operation", operationId: "operation-1" });
		expect(await adapter.execute("/goal ship the feature")).toEqual({
			kind: "operation",
			operationId: "operation-1",
		});
		expect(await adapter.execute('/input request-1 {"choice":"yes"}')).toEqual({
			kind: "status",
			text: "input answered",
		});
		expect(await adapter.execute("/input-cancel request-1")).toEqual({
			kind: "status",
			text: "input cancelled",
		});
		expect(await adapter.execute('/plan [{"step":"ship","status":"pending"}]')).toEqual({
			kind: "status",
			text: "plan updated",
		});
		expect(await adapter.execute("/plan-clear")).toEqual({ kind: "status", text: "plan cleared" });
		expect(await adapter.execute("/plugins")).toEqual({ kind: "status", text: "demo" });
		expect(await adapter.execute("/statusline /bin/statusline --json")).toEqual({
			kind: "status",
			text: "statusline updated",
		});
		expect(await adapter.execute("/statusline off")).toEqual({
			kind: "status",
			text: "statusline disabled",
		});
		expect(statuslineCommands).toEqual(["/bin/statusline --json", undefined]);
		expect(await adapter.execute("/steer prioritize tests")).toEqual({
			kind: "operation",
			operationId: "operation-1",
		});
		expect(await adapter.execute("/detach")).toEqual({ kind: "detached" });
		expect(commands).toEqual([
			"session/attach",
			"session/read",
			"process/list",
			"turn/followUp",
			"agent/followUp",
			"agent/interrupt",
			"agent/interrupt",
			"agent/message",
			"turn/compact",
			"session/read",
			"turn/queue/cancel",
			"turn/start",
			"session/attach",
			"session/attach",
			"session/thinking/set",
			"goal/create",
			"input/request/respond",
			"input/request/cancel",
			"plan/update",
			"plan/clear",
			"plugin/list",
			"turn/start",
			"session/detach",
		]);
		await adapter.dispose();
		client.dispose();
	});

	test("binds remote submission and completion to the standard editor component", async () => {
		const { client, commands } = clientWithRequests();
		await client.connect();
		const attached = await new RemoteV2SessionSelector(client).attachView("session-1", { mode: "control" });
		const editor = createEditor();
		const adapter = new RemoteV2InteractiveAttachment(attached, editor);

		editor.handleInput("hello");
		expect(stripAnsi(editor.render(80).join("\n"))).toContain("hello");
		editor.onSubmit?.(editor.getText());
		await vi.waitFor(() => expect(commands).toContain("turn/start"));
		editor.setText("");
		editor.handleInput("/");
		await vi.waitFor(() => expect(stripAnsi(editor.render(80).join("\n"))).toContain("model"));

		await adapter.dispose();
		client.dispose();
	});

	test("completes model arguments from the server-authoritative catalog", async () => {
		const { client, commands } = clientWithRequests();
		await client.connect();
		const attached = await new RemoteV2SessionSelector(client).attachView("session-1", { mode: "control" });
		const provider = new RemoteV2AutocompleteProvider(attached.session);
		const suggestions = await provider.getSuggestions(["/model gpt"], 0, 10, {
			signal: new AbortController().signal,
		});

		expect(suggestions?.items.map((item) => item.value)).toEqual(["openai/gpt-5"]);
		expect(commands).toContain("model/list");
		await attached.dispose();
		client.dispose();
	});

	test("opens the injected settings selector without a server command", async () => {
		const { client } = clientWithRequests();
		await client.connect();
		const attached = await new RemoteV2SessionSelector(client).attachView("session-1", { mode: "control" });
		const openSettings = vi.fn();
		const adapter = new RemoteV2InteractiveAttachment(attached, undefined, { openSettings });

		expect(await adapter.execute("/settings")).toEqual({ kind: "status", text: "settings opened" });
		expect(openSettings).toHaveBeenCalledOnce();

		await adapter.dispose();
		client.dispose();
	});

	test("opens the injected model selector without a server command", async () => {
		const { client } = clientWithRequests();
		await client.connect();
		const attached = await new RemoteV2SessionSelector(client).attachView("session-1", { mode: "control" });
		const openModel = vi.fn();
		const adapter = new RemoteV2InteractiveAttachment(attached, undefined, { openModel });

		expect(await adapter.execute("/model")).toEqual({ kind: "status", text: "model selector opened" });
		expect(openModel).toHaveBeenCalledOnce();

		await adapter.dispose();
		client.dispose();
	});

	test("provides remote command and file completions to the standard editor", async () => {
		const { client } = clientWithRequests();
		await client.connect();
		const attached = await new RemoteV2SessionSelector(client).attachView("session-1", { mode: "control" });
		const provider = new RemoteV2AutocompleteProvider(attached.session);

		expect(await provider.getSuggestions(["/mo"], 0, 3, { signal: new AbortController().signal })).toEqual(
			expect.objectContaining({
				prefix: "/mo",
				items: expect.arrayContaining([expect.objectContaining({ value: "model" })]),
			}),
		);
		expect(provider.applyCompletion(["/mo"], 0, 3, { value: "model", label: "model" }, "/mo")).toEqual({
			lines: ["/model "],
			cursorLine: 0,
			cursorCol: 7,
		});

		vi.spyOn(attached.session, "completeFiles").mockResolvedValue([
			{
				reference: "@server:src/",
				display: "src/",
				hostScope: "server",
				path: "/project/src",
				canonicalPath: "/project/src",
				kind: "directory",
			},
		]);
		const suggestions = await provider.getSuggestions(["read @server:src"], 0, 16, {
			signal: new AbortController().signal,
		});
		expect(suggestions).toMatchObject({ prefix: "@server:src", items: [{ value: "@server:src/" }] });
		expect(
			provider.applyCompletion(["read @server:src"], 0, 16, suggestions!.items[0]!, suggestions!.prefix),
		).toEqual({ lines: ["read @server:src/"], cursorLine: 0, cursorCol: 17 });

		await attached.dispose();
		client.dispose();
	});
});

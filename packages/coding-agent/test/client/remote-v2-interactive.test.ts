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
	getLastRemoteAssistantText,
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

function snapshot(withQueue = false, id = "session-1", assistantText?: string): SessionSnapshotV2 {
	return {
		id,
		nameRevision: 0,
		revision: 1,
		eventSeq: 1,
		phase: "idle",
		model: { provider: "faux", id: "model" },
		thinkingLevel: "off",
		transcript:
			assistantText === undefined
				? []
				: [
						{
							id: "assistant-1",
							role: "assistant",
							content: [{ type: "text", text: assistantText }],
							timestamp: 1,
							model: { provider: "faux", id: "model" },
							status: "complete",
							stopReason: "stop",
						},
					],
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

function clientWithRequests(withQueue = false, assistantText?: string): { client: PiClientV2; commands: string[] } {
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
								? { session: snapshot(withQueue, message.request.sessionId ?? "session-1", assistantText) }
								: message.request.command === "session/create"
									? { session: snapshot(false, "session-2") }
								: message.request.command === "session/fork"
									? { session: snapshot(false, "session-2") }
									: message.request.command === "session/export"
										? { jsonl: '{"type":"session"}\n' }
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
														{
															provider: "faux",
															id: "model",
															name: "Faux model",
															api: "faux",
															reasoning: false,
															input: ["text"],
															contextWindow: 16_000,
															maxTokens: 4_000,
															cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
															supportedThinkingLevels: ["off"],
															authenticated: true,
														},
													],
												}
											: message.request.command === "resource/list"
												? {
														resources: [
															{ kind: "prompt", name: "commit", description: "Create a commit" },
															{ kind: "skill", name: "skill:review", description: "Review code" },
														],
													}
												: message.request.command === "plan/update"
													? { plan: { version: 1, items: [{ step: "ship", status: "pending" }] } }
													: message.request.command === "plugin/list"
														? { plugins: [{ id: "demo", enabled: true }] }
														: message.request.command === "process/list"
															? { processes: [] }
															: message.request.command === "blob/put"
																? { blob: { digest: "b".repeat(64), mimeType: "image/png", size: 3 } }
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
		expect(REMOTE_V2_SLASH_COMMANDS).toContain("/trust");
		expect(parseRemoteV2Command("/clone")).toEqual({ name: "clone" });
		expect(parseRemoteV2Command("/copy")).toEqual({ name: "copy" });
		expect(parseRemoteV2Command("/debug")).toEqual({ name: "debug" });
		expect(parseRemoteV2Command("/changelog")).toEqual({ name: "changelog" });
		expect(parseRemoteV2Command("/fork")).toEqual({ name: "fork" });
		expect(parseRemoteV2Command("/hotkeys")).toEqual({ name: "hotkeys" });
		expect(parseRemoteV2Command("/tree")).toEqual({ name: "tree" });
		expect(parseRemoteV2Command("/trust")).toEqual({ name: "trust" });
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
		expect(parseRemoteV2Command("/thinking")).toEqual({ name: "thinking" });
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
		expect(parseRemoteV2Command("/new")).toEqual({ name: "new" });
		expect(parseRemoteV2Command("/name --auto on")).toEqual({ name: "name-auto", enabled: true });
		expect(parseRemoteV2Command('/plan [{"step":"ship","status":"pending"}]')).toEqual({
			name: "plan",
			items: [{ step: "ship", status: "pending" }],
		});
		expect(parseRemoteV2Command("/plan-clear")).toEqual({ name: "plan-clear" });
		expect(parseRemoteV2Command("/plugins")).toEqual({ name: "plugins" });
		expect(parseRemoteV2Command("/quit")).toEqual({ name: "quit" });
		expect(parseRemoteV2Command("/settings")).toEqual({ name: "settings" });
		expect(parseRemoteV2Command("/session")).toEqual({ name: "session" });
		expect(parseRemoteV2Command("/scoped-models")).toEqual({ name: "scoped-models" });
		expect(() => parseRemoteV2Command("/plugins demo")).toThrow("does not accept arguments");
		expect(() => parseRemoteV2Command("/trust project")).toThrow("does not accept arguments");
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
		await vi.waitFor(() =>
			expect(submit).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ type: "image" })])),
		);
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
		expect(await adapter.execute("/new")).toEqual({ kind: "status", text: "New session started: session-2" });
		expect(adapter.session.id).toBe("session-2");
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
			"session/create",
			"session/attach",
			"session/read",
			"process/list",
			"session/detach",
			"plugin/list",
			"turn/start",
			"session/detach",
		]);
		await adapter.dispose();
		client.dispose();
	});

	test("restores all queued structured drafts as one editor submission", async () => {
		const { client } = clientWithRequests(true);
		await client.connect();
		const attached = await new RemoteV2SessionSelector(client).attachView("session-1", { mode: "control" });
		const editor = createEditor();
		const adapter = new RemoteV2InteractiveAttachment(attached, editor);
		const submit = vi.spyOn(attached.session, "submit");

		expect(await adapter.dequeueAll()).toBe(1);
		expect(editor.getText()).toContain("restore me");
		editor.onSubmit?.(editor.getText());
		await vi.waitFor(() =>
			expect(submit).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ type: "image" })])),
		);

		await adapter.dispose();
		client.dispose();
	});

	test("uploads a pasted image from the client and submits it as structured content", async () => {
		const { client, commands } = clientWithRequests();
		await client.connect();
		const attached = await new RemoteV2SessionSelector(client).attachView("session-1", { mode: "control" });
		const editor = createEditor();
		const adapter = new RemoteV2InteractiveAttachment(attached, editor, {
			readClipboardImage: async () => ({ bytes: Uint8Array.from([1, 2, 3]), mimeType: "image/png" }),
		});
		const submit = vi.spyOn(attached.session, "submit");

		editor.onPasteImage?.();
		await vi.waitFor(() => expect(commands).toContain("blob/put"));
		editor.onSubmit?.(editor.getText());
		await vi.waitFor(() =>
			expect(submit).toHaveBeenCalledWith([
				expect.objectContaining({ type: "image", digest: "b".repeat(64), mimeType: "image/png" }),
			]),
		);

		await adapter.dispose();
		client.dispose();
	});

	test("routes shell input through the configured remote shell executor", async () => {
		const { client, commands } = clientWithRequests();
		await client.connect();
		const attached = await new RemoteV2SessionSelector(client).attachView("session-1", { mode: "control" });
		const editor = createEditor();
		const executeShell = vi.fn(async () => {});
		const adapter = new RemoteV2InteractiveAttachment(attached, editor, { executeShell });

		editor.setText("!! echo detached");
		editor.onSubmit?.(editor.getText());
		await vi.waitFor(() => expect(executeShell).toHaveBeenCalledWith("echo detached", true));
		expect(commands).not.toContain("turn/start");

		await adapter.dispose();
		client.dispose();
	});

	test("binds remote submission and completion to the standard editor component", async () => {
		const { client, commands } = clientWithRequests();
		await client.connect();
		const attached = await new RemoteV2SessionSelector(client).attachView("session-1", { mode: "control" });
		const editor = createEditor();
		const adapter = new RemoteV2InteractiveAttachment(attached, editor);
		const showStatus = vi.spyOn(adapter.view, "showStatus");

		editor.handleInput("hello");
		expect(stripAnsi(editor.render(80).join("\n"))).toContain("hello");
		editor.onSubmit?.(editor.getText());
		await vi.waitFor(() => expect(commands).toContain("turn/start"));
		editor.setText("");
		editor.handleInput("/");
		await vi.waitFor(() => expect(stripAnsi(editor.render(80).join("\n"))).toContain("model"));
		editor.setText("/plugins");
		editor.onSubmit?.(editor.getText());
		await vi.waitFor(() => expect(showStatus).toHaveBeenCalledWith("demo"));

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

	test("completes thinking levels from the selected server model", async () => {
		const { client, commands } = clientWithRequests();
		await client.connect();
		const attached = await new RemoteV2SessionSelector(client).attachView("session-1", { mode: "control" });
		const provider = new RemoteV2AutocompleteProvider(attached.session);
		const suggestions = await provider.getSuggestions(["/thinking o"], 0, 11, {
			signal: new AbortController().signal,
		});

		expect(suggestions?.items.map((item) => item.value)).toEqual(["off"]);
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

	test("opens the injected project trust selector without a server command", async () => {
		const { client, commands } = clientWithRequests();
		await client.connect();
		const attached = await new RemoteV2SessionSelector(client).attachView("session-1", { mode: "control" });
		const openTrust = vi.fn();
		const adapter = new RemoteV2InteractiveAttachment(attached, undefined, { openTrust });

		expect(await adapter.execute("/trust")).toEqual({ kind: "status", text: "project trust selector opened" });
		expect(openTrust).toHaveBeenCalledOnce();
		expect(commands).not.toContain("turn/start");

		await adapter.dispose();
		client.dispose();
	});

	test("opens injected client-local command output without a server command", async () => {
		const { client, commands } = clientWithRequests();
		await client.connect();
		const attached = await new RemoteV2SessionSelector(client).attachView("session-1", { mode: "control" });
		const showChangelog = vi.fn();
		const showHotkeys = vi.fn();
		const showSession = vi.fn();
		const adapter = new RemoteV2InteractiveAttachment(attached, undefined, {
			showChangelog,
			showHotkeys,
			showSession,
		});

		expect(await adapter.execute("/changelog")).toEqual({ kind: "status", text: "changelog opened" });
		expect(await adapter.execute("/hotkeys")).toEqual({ kind: "status", text: "keyboard shortcuts opened" });
		expect(await adapter.execute("/session")).toEqual({ kind: "status", text: "session information opened" });
		expect(showChangelog).toHaveBeenCalledOnce();
		expect(showHotkeys).toHaveBeenCalledOnce();
		expect(showSession).toHaveBeenCalledOnce();
		expect(commands).not.toContain("turn/start");

		await adapter.dispose();
		client.dispose();
	});

	test("captures attached TUI diagnostics without starting a server turn", async () => {
		const { client, commands } = clientWithRequests();
		await client.connect();
		const attached = await new RemoteV2SessionSelector(client).attachView("session-1", { mode: "control" });
		const showDebug = vi.fn(async () => "/tmp/pi-debug.log");
		const adapter = new RemoteV2InteractiveAttachment(attached, undefined, { showDebug });

		expect(await adapter.execute("/debug")).toEqual({ kind: "status", text: "Debug log written: /tmp/pi-debug.log" });
		expect(showDebug).toHaveBeenCalledOnce();
		expect(commands).not.toContain("turn/start");

		await adapter.dispose();
		client.dispose();
	});

	test("detaches the local TUI through the injected quit callback", async () => {
		const { client } = clientWithRequests();
		await client.connect();
		const attached = await new RemoteV2SessionSelector(client).attachView("session-1", { mode: "control" });
		const quit = vi.fn();
		const adapter = new RemoteV2InteractiveAttachment(attached, undefined, { quit });

		expect(await adapter.execute("/quit")).toEqual({ kind: "status", text: "Detached from session" });
		expect(quit).toHaveBeenCalledOnce();

		await adapter.dispose();
		client.dispose();
	});

	test("copies the latest server assistant text through the local clipboard boundary", async () => {
		const { client } = clientWithRequests(false, "  copied response  ");
		await client.connect();
		const attached = await new RemoteV2SessionSelector(client).attachView("session-1", { mode: "control" });
		const copyText = vi.fn(async () => undefined);
		const adapter = new RemoteV2InteractiveAttachment(attached, undefined, { copyText });

		expect(getLastRemoteAssistantText(attached.session.snapshot)).toBe("copied response");
		expect(await adapter.execute("/copy")).toEqual({
			kind: "status",
			text: "Copied last agent message to clipboard",
		});
		expect(copyText).toHaveBeenCalledWith("copied response");

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

	test("opens the injected scoped model selector without a server command", async () => {
		const { client } = clientWithRequests();
		await client.connect();
		const attached = await new RemoteV2SessionSelector(client).attachView("session-1", { mode: "control" });
		const openScopedModels = vi.fn();
		const adapter = new RemoteV2InteractiveAttachment(attached, undefined, { openScopedModels });

		expect(await adapter.execute("/scoped-models")).toEqual({ kind: "status", text: "model scope opened" });
		expect(openScopedModels).toHaveBeenCalledOnce();

		await adapter.dispose();
		client.dispose();
	});

	test("opens the injected thinking selector without a server command", async () => {
		const { client } = clientWithRequests();
		await client.connect();
		const attached = await new RemoteV2SessionSelector(client).attachView("session-1", { mode: "control" });
		const openThinking = vi.fn();
		const adapter = new RemoteV2InteractiveAttachment(attached, undefined, { openThinking });

		expect(await adapter.execute("/thinking")).toEqual({ kind: "status", text: "thinking selector opened" });
		expect(openThinking).toHaveBeenCalledOnce();

		await adapter.dispose();
		client.dispose();
	});

	test("opens the injected session selector instead of a server turn-resume command", async () => {
		const { client } = clientWithRequests();
		await client.connect();
		const attached = await new RemoteV2SessionSelector(client).attachView("session-1", { mode: "control" });
		const openResume = vi.fn();
		const adapter = new RemoteV2InteractiveAttachment(attached, undefined, { openResume });

		expect(await adapter.execute("/resume")).toEqual({ kind: "status", text: "session selector opened" });
		expect(openResume).toHaveBeenCalledOnce();

		await adapter.dispose();
		client.dispose();
	});

	test("opens the injected fork selector", async () => {
		const { client } = clientWithRequests();
		await client.connect();
		const attached = await new RemoteV2SessionSelector(client).attachView("session-1", { mode: "control" });
		const openFork = vi.fn();
		const adapter = new RemoteV2InteractiveAttachment(attached, undefined, { openFork });

		expect(await adapter.execute("/fork")).toEqual({ kind: "status", text: "fork selector opened" });
		expect(openFork).toHaveBeenCalledOnce();

		await adapter.dispose();
		client.dispose();
	});

	test("clones through the server-owned fork boundary", async () => {
		const { client, commands } = clientWithRequests();
		await client.connect();
		const attached = await new RemoteV2SessionSelector(client).attachView("session-1", { mode: "control" });
		const adapter = new RemoteV2InteractiveAttachment(attached);

		expect(await adapter.execute("/clone")).toEqual({ kind: "status", text: "Cloned to new session: session-2" });
		expect(adapter.session.id).toBe("session-2");
		expect(commands).toContain("session/fork");

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
				items: expect.arrayContaining([
					expect.objectContaining({ value: "model", description: "Select model (opens selector UI)" }),
				]),
			}),
		);
		expect(await provider.commandSuggestions("/detach", new AbortController().signal)).toEqual(
			expect.objectContaining({
				items: expect.arrayContaining([
					expect.objectContaining({
						value: "detach",
						description: "Detach this TUI and leave the server session running",
					}),
				]),
			}),
		);
		expect(await provider.getSuggestions(["/ski"], 0, 4, { signal: new AbortController().signal })).toEqual(
			expect.objectContaining({
				items: expect.arrayContaining([expect.objectContaining({ value: "skill:review" })]),
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

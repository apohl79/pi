import type { Readable } from "node:stream";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { PiClientV2 } from "@earendil-works/pi-client";
import type {
	ModelMetadata,
	ModelRef,
	SessionSnapshotV2,
	TranscriptItem,
	UserTranscriptItem,
} from "@earendil-works/pi-protocol";
import { type RemoteV2PromptContent, RemoteV2Session } from "../../client/remote-v2-session.ts";
import { attachJsonlLineReader } from "../../modes/rpc/jsonl.ts";
import type { RpcCommand } from "../../modes/rpc/rpc-types.ts";
import type { Args } from "../args.ts";

export interface ServerRpcRuntimeOptions {
	readonly daemonStart: () => Promise<unknown>;
	readonly createClient: () => PiClientV2;
	readonly cwd: string;
	readonly options: Args;
	readonly input?: Readable;
	readonly output?: (value: unknown) => void;
}

/** Runs the server-owned core RPC contract while retaining the legacy RPC entry point separately. */
export async function runServerRpc(options: ServerRpcRuntimeOptions): Promise<void> {
	await options.daemonStart();
	const client = options.createClient();
	const output = options.output ?? ((value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`));
	await client.connect();
	let session = await RemoteV2Session.create(client, {
		cwd: options.cwd,
		...(options.options.name === undefined ? {} : { name: options.options.name }),
	});
	const requestedModel = resolveRemoteModel(options.options, await client.listModels());
	const applySessionOptions = async (target: RemoteV2Session): Promise<void> => {
		if (requestedModel !== undefined) await target.waitForOperation(await target.setModel(requestedModel));
		if (options.options.thinking !== undefined)
			await target.waitForOperation(await target.setThinking(options.options.thinking));
	};
	await applySessionOptions(session);
	let previousSnapshot: SessionSnapshotV2 | undefined;
	let unsubscribe = subscribeSession(
		session,
		output,
		() => previousSnapshot,
		(snapshot) => {
			previousSnapshot = snapshot;
		},
	);
	let activeBashProcessId: string | undefined;

	const input = options.input ?? process.stdin;
	const pendingLines = new Set<Promise<void>>();
	let resolveInputEnd!: () => void;
	const inputEnded = new Promise<void>((resolve) => {
		resolveInputEnd = resolve;
	});
	input.once("end", resolveInputEnd);
	const stopReading = attachJsonlLineReader(input, (line) => {
		const pending = handleLine(line).catch((error: unknown) => {
			output({ type: "error", error: error instanceof Error ? error.message : String(error) });
		});
		pendingLines.add(pending);
		void pending.finally(() => pendingLines.delete(pending));
	});

	async function handleLine(line: string): Promise<void> {
		let command: RpcCommand;
		try {
			const parsed: unknown = JSON.parse(line);
			if (!isRpcCommand(parsed)) throw new Error("RPC command must be a JSON object with a string type");
			command = parsed;
		} catch (error) {
			output({ type: "response", success: false, command: "unknown", error: errorMessage(error) });
			return;
		}
		try {
			const response = await dispatch(command);
			if (response !== undefined) output(response);
		} catch (error) {
			output({
				id: command.id,
				type: "response",
				command: command.type,
				success: false,
				error: errorMessage(error),
			});
		}
	}

	async function dispatch(command: RpcCommand): Promise<unknown> {
		const id = command.id;
		switch (command.type) {
			case "prompt":
				if (command.streamingBehavior === "followUp")
					await session.followUp(await promptContent(session, command.message, command.images));
				else await session.submit(await promptContent(session, command.message, command.images));
				return success(id, "prompt");
			case "steer":
				await session.submit(await promptContent(session, command.message, command.images));
				return success(id, "steer");
			case "follow_up":
				await session.followUp(await promptContent(session, command.message, command.images));
				return success(id, "follow_up");
			case "abort":
				await session.abort();
				return success(id, "abort");
			case "bash": {
				const process = await session.startProcess(command.command, { cwd: options.cwd, pty: false });
				activeBashProcessId = process.processId;
				const completed = process.state === "running" ? await session.waitProcess(process.processId) : process;
				activeBashProcessId = undefined;
				return success(id, "bash", {
					output: completed.output,
					exitCode: completed.exitCode,
					cancelled: completed.state === "terminated",
					truncated: completed.truncated,
				});
			}
			case "abort_bash":
				if (activeBashProcessId !== undefined) {
					await session.terminateProcess(activeBashProcessId);
					activeBashProcessId = undefined;
				}
				return success(id, "abort_bash");
			case "compact":
				await session.compact(command.customInstructions);
				return success(id, "compact");
			case "get_state":
				return success(id, "get_state", stateFor(session.snapshot));
			case "set_model":
				await session.setModel({ provider: command.provider, id: command.modelId });
				return success(id, "set_model", { provider: command.provider, id: command.modelId });
			case "get_available_models":
				return success(id, "get_available_models", { models: await client.listModels() });
			case "cycle_model": {
				const models = await client.listModels();
				if (models.length === 0) return success(id, "cycle_model", null);
				const current = session.snapshot?.model;
				const currentIndex = models.findIndex(
					(model) => model.provider === current?.provider && model.id === current.id,
				);
				const model = models[(currentIndex + 1) % models.length];
				await session.setModel({ provider: model.provider, id: model.id });
				return success(id, "cycle_model", model);
			}
			case "set_thinking_level":
				await session.setThinking(command.level);
				return success(id, "set_thinking_level");
			case "set_steering_mode":
				await session.setSteeringMode(command.mode);
				return success(id, "set_steering_mode");
			case "set_follow_up_mode":
				await session.setFollowUpMode(command.mode);
				return success(id, "set_follow_up_mode");
			case "set_auto_compaction":
				await session.setAutoCompaction(command.enabled);
				return success(id, "set_auto_compaction");
			case "set_auto_retry":
				await session.setAutoRetry(command.enabled);
				return success(id, "set_auto_retry");
			case "get_available_thinking_levels":
				return success(id, "get_available_thinking_levels", { levels: THINKING_LEVELS });
			case "cycle_thinking_level": {
				const current = session.snapshot?.thinkingLevel ?? "off";
				const index = THINKING_LEVELS.indexOf(current);
				const level = THINKING_LEVELS[(index + 1) % THINKING_LEVELS.length];
				await session.setThinking(level);
				return success(id, "cycle_thinking_level", { level });
			}
			case "set_session_name":
				await session.setName(command.name.trim());
				return success(id, "set_session_name");
			case "get_session_stats":
				return success(id, "get_session_stats", sessionStats(session.snapshot));
			case "get_last_assistant_text":
				return success(id, "get_last_assistant_text", { text: lastAssistantText(session.snapshot) });
			case "get_messages":
				return success(id, "get_messages", {
					messages: (session.snapshot?.transcript ?? []).map(transcriptMessage).filter(isMessage),
				});
			case "new_session": {
				unsubscribe();
				await session.dispose();
				session = await RemoteV2Session.create(client, {
					cwd: options.cwd,
					...(options.options.name === undefined ? {} : { name: options.options.name }),
				});
				await applySessionOptions(session);
				previousSnapshot = undefined;
				unsubscribe = subscribeSession(
					session,
					output,
					() => previousSnapshot,
					(snapshot) => {
						previousSnapshot = snapshot;
					},
				);
				return success(id, "new_session", { cancelled: false });
			}
			default:
				return {
					id,
					type: "response",
					command: command.type,
					success: false,
					error: "Command requires a v2 adapter",
				};
		}
	}

	await inputEnded;
	await Promise.all(pendingLines);
	stopReading();
}

function resolveRemoteModel(options: Args, models: readonly ModelMetadata[]): ModelRef | undefined {
	if (options.model === undefined && options.provider === undefined) return undefined;
	const requested = options.model?.trim();
	const slash = requested?.indexOf("/") ?? -1;
	const provider = options.provider ?? (slash > 0 ? requested?.slice(0, slash) : undefined);
	const id = slash > 0 ? requested?.slice(slash + 1) : requested;
	if (id === undefined || id.length === 0) throw new Error("Server-default model selection requires --model <model>");
	const matches = models.filter((model) => (provider === undefined || model.provider === provider) && model.id === id);
	if (matches.length > 1 && provider === undefined)
		throw new Error(`Model id is ambiguous: ${id}; specify --provider`);
	const match = matches[0];
	if (match === undefined) throw new Error(`Model not found: ${provider}/${id}`);
	return { provider: match.provider, id: match.id };
}

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

async function promptContent(
	session: RemoteV2Session,
	message: string,
	images: readonly { readonly type: "image"; readonly data: string; readonly mimeType: string }[] | undefined,
): Promise<string | RemoteV2PromptContent> {
	if (images === undefined || images.length === 0) return message;
	const content: Array<RemoteV2PromptContent[number]> = [{ type: "text", text: message }];
	for (const image of images) {
		const blob = await session.putBlob(image.data, image.mimeType, "base64");
		content.push({ type: "image", digest: blob.digest, mimeType: blob.mimeType });
	}
	return content;
}

function subscribeSession(
	session: RemoteV2Session,
	output: (value: unknown) => void,
	previous: () => SessionSnapshotV2 | undefined,
	setPrevious: (snapshot: SessionSnapshotV2) => void,
): () => void {
	return session.subscribe((state) => {
		const snapshot = state.snapshot;
		if (snapshot === undefined) return;
		const before = previous();
		if (state.lifecycle.status === "busy" && before?.phase !== "turn") output({ type: "agent_start" });
		if (before === undefined || snapshot.revision > before.revision) {
			const messages = snapshot.transcript
				.slice(before?.transcript.length ?? 0)
				.map(transcriptMessage)
				.filter(isMessage);
			for (const message of messages) output({ type: "message_end", message });
			if (before?.phase === "turn" && snapshot.phase === "idle")
				output({ type: "agent_end", messages, willRetry: false });
		}
		setPrevious(snapshot);
	});
}

function transcriptMessage(item: TranscriptItem): AgentMessage | undefined {
	if (item.role === "user") return userMessage(item);
	if (item.role !== "assistant") return undefined;
	return {
		role: "assistant",
		content: item.content.flatMap((part) => (part.type === "text" ? [{ type: "text", text: part.text }] : [])),
		api: "unknown",
		provider: item.model.provider,
		model: item.model.id,
		usage: item.usage ?? {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: item.status === "error" ? "error" : item.status === "aborted" ? "aborted" : "stop",
		timestamp: item.timestamp,
	};
}

function userMessage(item: UserTranscriptItem): AgentMessage {
	return {
		role: "user",
		content: item.content.flatMap((part) => (part.type === "text" ? [{ type: "text", text: part.text }] : [])),
		timestamp: item.timestamp,
	};
}

function isMessage(value: AgentMessage | undefined): value is AgentMessage {
	return value !== undefined;
}

function stateFor(snapshot: SessionSnapshotV2 | undefined): Record<string, unknown> {
	if (snapshot === undefined) throw new Error("Server RPC session snapshot is unavailable");
	return {
		model: snapshot.model,
		thinkingLevel: snapshot.thinkingLevel,
		isStreaming: snapshot.phase === "turn",
		isCompacting: snapshot.phase === "compaction",
		steeringMode: snapshot.steeringMode ?? "all",
		followUpMode: snapshot.followUpMode ?? "all",
		sessionId: snapshot.id,
		sessionName: snapshot.name,
		autoCompactionEnabled: snapshot.compactionPolicy.enabled,
		autoRetryEnabled: snapshot.autoRetryEnabled ?? false,
		messageCount: snapshot.transcript.length,
		pendingMessageCount: snapshot.queues.steer.length + snapshot.queues.followUp.length,
	};
}

function sessionStats(snapshot: SessionSnapshotV2 | undefined): Record<string, unknown> {
	if (snapshot === undefined) throw new Error("Server RPC session snapshot is unavailable");
	const userMessages = snapshot.transcript.filter((item) => item.role === "user").length;
	const assistantMessages = snapshot.transcript.filter((item) => item.role === "assistant").length;
	const toolCalls = snapshot.transcript.filter((item) => item.role === "tool").length;
	return {
		sessionFile: undefined,
		sessionId: snapshot.id,
		userMessages,
		assistantMessages,
		toolCalls,
		toolResults: toolCalls,
		totalMessages: snapshot.transcript.length,
		tokens: {
			input: snapshot.usage.input,
			output: snapshot.usage.output,
			cacheRead: snapshot.usage.cacheRead,
			cacheWrite: snapshot.usage.cacheWrite,
			total: snapshot.usage.input + snapshot.usage.output + snapshot.usage.cacheRead + snapshot.usage.cacheWrite,
		},
		cost: snapshot.usage.costUsd ?? 0,
		contextUsage: {
			tokens: snapshot.context.inputTokens,
			contextWindow: snapshot.context.contextWindow,
			percent: snapshot.context.usedPercentage,
		},
	};
}

function lastAssistantText(snapshot: SessionSnapshotV2 | undefined): string | null {
	if (snapshot === undefined) throw new Error("Server RPC session snapshot is unavailable");
	for (const item of [...snapshot.transcript].reverse()) {
		if (item.role !== "assistant") continue;
		return item.content
			.filter((part): part is { type: "text"; text: string } => part.type === "text")
			.map((part) => part.text)
			.join("");
	}
	return null;
}

function success(id: string | undefined, command: string, data?: unknown): Record<string, unknown> {
	return data === undefined
		? { id, type: "response", command, success: true }
		: { id, type: "response", command, success: true, data };
}

function isRpcCommand(value: unknown): value is RpcCommand {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		typeof (value as { type?: unknown }).type === "string"
	);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

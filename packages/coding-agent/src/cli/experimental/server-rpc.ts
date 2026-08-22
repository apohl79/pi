import type { Readable } from "node:stream";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { PiClientV2 } from "@earendil-works/pi-client";
import type { SessionSnapshotV2, TranscriptItem, UserTranscriptItem } from "@earendil-works/pi-protocol";
import { RemoteV2Session } from "../../client/remote-v2-session.ts";
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
	let previousSnapshot: SessionSnapshotV2 | undefined;
	let unsubscribe = subscribeSession(
		session,
		output,
		() => previousSnapshot,
		(snapshot) => {
			previousSnapshot = snapshot;
		},
	);

	const input = options.input ?? process.stdin;
	const stopReading = attachJsonlLineReader(input, (line) => {
		void handleLine(line).catch((error: unknown) => {
			output({ type: "error", error: error instanceof Error ? error.message : String(error) });
		});
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
				if (command.images?.length)
					throw new Error("Server RPC image prompts require blob upload and are not enabled");
				await session.submit(command.message);
				return success(id, "prompt");
			case "steer":
				if (command.images?.length)
					throw new Error("Server RPC image steering requires blob upload and is not enabled");
				await session.submit(command.message);
				return success(id, "steer");
			case "follow_up":
				if (command.images?.length)
					throw new Error("Server RPC image follow-up requires blob upload and is not enabled");
				await session.followUp(command.message);
				return success(id, "follow_up");
			case "abort":
				await session.abort();
				return success(id, "abort");
			case "get_state":
				return success(id, "get_state", stateFor(session.snapshot));
			case "set_model":
				await session.setModel({ provider: command.provider, id: command.modelId });
				return success(id, "set_model", { provider: command.provider, id: command.modelId });
			case "get_available_models":
				return success(id, "get_available_models", { models: await client.listModels() });
			case "set_thinking_level":
				await session.setThinking(command.level);
				return success(id, "set_thinking_level");
			case "set_session_name":
				await session.setName(command.name.trim());
				return success(id, "set_session_name");
			case "new_session": {
				unsubscribe();
				await session.dispose();
				session = await RemoteV2Session.create(client, {
					cwd: options.cwd,
					...(options.options.name === undefined ? {} : { name: options.options.name }),
				});
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

	void stopReading;
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
		steeringMode: "all",
		followUpMode: "all",
		sessionId: snapshot.id,
		sessionName: snapshot.name,
		autoCompactionEnabled: snapshot.compactionPolicy.enabled,
		messageCount: snapshot.transcript.length,
		pendingMessageCount: snapshot.queues.steer.length + snapshot.queues.followUp.length,
	};
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

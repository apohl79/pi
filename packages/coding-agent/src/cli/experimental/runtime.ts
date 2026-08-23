import { lstat, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Readable } from "node:stream";
import type { PiClientV2, PiSessionV2Handle } from "@earendil-works/pi-client";
import { type ClientDiagnosticSpool, mergeClientDiagnosticBundle } from "@earendil-works/pi-client/diagnostics";
import type { CommandV2, JsonValue, ModelMetadata, ModelRef } from "@earendil-works/pi-protocol";
import { verifyDiagnosticBundle } from "@earendil-works/pi-server";
import { type RemoteV2PromptPart, RemoteV2Session } from "../../client/remote-v2-session.ts";
import { processImage } from "../../utils/image-process.ts";
import { stripBom } from "../../utils/text.ts";
import type { Args } from "../args.ts";
import { processFileArguments } from "../file-processor.ts";
import type { ExperimentalCliContext } from "./cli.ts";
import type { AttachCommand } from "./commands/attach.ts";
import type { ClientCommand } from "./commands/client.ts";
import type { DiagnosticsCommand } from "./commands/diagnostics.ts";
import type { PiCommand } from "./commands/pi.ts";
import type { ServerCommand } from "./commands/server.ts";
import type { SessionsCommand } from "./commands/sessions.ts";
import { runServerRpc } from "./server-rpc.ts";
import type { TransportAddress } from "./transport-address.ts";

export type ExperimentalDaemonController = {
	start(socket?: string): Promise<unknown>;
	status(): unknown;
	stop(): Promise<unknown>;
};

export type ExperimentalCliRuntimeOptions = {
	daemon: ExperimentalDaemonController;
	defaultConnect: TransportAddress;
	createClient(address: TransportAddress): PiClientV2;
	diagnosticsSpool?: ClientDiagnosticSpool;
	write(value: unknown): void;
	writeText?(value: string): void;
	runInteractive?(session: RemoteV2Session, options: Args): Promise<void>;
	rpcInput?: Readable;
	rpcOutput?(value: unknown): void;
	onAttach?(handle: PiSessionV2Handle): void | Promise<void>;
};

function resultOf(response: Awaited<ReturnType<PiClientV2["request"]>>): Record<string, unknown> {
	if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`);
	if (
		!("result" in response) ||
		typeof response.result !== "object" ||
		response.result === null ||
		Array.isArray(response.result)
	)
		throw new Error("Expected a command result");
	return response.result as Record<string, unknown>;
}

export type ExperimentalCliRuntime = ExperimentalCliContext & {
	runRpc(options: Args): Promise<void>;
	close(): void;
};

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

async function assertDiagnosticExportDestination(path: string, decryptContent: boolean): Promise<void> {
	if (!decryptContent) return;
	const destination = resolve(path);
	try {
		const stats = await lstat(destination);
		if (!stats.isFile() || stats.isSymbolicLink())
			throw new Error("Decrypted diagnostic export requires a regular, non-symlink output file");
		if ((stats.mode & 0o077) !== 0)
			throw new Error("Refusing decrypted diagnostic export to a group/world-accessible output file");
	} catch (error) {
		if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
		const parent = await lstat(dirname(destination));
		if (!parent.isDirectory() || (parent.mode & 0o077) !== 0)
			throw new Error("Refusing decrypted diagnostic export in a group/world-accessible directory");
	}
}

async function buildRemotePrompt(
	session: RemoteV2Session,
	options: Args,
): Promise<string | readonly RemoteV2PromptPart[]> {
	let text = "";
	const images: Array<{ readonly data: string; readonly mimeType: string }> = [];
	for (const fileArg of options.fileArgs) {
		if (fileArg.startsWith("local:")) {
			const files = await processFileArguments([fileArg.slice("local:".length)]);
			text += files.text;
			images.push(...files.images);
			continue;
		}
		const file = await session.resolveFile(fileArg);
		if (file.kind !== "file") throw new Error(`File reference must resolve to a file: ${fileArg}`);
		const read = await session.readFile(file.reference);
		const data = Buffer.from(read.data, "base64");
		if (file.mimeType?.startsWith("image/")) {
			const processed = await processImage(data, file.mimeType, { autoResizeImages: true });
			if (!processed.ok) {
				text += `<file name="${file.path}">${processed.message}</file>\n`;
				continue;
			}
			images.push({ data: processed.data, mimeType: processed.mimeType });
			text += `<file name="${file.path}">${processed.hints.join("\n")}</file>\n`;
			continue;
		}
		text += `<file name="${file.path}">\n${stripBom(data.toString("utf8"))}\n</file>\n`;
	}
	text += options.messages.join(" ");
	text = text.trim();
	if (images.length === 0) {
		if (!text) throw new Error("Server-default mode requires a prompt or file argument");
		return text;
	}
	const content: RemoteV2PromptPart[] = [];
	if (text) content.push({ type: "text", text });
	for (const image of images) {
		const blob = await session.putBlob(image.data, image.mimeType);
		content.push({ type: "image", digest: blob.digest, mimeType: image.mimeType });
	}
	return content;
}

export function createExperimentalCliRuntime(options: ExperimentalCliRuntimeOptions): ExperimentalCliRuntime {
	const clients = new Set<PiClientV2>();
	const connect = (address: TransportAddress): PiClientV2 => {
		const client = options.createClient(address);
		clients.add(client);
		return client;
	};
	const addressFor = (address: TransportAddress | undefined): TransportAddress => address ?? options.defaultConnect;
	const closeClient = (client: PiClientV2): void => {
		clients.delete(client);
		client.dispose();
	};
	const recordClientDiagnostic = async (event: string, error: unknown): Promise<void> => {
		try {
			await options.diagnosticsSpool?.append({
				event,
				severity: "error",
				fields: { error: error instanceof Error ? error.name : "unknown" },
			});
		} catch {
			// Client crash evidence is best-effort and must not replace the original failure.
		}
	};
	const runServer = async (command: ServerCommand): Promise<void> => {
		const result =
			command.action === "stop"
				? await options.daemon.stop()
				: command.action === "status"
					? options.daemon.status()
					: await options.daemon.start(command.socket);
		options.write(result);
	};
	const runClient = async (command: ClientCommand): Promise<void> => {
		const client = connect(addressFor(command.connect));
		try {
			const snapshot = await client.connect();
			options.write(snapshot);
		} finally {
			closeClient(client);
		}
	};
	const runSessions = async (command: SessionsCommand): Promise<void> => {
		const client = connect(addressFor(command.connect));
		try {
			await client.connect();
			options.write(await client.listSessions());
		} finally {
			closeClient(client);
		}
	};
	const runDiagnostics = async (command: DiagnosticsCommand): Promise<void> => {
		if (command.action === "verify" && command.bundle !== undefined) {
			const bundle = JSON.parse(await readFile(command.bundle, "utf8")) as JsonValue;
			options.write(verifyDiagnosticBundle(bundle));
			return;
		}
		const client = connect(addressFor(command.connect));
		try {
			await client.connect();
			const protocolCommand =
				command.action === "tail" || command.action === "timeline"
					? "diagnostics/timeline"
					: `diagnostics/${command.action}`;
			let afterSeq = command.afterSeq;
			const read = async (): Promise<Record<string, unknown>> => {
				const payload = {
					...(command.sessionId === undefined ? {} : { sessionId: command.sessionId }),
					...(command.operationId === undefined ? {} : { operationId: command.operationId }),
					...(afterSeq === undefined ? {} : { afterSeq }),
					...(command.repairSafe === true ? { repairSafe: true } : {}),
					...(command.decryptContent === true ? { decryptContent: true } : {}),
				};
				const result = resultOf(
					await client.request({ command: protocolCommand as CommandV2["command"], payload }),
				);
				if (command.follow === true && Array.isArray(result.events)) {
					for (const event of result.events) {
						if (typeof event === "object" && event !== null && !Array.isArray(event)) {
							const seq = (event as Record<string, unknown>).seq;
							if (typeof seq === "number" && Number.isSafeInteger(seq)) afterSeq = Math.max(afterSeq ?? 0, seq);
						}
					}
				}
				return result;
			};
			const result = await read();
			if (command.action === "export" && command.output !== undefined) {
				await assertDiagnosticExportDestination(command.output, command.decryptContent === true);
				if (command.decryptContent === true)
					options.write({
						warning:
							"Decrypted diagnostic export may contain source code and conversation data; protect the output file.",
					});
				const bundle = await mergeClientDiagnosticBundle(result.bundle, options.diagnosticsSpool);
				if (typeof bundle !== "object" || bundle === null || Array.isArray(bundle))
					throw new Error("diagnostics/export response did not contain a bundle");
				await writeFile(command.output, `${JSON.stringify(bundle, null, 2)}\n`, { mode: 0o600 });
				options.write({ ...result, bundle });
				return;
			}
			options.write(result);
			if (command.action === "tail" && command.follow === true) {
				for (let idlePolls = 0; idlePolls < 3; idlePolls++) {
					await new Promise((resolve) => setTimeout(resolve, 100));
					const next = await read();
					if (Array.isArray(next.events) && next.events.length > 0) {
						options.write(next);
						idlePolls = 0;
					}
				}
			}
		} finally {
			closeClient(client);
		}
	};
	const runAttach = async (command: AttachCommand): Promise<void> => {
		if (command.sessionId === undefined) throw new Error("attach requires a session id");
		const client = connect(addressFor(command.connect));
		await client.connect();
		const handle = await client.openSession(command.sessionId);
		if (options.onAttach === undefined) {
			options.write(await handle.read());
			closeClient(client);
			return;
		}
		await options.onAttach(handle);
	};
	const runPi = async (command: PiCommand): Promise<void> => {
		await options.daemon.start();
		const client = connect(options.defaultConnect);
		await client.connect();
		const session = await RemoteV2Session.create(client, {
			...(command.options.name === undefined ? {} : { name: command.options.name }),
			cwd: process.cwd(),
		});
		try {
			const model = resolveRemoteModel(command.options, await client.listModels());
			if (model !== undefined) await session.setModel(model);
			if (command.options.thinking !== undefined) await session.setThinking(command.options.thinking);
			const hasPrompt = command.options.messages.length > 0 || command.options.fileArgs.length > 0;
			if (!command.options.print && command.options.mode !== "json") {
				if (hasPrompt) {
					const operationId = await session.submit(await buildRemotePrompt(session, command.options));
					await session.waitForOperation(operationId);
				}
				if (options.runInteractive === undefined)
					throw new Error("Server-default interactive runner is unavailable");
				try {
					await options.runInteractive(session, command.options);
				} catch (error) {
					await recordClientDiagnostic("client.render_failed", error);
					throw error;
				}
				return;
			}
			const operationId = await session.submit(await buildRemotePrompt(session, command.options));
			const snapshot = await session.waitForOperation(operationId);
			if (command.options.mode === "json") {
				options.write(snapshot);
				return;
			}
			const assistant = snapshot.transcript.filter((item) => item.role === "assistant").at(-1);
			const text = assistant?.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("")
				.trim();
			if (options.writeText) options.writeText(text ?? "");
			else options.write(text);
		} finally {
			await session.dispose();
			closeClient(client);
		}
	};
	const runRpc = async (commandOptions: Args): Promise<void> => {
		await runServerRpc({
			daemonStart: () => options.daemon.start(),
			createClient: () => connect(options.defaultConnect),
			cwd: process.cwd(),
			options: commandOptions,
			...(options.rpcInput === undefined ? {} : { input: options.rpcInput }),
			...(options.rpcOutput === undefined ? {} : { output: options.rpcOutput }),
		});
	};
	return {
		runPi,
		runRpc,
		runServer,
		runClient,
		runAttach,
		runSessions,
		runDiagnostics,
		close: () => {
			for (const client of clients) client.dispose();
			clients.clear();
		},
	};
}

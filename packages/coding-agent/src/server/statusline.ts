import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type StatuslineCommand = string | readonly string[];

export interface StatuslineSnapshot {
	readonly command?: StatuslineCommand;
	readonly payloadHash?: string;
	readonly pending: boolean;
	readonly output?: string;
	readonly error?: string;
}

export interface StatuslineRunnerOptions {
	readonly command?: StatuslineCommand;
	readonly timeoutMs?: number;
	readonly maxOutputBytes?: number;
	readonly maxErrorBytes?: number;
	readonly execute?: StatuslineExecutor;
}

export type StatuslineExecutor = (
	command: StatuslineCommand,
	payload: string,
	signal: AbortSignal,
) => Promise<{ readonly stdout: string; readonly stderr: string; readonly exitCode: number }>;

function truncateUtf8(value: string, maxBytes: number): string {
	let truncated = Buffer.from(value, "utf8").subarray(0, maxBytes).toString("utf8");
	while (Buffer.byteLength(truncated, "utf8") > maxBytes) truncated = truncated.slice(0, -1);
	return truncated;
}

const defaultCommand = join(homedir(), ".claude", "statusline.sh");

function defaultExecutor(
	command: StatuslineCommand,
	payload: string,
	signal: AbortSignal,
	maxOutputBytes: number,
	maxErrorBytes: number,
): Promise<{
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number;
}> {
	return new Promise((resolve, reject) => {
		const child =
			typeof command === "string"
				? spawn(command, { shell: true, stdio: ["pipe", "pipe", "pipe"] })
				: spawn(command[0] ?? "", command.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout = truncateUtf8(stdout + chunk.toString("utf8"), maxOutputBytes);
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr = truncateUtf8(stderr + chunk.toString("utf8"), maxErrorBytes);
		});
		child.once("error", reject);
		child.once("close", (exitCode) => resolve({ stdout, stderr, exitCode: exitCode ?? 1 }));
		const abort = (): void => {
			child.kill();
		};
		if (signal.aborted) abort();
		else signal.addEventListener("abort", abort, { once: true });
		child.stdin?.end(payload);
	});
}

export class StatuslineRunner {
	private readonly timeoutMs: number;
	private readonly maxOutputBytes: number;
	private readonly maxErrorBytes: number;
	private readonly execute: StatuslineExecutor;
	private command: StatuslineCommand | undefined;
	private commandKey: string | undefined;
	private payloadHash: string | undefined;
	private snapshotValue: StatuslineSnapshot = { pending: false };
	private inFlight: Promise<StatuslineSnapshot> | undefined;
	private abortController: AbortController | undefined;
	private generation = 0;

	constructor(options: StatuslineRunnerOptions = {}) {
		const configured = options.command ?? (existsSync(defaultCommand) ? defaultCommand : undefined);
		this.command = configured;
		this.commandKey = JSON.stringify(configured);
		this.timeoutMs = options.timeoutMs ?? 2_000;
		this.maxOutputBytes = options.maxOutputBytes ?? 64 * 1024;
		this.maxErrorBytes = options.maxErrorBytes ?? 1_024;
		this.execute =
			options.execute ??
			((command, payload, signal) =>
				defaultExecutor(command, payload, signal, this.maxOutputBytes, this.maxErrorBytes));
		if (!Number.isInteger(this.timeoutMs) || this.timeoutMs <= 0) throw new Error("timeoutMs must be positive");
	}

	get snapshot(): StatuslineSnapshot {
		return structuredClone(this.snapshotValue);
	}

	async update(payload: unknown, command = this.command): Promise<StatuslineSnapshot> {
		const payloadHash = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
		const commandKey = JSON.stringify(command);
		if (commandKey === this.commandKey && payloadHash === this.payloadHash) return this.inFlight ?? this.snapshot;
		const generation = ++this.generation;
		this.abortController?.abort();
		this.command = command;
		this.commandKey = commandKey;
		this.payloadHash = payloadHash;
		if (!command) {
			this.snapshotValue = { pending: false, payloadHash };
			return this.snapshot;
		}
		this.snapshotValue = { command, payloadHash, pending: true };
		const controller = new AbortController();
		this.abortController = controller;
		const run = this.executeWithTimeout(command, JSON.stringify(payload), controller, generation);
		this.inFlight = run;
		try {
			const result = await run;
			return generation === this.generation ? result : this.snapshot;
		} finally {
			if (this.inFlight === run) this.inFlight = undefined;
			if (this.abortController === controller) this.abortController = undefined;
		}
	}

	async dispose(): Promise<void> {
		this.generation += 1;
		this.abortController?.abort();
		await this.inFlight?.catch(() => undefined);
		this.snapshotValue = { pending: false };
		this.payloadHash = undefined;
		this.commandKey = undefined;
	}

	private async executeWithTimeout(
		command: StatuslineCommand,
		payload: string,
		controller: AbortController,
		generation: number,
	): Promise<StatuslineSnapshot> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const result = await Promise.race([
				this.execute(command, payload, controller.signal),
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => {
						controller.abort();
						reject(new Error("statusline timeout"));
					}, this.timeoutMs);
				}),
			]);
			const stdout = truncateUtf8(
				result.stdout.split(/\r?\n/).find((line) => line.trim().length > 0) ?? "",
				this.maxOutputBytes,
			);
			const stderr = truncateUtf8(result.stderr, this.maxErrorBytes);
			if (generation !== this.generation) return this.snapshot;
			this.snapshotValue =
				result.exitCode === 0
					? { command, payloadHash: this.payloadHash, pending: false, output: stdout }
					: { command, payloadHash: this.payloadHash, pending: false, error: stderr || `exit ${result.exitCode}` };
			return this.snapshot;
		} catch (error) {
			if (generation !== this.generation) return this.snapshot;
			this.snapshotValue = {
				command,
				payloadHash: this.payloadHash,
				pending: false,
				error: error instanceof Error ? error.message.slice(0, this.maxErrorBytes) : "statusline failed",
			};
			return this.snapshot;
		} finally {
			if (timer !== undefined) clearTimeout(timer);
		}
	}
}

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface StatuslineSnapshot {
	readonly command?: string;
	readonly payloadHash?: string;
	readonly pending: boolean;
	readonly output?: string;
	readonly error?: string;
}

export interface StatuslineRunnerOptions {
	readonly command?: string;
	readonly timeoutMs?: number;
	readonly maxOutputBytes?: number;
	readonly maxErrorBytes?: number;
	readonly execute?: StatuslineExecutor;
}

export type StatuslineExecutor = (
	command: string,
	payload: string,
	signal: AbortSignal,
) => Promise<{ readonly stdout: string; readonly stderr: string; readonly exitCode: number }>;

const defaultCommand = join(homedir(), ".claude", "statusline.sh");

function defaultExecutor(
	command: string,
	payload: string,
	signal: AbortSignal,
): Promise<{
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number;
}> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, { shell: true, stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
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
	private command: string | undefined;
	private payloadHash: string | undefined;
	private snapshotValue: StatuslineSnapshot = { pending: false };
	private inFlight: Promise<StatuslineSnapshot> | undefined;
	private abortController: AbortController | undefined;

	constructor(options: StatuslineRunnerOptions = {}) {
		const configured = options.command ?? (existsSync(defaultCommand) ? defaultCommand : undefined);
		this.command = configured;
		this.timeoutMs = options.timeoutMs ?? 2_000;
		this.maxOutputBytes = options.maxOutputBytes ?? 64 * 1024;
		this.maxErrorBytes = options.maxErrorBytes ?? 1_024;
		this.execute = options.execute ?? defaultExecutor;
		if (!Number.isInteger(this.timeoutMs) || this.timeoutMs <= 0) throw new Error("timeoutMs must be positive");
	}

	get snapshot(): StatuslineSnapshot {
		return structuredClone(this.snapshotValue);
	}

	async update(payload: unknown, command = this.command): Promise<StatuslineSnapshot> {
		const payloadHash = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
		if (command === this.command && payloadHash === this.payloadHash) return this.inFlight ?? this.snapshot;
		this.abortController?.abort();
		this.command = command;
		this.payloadHash = payloadHash;
		if (!command) {
			this.snapshotValue = { pending: false, payloadHash };
			return this.snapshot;
		}
		this.snapshotValue = { command, payloadHash, pending: true };
		const controller = new AbortController();
		this.abortController = controller;
		const run = this.executeWithTimeout(command, JSON.stringify(payload), controller);
		this.inFlight = run;
		try {
			return await run;
		} finally {
			if (this.inFlight === run) this.inFlight = undefined;
			if (this.abortController === controller) this.abortController = undefined;
		}
	}

	async dispose(): Promise<void> {
		this.abortController?.abort();
		await this.inFlight?.catch(() => undefined);
		this.snapshotValue = { pending: false };
		this.payloadHash = undefined;
	}

	private async executeWithTimeout(
		command: string,
		payload: string,
		controller: AbortController,
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
			const stdout = result.stdout.slice(0, this.maxOutputBytes);
			const stderr = result.stderr.slice(0, this.maxErrorBytes);
			this.snapshotValue =
				result.exitCode === 0
					? { command, payloadHash: this.payloadHash, pending: false, output: stdout }
					: { command, payloadHash: this.payloadHash, pending: false, error: stderr || `exit ${result.exitCode}` };
			return this.snapshot;
		} catch (error) {
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

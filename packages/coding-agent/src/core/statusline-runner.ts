import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";

const DEFAULT_TIMEOUT_MS = 2_000;
const MAX_STDOUT_BYTES = 64 * 1024;
const MAX_STDERR_BYTES = 1024;

export type StatuslineCommand = string | readonly [string, ...string[]];

export type StatuslineResult =
	| { readonly status: "success"; readonly output: string; readonly cached: boolean }
	| {
			readonly status: "error";
			readonly reason: "launch" | "timeout" | "exit" | "output";
			readonly message: string;
			readonly stderr: string;
			readonly cached: boolean;
	  };

export interface StatuslineRunnerOptions {
	readonly timeoutMs?: number;
}

/** Runs a local Claude/Codex-compatible statusline command with bounded I/O. */
export class StatuslineRunner {
	readonly #timeoutMs: number;
	#active: ChildProcess | undefined;
	#lastKey: string | undefined;
	#lastResult: StatuslineResult | undefined;
	#disposed = false;

	constructor(options: StatuslineRunnerOptions = {}) {
		this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs <= 0)
			throw new Error("statusline timeoutMs must be a positive integer");
	}

	async run(command: StatuslineCommand, payload: unknown): Promise<StatuslineResult> {
		if (this.#disposed) throw new Error("Statusline runner is disposed");
		const key = createHash("sha256")
			.update(JSON.stringify([command, payload]))
			.digest("hex");
		if (key === this.#lastKey && this.#lastResult !== undefined) return { ...this.#lastResult, cached: true };
		this.#active?.kill("SIGTERM");
		const result = await this.execute(command, JSON.stringify(payload));
		this.#lastKey = key;
		this.#lastResult = result;
		return result;
	}

	dispose(): void {
		this.#disposed = true;
		this.#active?.kill("SIGTERM");
		this.#active = undefined;
	}

	private execute(command: StatuslineCommand, input: string): Promise<StatuslineResult> {
		return new Promise((resolve) => {
			const [file, args, options] =
				typeof command === "string"
					? [command, [], { shell: true }]
					: [command[0], command.slice(1), { shell: false }];
			let child: ChildProcess;
			try {
				child = spawn(file, args, { ...options, stdio: ["pipe", "pipe", "pipe"] });
			} catch (error) {
				resolve({
					status: "error",
					reason: "launch",
					message: error instanceof Error ? error.message : String(error),
					stderr: "",
					cached: false,
				});
				return;
			}
			this.#active = child;
			const stdout: Buffer[] = [];
			const stderr: Buffer[] = [];
			let stdoutBytes = 0;
			let stderrBytes = 0;
			let timedOut = false;
			let settled = false;
			const append = (chunks: Buffer[], chunk: Buffer, current: number, limit: number): number => {
				if (current >= limit) return current;
				const remaining = Math.min(chunk.byteLength, limit - current);
				chunks.push(chunk.subarray(0, remaining));
				return current + remaining;
			};
			const finish = (result: StatuslineResult): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				if (this.#active === child) this.#active = undefined;
				resolve(result);
			};
			const timeout = setTimeout(() => {
				timedOut = true;
				child.kill("SIGTERM");
			}, this.#timeoutMs);
			child.stdout?.on("data", (chunk: Buffer) => {
				stdoutBytes = append(stdout, chunk, stdoutBytes, MAX_STDOUT_BYTES);
				if (stdoutBytes >= MAX_STDOUT_BYTES) child.kill("SIGTERM");
			});
			child.stderr?.on("data", (chunk: Buffer) => {
				stderrBytes = append(stderr, chunk, stderrBytes, MAX_STDERR_BYTES);
			});
			child.once("error", (error) =>
				finish({
					status: "error",
					reason: "launch",
					message: error.message,
					stderr: Buffer.concat(stderr).toString(),
					cached: false,
				}),
			);
			child.once("close", (code) => {
				const errorOutput = Buffer.concat(stderr).toString().trim();
				if (timedOut) {
					finish({
						status: "error",
						reason: "timeout",
						message: "statusline command timed out",
						stderr: errorOutput,
						cached: false,
					});
					return;
				}
				if (stdoutBytes >= MAX_STDOUT_BYTES) {
					finish({
						status: "error",
						reason: "output",
						message: "statusline stdout exceeded 64 KiB",
						stderr: errorOutput,
						cached: false,
					});
					return;
				}
				if (code !== 0) {
					finish({
						status: "error",
						reason: "exit",
						message: `statusline command exited with code ${code ?? "unknown"}`,
						stderr: errorOutput,
						cached: false,
					});
					return;
				}
				const output =
					Buffer.concat(stdout)
						.toString()
						.split(/\r?\n/)
						.find((line) => line.trim().length > 0)
						?.trim() ?? "";
				finish(
					output.length === 0
						? {
								status: "error",
								reason: "output",
								message: "statusline command produced no output",
								stderr: errorOutput,
								cached: false,
							}
						: { status: "success", output, cached: false },
				);
			});
			child.stdin?.end(input);
		});
	}
}

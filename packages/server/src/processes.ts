import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";

export type V2ProcessState = "running" | "exited" | "terminated" | "lost";

export type V2ProcessStartRequest = Readonly<{
	sessionId: string;
	command: string;
	cwd?: string;
	env?: Readonly<Record<string, string>>;
	pty?: boolean;
}>;

export type V2ProcessOutput = Readonly<{ output: string; cursor: number; truncated: boolean }>;

export interface V2ProcessSnapshot extends V2ProcessOutput {
	readonly processId: string;
	readonly sessionId: string;
	readonly command: string;
	readonly pty: boolean;
	readonly state: V2ProcessState;
	readonly exitCode?: number;
}

export interface V2ProcessRegistry {
	start(request: V2ProcessStartRequest): Promise<V2ProcessSnapshot>;
	getSnapshot(processId: string): Promise<V2ProcessSnapshot>;
	write(processId: string, input: string): Promise<V2ProcessOutput>;
	read(processId: string, cursor: number): Promise<V2ProcessOutput>;
	wait(processId: string): Promise<V2ProcessSnapshot>;
	terminate(processId: string): Promise<V2ProcessSnapshot>;
}

/** Host-provided PTY launcher; the server keeps PTY ownership behind this boundary. */
export interface V2PtyLauncher {
	spawn(request: V2ProcessStartRequest): ChildProcess;
}

interface ProcessState {
	readonly processId: string;
	readonly sessionId: string;
	readonly command: string;
	readonly pty: boolean;
	state: V2ProcessState;
	exitCode?: number;
	output: Buffer;
	totalBytes: number;
};

const parseCommand = (command: string): readonly [string, ...string[]] => {
	if (command.trim().length === 0 || /[\0\n\r;&|<>`$]/u.test(command)) throw new Error("Unsupported process command");
	const args: string[] = [];
	let value = "";
	let quote: '"' | "'" | undefined;
	let escaped = false;
	const push = (): void => {
		if (value.length > 0) args.push(value);
		value = "";
	};
	for (const character of command) {
		if (escaped) {
			value += character;
			escaped = false;
		} else if (character === "\\" && quote !== "'") escaped = true;
		else if (quote !== undefined && character === quote) quote = undefined;
		else if (quote === undefined && (character === '"' || character === "'")) quote = character;
		else if (quote === undefined && /\s/u.test(character)) push();
		else value += character;
	}
	if (escaped || quote !== undefined) throw new Error("Unsupported process command");
	push();
	if (args.length === 0) throw new Error("Unsupported process command");
	return args as readonly [string, ...string[]];
};

const retainOutput = (output: Buffer, maxBytes: number): Buffer => {
	const retained = output.length <= maxBytes ? output : output.subarray(output.length - maxBytes);
	let start = 0;
	while (start < retained.length && (retained[start] & 0xc0) === 0x80) start += 1;
	let end = retained.length;
	while (end > start) {
		try {
			new TextDecoder("utf-8", { fatal: true }).decode(retained.subarray(start, end));
			return retained.subarray(start, end);
		} catch {
			end -= 1;
		}
	}
	return Buffer.alloc(0);
};

const outputView = (process: ProcessState, cursor: number): V2ProcessOutput => {
	if (!Number.isInteger(cursor) || cursor < 0) throw new Error("Process cursor must be a non-negative integer");
	const baseCursor = process.totalBytes - process.output.length;
	let outputOffset = Math.max(cursor, baseCursor) - baseCursor;
	while (outputOffset < process.output.length && (process.output[outputOffset] & 0xc0) === 0x80) outputOffset += 1;
	return {
		output: process.output.subarray(outputOffset).toString("utf8"),
		cursor: process.totalBytes,
		truncated: cursor < baseCursor,
	};
};

const appendOutput = (process: ProcessState, value: Buffer, maxBytes: number): void => {
	process.totalBytes += value.length;
	process.output = retainOutput(Buffer.concat([process.output, value]), maxBytes);
};

const snapshot = (process: ProcessState): V2ProcessSnapshot => ({
	processId: process.processId,
	sessionId: process.sessionId,
	command: process.command,
	state: process.state,
	...(process.exitCode === undefined ? {} : { exitCode: process.exitCode }),
	output: process.output.toString("utf8"),
	cursor: process.totalBytes,
	truncated: process.totalBytes > process.output.length,
});

export class InMemoryV2ProcessRegistry implements V2ProcessRegistry {
	private readonly maxOutputBytes: number;
	private readonly processes = new Map<string, ProcessState>();
	private readonly waiters = new Map<string, Array<(value: V2ProcessSnapshot) => void>>();

	constructor(options: { maxOutputBytes?: number } = {}) {
		this.maxOutputBytes = options.maxOutputBytes ?? 64 * 1024;
	}

	async start(request: V2ProcessStartRequest): Promise<V2ProcessSnapshot> {
		const process: ProcessState = {
			processId: randomUUID(),
			sessionId: request.sessionId,
			command: request.command,
			pty: request.pty === true,
			state: "running",
			output: "",
			totalBytes: 0,
		};
		this.processes.set(process.processId, process);
		return snapshot(process);
	}

	async write(processId: string, input: string): Promise<V2ProcessOutput> {
		const process = this.get(processId);
		if (process.state !== "running") throw new Error(`Process ${processId} is not running`);
		const cursor = process.totalBytes;
		appendOutput(process, Buffer.from(input), this.maxOutputBytes);
		return outputView(process, cursor);
	}

	getSnapshot(processId: string): Promise<V2ProcessSnapshot> {
		return Promise.resolve(this.snapshot(this.get(processId)));
	}

	getSnapshot(processId: string): Promise<V2ProcessSnapshot> {
		return Promise.resolve(this.snapshot(this.get(processId)));
	}

	getSnapshot(processId: string): Promise<V2ProcessSnapshot> {
		return Promise.resolve(this.snapshot(this.get(processId)));
	}

	getSnapshot(processId: string): Promise<V2ProcessSnapshot> {
		return Promise.resolve(this.snapshot(this.get(processId)));
	}

	getSnapshot(processId: string): Promise<V2ProcessSnapshot> {
		return Promise.resolve(this.snapshot(this.get(processId)));
	}

	getSnapshot(processId: string): Promise<V2ProcessSnapshot> {
		return Promise.resolve(this.snapshot(this.get(processId)));
	}

	getSnapshot(processId: string): Promise<V2ProcessSnapshot> {
		return Promise.resolve(this.snapshot(this.get(processId)));
	}

	getSnapshot(processId: string): Promise<V2ProcessSnapshot> {
		return Promise.resolve(this.snapshot(this.get(processId)));
	}

	getSnapshot(processId: string): Promise<V2ProcessSnapshot> {
		return Promise.resolve(this.snapshot(this.get(processId)));
	}

	getSnapshot(processId: string): Promise<V2ProcessSnapshot> {
		return Promise.resolve(this.snapshot(this.get(processId)));
	}

	getSnapshot(processId: string): Promise<V2ProcessSnapshot> {
		return Promise.resolve(this.snapshot(this.get(processId)));
	}

	getSnapshot(processId: string): Promise<V2ProcessSnapshot> {
		return Promise.resolve(this.snapshot(this.get(processId)));
	}

	getSnapshot(processId: string): Promise<V2ProcessSnapshot> {
		return Promise.resolve(this.snapshot(this.get(processId)));
	}

	getSnapshot(processId: string): Promise<V2ProcessSnapshot> {
		return Promise.resolve(this.snapshot(this.get(processId)));
	}

	getSnapshot(processId: string): Promise<V2ProcessSnapshot> {
		return Promise.resolve(this.snapshot(this.get(processId)));
	}

	getSnapshot(processId: string): Promise<V2ProcessSnapshot> {
		return Promise.resolve(this.snapshot(this.get(processId)));
	}

	async read(processId: string, cursor: number): Promise<V2ProcessOutput> {
		const process = this.get(processId);
		return process.state === "running" ? new Promise((resolve) => this.waiters.set(processId, [...(this.waiters.get(processId) ?? []), resolve])) : Promise.resolve(snapshot(process));
	}

	async terminate(processId: string): Promise<V2ProcessSnapshot> {
		const process = this.get(processId);
		if (process.state === "running") {
			process.state = "terminated";
			process.exitCode = 143;
			const result = snapshot(process);
			for (const resolve of this.waiters.get(processId) ?? []) resolve(result);
			this.waiters.delete(processId);
		}
		return this.snapshot(process);
	}

	private append(process: ProcessState, value: string): void {
		process.totalBytes += value.length;
		process.output = `${process.output}${value}`.slice(-this.maxOutputBytes);
	}

	private snapshot(process: ProcessState): V2ProcessSnapshot {
		const baseCursor = process.totalBytes - process.output.length;
		return {
			processId: process.processId,
			sessionId: process.sessionId,
			command: process.command,
			pty: process.pty,
			state: process.state,
			...(process.exitCode === undefined ? {} : { exitCode: process.exitCode }),
			output: process.output,
			cursor: process.totalBytes,
			truncated: baseCursor > 0,
		};
	}

	private get(processId: string): ProcessState {
		const process = this.processes.get(processId);
		if (!process) throw new Error(`Unknown process ${processId}`);
		return process;
	}
}

type NodeProcessState = ProcessState & Readonly<{ child: ChildProcess }> & {
	waiters: Array<(value: V2ProcessSnapshot) => void>;
	decoder: StringDecoder;
	decoderFlushed: boolean;
	capacityReleased: boolean;
	queuedWriteBytes: number;
	terminationTimer?: ReturnType<typeof setTimeout>;
	killTimer?: ReturnType<typeof setTimeout>;
};

type NodeV2ProcessRegistryOptions = Readonly<{
	maxOutputBytes?: number;
	maxCompletedProcesses?: number;
	maxActiveProcesses?: number;
	maxWriteBytes?: number;
	maxQueuedWriteBytes?: number;
	terminateGraceMs?: number;
	terminateTimeoutMs?: number;
}>;

const validatePositiveInteger = (name: string, value: number | undefined, fallback: number): number => {
	const resolved = value ?? fallback;
	if (!Number.isInteger(resolved) || resolved <= 0) throw new Error(`${name} must be a positive integer`);
	return resolved;
};

function spawnNodeProcess(request: V2ProcessStartRequest, ptyLauncher?: V2PtyLauncher): ChildProcess {
	if (request.pty) {
		if (!ptyLauncher) throw new Error("PTY process execution requires a host PTY launcher");
		return ptyLauncher.spawn(request);
	}
	return spawn(request.command, {
		shell: true,
		cwd: request.cwd,
		env: { ...process.env, ...request.env },
		stdio: ["pipe", "pipe", "pipe"],
	});
}

function spawnNodeProcess(request: V2ProcessStartRequest, ptyLauncher?: V2PtyLauncher): ChildProcess {
	if (request.pty) {
		if (!ptyLauncher) throw new Error("PTY process execution requires a host PTY launcher");
		return ptyLauncher.spawn(request);
	}
	return spawn(request.command, {
		shell: true,
		cwd: request.cwd,
		env: { ...process.env, ...request.env },
		stdio: ["pipe", "pipe", "pipe"],
	});
}

function spawnNodeProcess(request: V2ProcessStartRequest, ptyLauncher?: V2PtyLauncher): ChildProcess {
	if (request.pty) {
		if (!ptyLauncher) throw new Error("PTY process execution requires a host PTY launcher");
		return ptyLauncher.spawn(request);
	}
	return spawn(request.command, {
		shell: true,
		cwd: request.cwd,
		env: { ...process.env, ...request.env },
		stdio: ["pipe", "pipe", "pipe"],
	});
}

function spawnNodeProcess(request: V2ProcessStartRequest, ptyLauncher?: V2PtyLauncher): ChildProcess {
	if (request.pty) {
		if (!ptyLauncher) throw new Error("PTY process execution requires a host PTY launcher");
		return ptyLauncher.spawn(request);
	}
	return spawn(request.command, {
		shell: true,
		cwd: request.cwd,
		env: { ...process.env, ...request.env },
		stdio: ["pipe", "pipe", "pipe"],
	});
}

function spawnNodeProcess(request: V2ProcessStartRequest, ptyLauncher?: V2PtyLauncher): ChildProcess {
	if (request.pty) {
		if (!ptyLauncher) throw new Error("PTY process execution requires a host PTY launcher");
		return ptyLauncher.spawn(request);
	}
	return spawn(request.command, {
		shell: true,
		cwd: request.cwd,
		env: { ...process.env, ...request.env },
		stdio: ["pipe", "pipe", "pipe"],
	});
}

function spawnNodeProcess(request: V2ProcessStartRequest, ptyLauncher?: V2PtyLauncher): ChildProcess {
	if (request.pty) {
		if (!ptyLauncher) throw new Error("PTY process execution requires a host PTY launcher");
		return ptyLauncher.spawn(request);
	}
	return spawn(request.command, {
		shell: true,
		cwd: request.cwd,
		env: { ...process.env, ...request.env },
		stdio: ["pipe", "pipe", "pipe"],
	});
}

function spawnNodeProcess(request: V2ProcessStartRequest, ptyLauncher?: V2PtyLauncher): ChildProcess {
	if (request.pty) {
		if (!ptyLauncher) throw new Error("PTY process execution requires a host PTY launcher");
		return ptyLauncher.spawn(request);
	}
	return spawn(request.command, {
		shell: true,
		cwd: request.cwd,
		env: { ...process.env, ...request.env },
		stdio: ["pipe", "pipe", "pipe"],
	});
}

function spawnNodeProcess(request: V2ProcessStartRequest, ptyLauncher?: V2PtyLauncher): ChildProcess {
	if (request.pty) {
		if (!ptyLauncher) throw new Error("PTY process execution requires a host PTY launcher");
		return ptyLauncher.spawn(request);
	}
	return spawn(request.command, {
		shell: true,
		cwd: request.cwd,
		env: { ...process.env, ...request.env },
		stdio: ["pipe", "pipe", "pipe"],
	});
}

function spawnNodeProcess(request: V2ProcessStartRequest, ptyLauncher?: V2PtyLauncher): ChildProcess {
	if (request.pty) {
		if (!ptyLauncher) throw new Error("PTY process execution requires a host PTY launcher");
		return ptyLauncher.spawn(request);
	}
	return spawn(request.command, {
		shell: true,
		cwd: request.cwd,
		env: { ...process.env, ...request.env },
		stdio: ["pipe", "pipe", "pipe"],
	});
}

function spawnNodeProcess(request: V2ProcessStartRequest, ptyLauncher?: V2PtyLauncher): ChildProcess {
	if (request.pty) {
		if (!ptyLauncher) throw new Error("PTY process execution requires a host PTY launcher");
		return ptyLauncher.spawn(request);
	}
	return spawn(request.command, {
		shell: true,
		cwd: request.cwd,
		env: { ...process.env, ...request.env },
		stdio: ["pipe", "pipe", "pipe"],
	});
}

function spawnNodeProcess(request: V2ProcessStartRequest, ptyLauncher?: V2PtyLauncher): ChildProcess {
	if (request.pty) {
		if (!ptyLauncher) throw new Error("PTY process execution requires a host PTY launcher");
		return ptyLauncher.spawn(request);
	}
	return spawn(request.command, {
		shell: true,
		cwd: request.cwd,
		env: { ...process.env, ...request.env },
		stdio: ["pipe", "pipe", "pipe"],
	});
}

function spawnNodeProcess(request: V2ProcessStartRequest, ptyLauncher?: V2PtyLauncher): ChildProcess {
	if (request.pty) {
		if (!ptyLauncher) throw new Error("PTY process execution requires a host PTY launcher");
		return ptyLauncher.spawn(request);
	}
	return spawn(request.command, {
		shell: true,
		cwd: request.cwd,
		env: { ...process.env, ...request.env },
		stdio: ["pipe", "pipe", "pipe"],
	});
}

function spawnNodeProcess(request: V2ProcessStartRequest, ptyLauncher?: V2PtyLauncher): ChildProcess {
	if (request.pty) {
		if (!ptyLauncher) throw new Error("PTY process execution requires a host PTY launcher");
		return ptyLauncher.spawn(request);
	}
	const argv = parseArgv(request.command);
	return spawn(argv[0]!, argv.slice(1), {
		shell: false,
		cwd: request.cwd,
		env: { ...process.env, ...request.env },
		stdio: ["pipe", "pipe", "pipe"],
	});
}

const FORBIDDEN_SHELL_CHARACTERS = new Set([";", "|", "&", ">", "<", "`", "$", "(", ")"]);

/** Parse the restricted argv-like process command without invoking a shell. */
function parseArgv(command: string): string[] {
	if (command.length === 0 || command.length > 8_192) throw new Error("Process command must be 1-8192 characters");
	const argv: string[] = [];
	let token = "";
	let tokenStarted = false;
	let quote: "single" | "double" | undefined;
	for (let index = 0; index < command.length; index += 1) {
		const character = command[index]!;
		if (quote === "single") {
			if (character === "'") quote = undefined;
			else token += character;
			tokenStarted = true;
			continue;
		}
		if (quote === "double") {
			if (character === '"') quote = undefined;
			else if (character === "\\") {
				const next = command[++index];
				if (next === undefined) throw new Error("Process command has a trailing escape");
				token += next;
			} else token += character;
			tokenStarted = true;
			continue;
		}
		if (FORBIDDEN_SHELL_CHARACTERS.has(character)) throw new Error("Process command contains shell metacharacters");
		if (character === "'" || character === '"') {
			quote = character === "'" ? "single" : "double";
			tokenStarted = true;
		} else if (character === "\\") {
			const next = command[++index];
			if (next === undefined) throw new Error("Process command has a trailing escape");
			token += next;
			tokenStarted = true;
		} else if (/\s/.test(character)) {
			if (tokenStarted) {
				argv.push(token);
				token = "";
				tokenStarted = false;
			}
		} else {
			token += character;
			tokenStarted = true;
		}
	}
	if (quote !== undefined) throw new Error("Process command has an unterminated quote");
	if (tokenStarted) argv.push(token);
	if (argv.length === 0) throw new Error("Process command cannot be empty");
	return argv;
}

export class NodeV2ProcessRegistry implements V2ProcessRegistry {
	private readonly maxOutputBytes: number;
	private readonly ptyLauncher: V2PtyLauncher | undefined;
	private readonly processes = new Map<string, NodeProcessState>();
	private activeProcesses = 0;

	constructor(options: { maxOutputBytes?: number; ptyLauncher?: V2PtyLauncher } = {}) {
		this.maxOutputBytes = options.maxOutputBytes ?? 64 * 1024;
		this.ptyLauncher = options.ptyLauncher;
	}

	async start(request: V2ProcessStartRequest): Promise<V2ProcessSnapshot> {
		const child = spawnNodeProcess(request, this.ptyLauncher);
		const state: NodeProcessState = {
			processId: randomUUID(),
			sessionId: request.sessionId,
			command: request.command,
			pty: request.pty === true,
			state: "running",
			output: "",
			totalBytes: 0,
			child,
			waiters: [],
		};
		this.processes.set(state.processId, state);
		const append = (chunk: Buffer): void => {
			const decoded = Buffer.from(state.decoder.write(chunk));
			state.output = retainOutput(Buffer.concat([state.output, decoded]), this.maxOutputBytes);
			state.totalBytes += decoded.length;
		};
		child.stdout?.on("data", append);
		child.stderr?.on("data", append);
		child.once("error", (error) => { this.finish(state, "exited", 1, Buffer.from(error.message)); });
		child.once("close", (code) => this.finish(state, state.state === "terminated" ? "terminated" : "exited", code ?? 0));
		return Promise.resolve(snapshot(state));
	}

	async write(processId: string, input: string): Promise<V2ProcessOutput> {
		const process = this.get(processId);
		if (process.state !== "running" || !process.child.stdin) throw new Error(`Process ${processId} is not running`);
		const inputBytes = Buffer.byteLength(input, "utf8");
		if (inputBytes > this.maxWriteBytes) throw new Error(`Process write exceeds maxWriteBytes (${this.maxWriteBytes})`);
		if (process.queuedWriteBytes + inputBytes > this.maxQueuedWriteBytes) throw new Error(`Process queued writes exceed maxQueuedWriteBytes (${this.maxQueuedWriteBytes})`);
		const cursor = process.totalBytes;
		process.queuedWriteBytes += inputBytes;
		await new Promise<void>((resolve, reject) => {
			process.child.stdin.write(input, (error?: Error) => {
				process.queuedWriteBytes -= inputBytes;
				if (error) reject(error);
				else resolve();
			});
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
		return outputView(process, cursor);
	}

	getSnapshot(processId: string): Promise<V2ProcessSnapshot> {
		return Promise.resolve(this.snapshot(this.get(processId)));
	}

	getSnapshot(processId: string): Promise<V2ProcessSnapshot> {
		return Promise.resolve(this.snapshot(this.get(processId)));
	}

	getSnapshot(processId: string): Promise<V2ProcessSnapshot> {
		return Promise.resolve(this.snapshot(this.get(processId)));
	}

	getSnapshot(processId: string): Promise<V2ProcessSnapshot> {
		return Promise.resolve(this.snapshot(this.get(processId)));
	}

	getSnapshot(processId: string): Promise<V2ProcessSnapshot> {
		return Promise.resolve(this.snapshot(this.get(processId)));
	}

	getSnapshot(processId: string): Promise<V2ProcessSnapshot> {
		return Promise.resolve(this.snapshot(this.get(processId)));
	}

	getSnapshot(processId: string): Promise<V2ProcessSnapshot> {
		return Promise.resolve(this.snapshot(this.get(processId)));
	}

	getSnapshot(processId: string): Promise<V2ProcessSnapshot> {
		return Promise.resolve(this.snapshot(this.get(processId)));
	}

	getSnapshot(processId: string): Promise<V2ProcessSnapshot> {
		return Promise.resolve(this.snapshot(this.get(processId)));
	}

	getSnapshot(processId: string): Promise<V2ProcessSnapshot> {
		return Promise.resolve(this.snapshot(this.get(processId)));
	}

	getSnapshot(processId: string): Promise<V2ProcessSnapshot> {
		return Promise.resolve(this.snapshot(this.get(processId)));
	}

	getSnapshot(processId: string): Promise<V2ProcessSnapshot> {
		return Promise.resolve(this.snapshot(this.get(processId)));
	}

	getSnapshot(processId: string): Promise<V2ProcessSnapshot> {
		return Promise.resolve(this.snapshot(this.get(processId)));
	}

	getSnapshot(processId: string): Promise<V2ProcessSnapshot> {
		return Promise.resolve(this.snapshot(this.get(processId)));
	}

	getSnapshot(processId: string): Promise<V2ProcessSnapshot> {
		return Promise.resolve(this.snapshot(this.get(processId)));
	}

	getSnapshot(processId: string): Promise<V2ProcessSnapshot> {
		return Promise.resolve(this.snapshot(this.get(processId)));
	}

	async read(processId: string, cursor: number): Promise<V2ProcessOutput> {
		const process = this.get(processId);
		if (!Number.isInteger(cursor) || cursor < 0) throw new Error("Process cursor must be a non-negative integer");
		const baseCursor = process.totalBytes - process.output.length;
		return {
			output: process.output.slice(Math.max(0, cursor - baseCursor)),
			cursor: process.totalBytes,
			truncated: cursor < baseCursor,
		};
	}

	wait(processId: string): Promise<V2ProcessSnapshot> {
		const process = this.get(processId);
		return process.state === "running" ? new Promise((resolve) => process.waiters.push(resolve)) : Promise.resolve(snapshot(process));
	}

	async terminate(processId: string): Promise<V2ProcessSnapshot> {
		const state = this.get(processId);
		if (state.state === "running") {
			state.state = "terminated";
			state.exitCode = 143;
			if (state.child.pid != null && process.platform !== "win32") {
				try { process.kill(-state.child.pid, "SIGTERM"); } catch { state.child.kill("SIGTERM"); }
			} else state.child.kill("SIGTERM");
			state.terminationTimer = setTimeout(() => {
				if (state.state !== "terminated" || state.child.exitCode !== null) return;
				try { state.child.kill("SIGKILL"); } catch { }
				state.killTimer = setTimeout(() => {
					if (state.state === "terminated") this.finish(state, "terminated", 143);
				}, this.terminateTimeoutMs);
				state.killTimer.unref?.();
			}, this.terminateGraceMs);
			state.terminationTimer.unref?.();
		}
		return snapshot(state);
	}

	private finish(process: NodeProcessState, state: V2ProcessState, exitCode: number, errorOutput?: Buffer): void {
		if (process.state !== "running" && state !== "terminated") return;
		if (!process.decoderFlushed) {
			process.decoderFlushed = true;
			const tail = Buffer.from(process.decoder.end());
			process.output = retainOutput(Buffer.concat([process.output, tail]), this.maxOutputBytes);
			process.totalBytes += tail.length;
		}
		if (errorOutput) {
			process.output = retainOutput(Buffer.concat([process.output, errorOutput]), this.maxOutputBytes);
			process.totalBytes += errorOutput.length;
		}
		if (process.terminationTimer) clearTimeout(process.terminationTimer);
		if (process.killTimer) clearTimeout(process.killTimer);
		process.state = state;
		process.exitCode = process.exitCode ?? exitCode;
		this.releaseCapacity(process);
		const result = snapshot(process);
		for (const resolve of process.waiters) resolve(result);
		process.waiters = [];
		this.pruneCompleted();
	}

	private snapshot(process: NodeProcessState): V2ProcessSnapshot {
		const baseCursor = process.totalBytes - process.output.length;
		return {
			processId: process.processId,
			sessionId: process.sessionId,
			command: process.command,
			pty: process.pty,
			state: process.state,
			...(process.exitCode === undefined ? {} : { exitCode: process.exitCode }),
			output: process.output,
			cursor: process.totalBytes,
			truncated: baseCursor > 0,
		};
	}

	private get(processId: string): NodeProcessState {
		const process = this.processes.get(processId);
		if (!process) throw new Error(`Unknown process ${processId}`);
		return process;
	}
}

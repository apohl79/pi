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

export type V2ProcessSnapshot = V2ProcessOutput & Readonly<{
	processId: string;
	sessionId: string;
	command: string;
	state: V2ProcessState;
	exitCode?: number;
}>;

export interface V2ProcessRegistry {
	start(request: V2ProcessStartRequest): Promise<V2ProcessSnapshot>;
	write(processId: string, input: string): Promise<V2ProcessOutput>;
	read(processId: string, cursor: number): Promise<V2ProcessOutput>;
	wait(processId: string): Promise<V2ProcessSnapshot>;
	terminate(processId: string): Promise<V2ProcessSnapshot>;
}

type ProcessState = {
	readonly processId: string;
	readonly sessionId: string;
	readonly command: string;
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
	const start = Math.max(cursor, baseCursor);
	return {
		output: process.output.subarray(start - baseCursor).toString("utf8"),
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
		if (request.pty === true) throw new Error("PTY process execution is unsupported");
		const process: ProcessState = { processId: randomUUID(), sessionId: request.sessionId, command: request.command, state: "running", output: Buffer.alloc(0), totalBytes: 0 };
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

	async read(processId: string, cursor: number): Promise<V2ProcessOutput> { return outputView(this.get(processId), cursor); }

	wait(processId: string): Promise<V2ProcessSnapshot> {
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
		return snapshot(process);
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
	terminationTimer?: ReturnType<typeof setTimeout>;
	killTimer?: ReturnType<typeof setTimeout>;
};

type NodeV2ProcessRegistryOptions = Readonly<{
	maxOutputBytes?: number;
	maxCompletedProcesses?: number;
	terminateGraceMs?: number;
	terminateTimeoutMs?: number;
}>;

export class NodeV2ProcessRegistry implements V2ProcessRegistry {
	private readonly maxOutputBytes: number;
	private readonly maxCompletedProcesses: number;
	private readonly terminateGraceMs: number;
	private readonly terminateTimeoutMs: number;
	private readonly processes = new Map<string, NodeProcessState>();

	constructor(options: NodeV2ProcessRegistryOptions = {}) {
		this.maxOutputBytes = options.maxOutputBytes ?? 64 * 1024;
		this.maxCompletedProcesses = options.maxCompletedProcesses ?? 256;
		this.terminateGraceMs = options.terminateGraceMs ?? 1_000;
		this.terminateTimeoutMs = options.terminateTimeoutMs ?? 1_000;
	}

	async start(request: V2ProcessStartRequest): Promise<V2ProcessSnapshot> {
		if (request.pty === true) return Promise.reject(new Error("PTY process execution is unsupported"));
		const [file, ...args] = parseCommand(request.command);
		const child = spawn(file, args, { shell: false, detached: process.platform !== "win32", cwd: request.cwd, env: { ...process.env, ...request.env }, stdio: ["pipe", "pipe", "pipe"] });
		const state: NodeProcessState = { processId: randomUUID(), sessionId: request.sessionId, command: request.command, state: "running", output: Buffer.alloc(0), totalBytes: 0, child, waiters: [], decoder: new StringDecoder("utf8") };
		this.processes.set(state.processId, state);
		const append = (chunk: Buffer): void => {
			state.totalBytes += chunk.length;
			const decoded = Buffer.from(state.decoder.write(chunk));
			state.output = retainOutput(Buffer.concat([state.output, decoded]), this.maxOutputBytes);
		};
		child.stdout?.on("data", append);
		child.stderr?.on("data", append);
		child.once("error", (error) => { append(Buffer.from(error.message)); this.finish(state, "exited", 1); });
		child.once("close", (code) => this.finish(state, state.state === "terminated" ? "terminated" : "exited", code ?? 0));
		return Promise.resolve(snapshot(state));
	}

	async write(processId: string, input: string): Promise<V2ProcessOutput> {
		const process = this.get(processId);
		if (process.state !== "running" || !process.child.stdin) throw new Error(`Process ${processId} is not running`);
		const cursor = process.totalBytes;
		process.child.stdin.write(input);
		await new Promise<void>((resolve) => setImmediate(resolve));
		return outputView(process, cursor);
	}

	async read(processId: string, cursor: number): Promise<V2ProcessOutput> { return outputView(this.get(processId), cursor); }

	wait(processId: string): Promise<V2ProcessSnapshot> {
		const process = this.get(processId);
		return process.state === "running" ? new Promise((resolve) => process.waiters.push(resolve)) : Promise.resolve(snapshot(process));
	}

	async terminate(processId: string): Promise<V2ProcessSnapshot> {
		const state = this.get(processId);
		if (state.state === "running") {
			state.state = "terminated";
			state.exitCode = 143;
			if (state.child.pid !== null && process.platform !== "win32") {
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

	private finish(process: NodeProcessState, state: V2ProcessState, exitCode: number): void {
		if (process.state !== "running" && state !== "terminated") return;
		if (process.terminationTimer) clearTimeout(process.terminationTimer);
		if (process.killTimer) clearTimeout(process.killTimer);
		process.state = state;
		process.exitCode = process.exitCode ?? exitCode;
		const result = snapshot(process);
		for (const resolve of process.waiters) resolve(result);
		process.waiters = [];
		this.pruneCompleted();
	}

	private pruneCompleted(): void {
		const completed = [...this.processes.values()].filter((process) => process.state !== "running");
		const excess = completed.length - this.maxCompletedProcesses;
		completed.slice(0, Math.max(0, excess)).forEach((process) => this.processes.delete(process.processId));
	}

	private get(processId: string): NodeProcessState {
		const process = this.processes.get(processId);
		if (!process) throw new Error(`Unknown process ${processId}`);
		return process;
	}
}

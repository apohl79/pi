import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

export type V2ProcessState = "running" | "exited" | "terminated" | "lost";

export interface V2ProcessStartRequest {
	readonly sessionId: string;
	readonly command: string;
	readonly cwd?: string;
	readonly env?: Readonly<Record<string, string>>;
	readonly pty?: boolean;
}

export interface V2ProcessOutput {
	readonly output: string;
	readonly cursor: number;
	readonly truncated: boolean;
}

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
	output: string;
	totalBytes: number;
}

export class InMemoryV2ProcessRegistry implements V2ProcessRegistry {
	private readonly maxOutputBytes: number;
	private readonly processes = new Map<string, ProcessState>();

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
		return this.snapshot(process);
	}

	async write(processId: string, input: string): Promise<V2ProcessOutput> {
		const process = this.get(processId);
		if (process.state !== "running") throw new Error(`Process ${processId} is not running`);
		this.append(process, input);
		return this.read(processId, process.totalBytes - input.length);
	}

	getSnapshot(processId: string): Promise<V2ProcessSnapshot> {
		return Promise.resolve(this.snapshot(this.get(processId)));
	}

	async read(processId: string, cursor: number): Promise<V2ProcessOutput> {
		const process = this.get(processId);
		if (!Number.isInteger(cursor) || cursor < 0) throw new Error("Process cursor must be a non-negative integer");
		const baseCursor = process.totalBytes - process.output.length;
		const start = Math.max(cursor, baseCursor);
		return {
			output: process.output.slice(start - baseCursor),
			cursor: process.totalBytes,
			truncated: cursor < baseCursor,
		};
	}

	async wait(processId: string): Promise<V2ProcessSnapshot> {
		return this.snapshot(this.get(processId));
	}

	async terminate(processId: string): Promise<V2ProcessSnapshot> {
		const process = this.get(processId);
		if (process.state === "running") {
			process.state = "terminated";
			process.exitCode = 143;
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

interface NodeProcessState extends ProcessState {
	readonly child: ChildProcess;
	waiters: Array<(snapshot: V2ProcessSnapshot) => void>;
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

export class NodeV2ProcessRegistry implements V2ProcessRegistry {
	private readonly maxOutputBytes: number;
	private readonly ptyLauncher: V2PtyLauncher | undefined;
	private readonly processes = new Map<string, NodeProcessState>();

	constructor(options: { maxOutputBytes?: number; ptyLauncher?: V2PtyLauncher } = {}) {
		this.maxOutputBytes = options.maxOutputBytes ?? 64 * 1024;
		this.ptyLauncher = options.ptyLauncher;
	}

	start(request: V2ProcessStartRequest): Promise<V2ProcessSnapshot> {
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
			state.totalBytes += chunk.length;
			state.output = `${state.output}${chunk.toString("utf8")}`.slice(-this.maxOutputBytes);
		};
		child.stdout?.on("data", append);
		child.stderr?.on("data", append);
		child.once("error", (error) => {
			append(Buffer.from(error.message));
			this.finish(state, "exited", 1);
		});
		child.once("close", (code) =>
			this.finish(state, state.state === "terminated" ? "terminated" : "exited", code ?? 0),
		);
		return Promise.resolve(this.snapshot(state));
	}

	async write(processId: string, input: string): Promise<V2ProcessOutput> {
		const process = this.get(processId);
		if (process.state !== "running" || !process.child.stdin) throw new Error(`Process ${processId} is not running`);
		const cursor = process.totalBytes;
		process.child.stdin.write(input);
		return this.read(processId, cursor);
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
		if (process.state !== "running") return Promise.resolve(this.snapshot(process));
		return new Promise((resolve) => process.waiters.push(resolve));
	}

	async terminate(processId: string): Promise<V2ProcessSnapshot> {
		const process = this.get(processId);
		if (process.state === "running") {
			process.state = "terminated";
			process.exitCode = 143;
			process.child.kill();
		}
		return this.snapshot(process);
	}

	private finish(process: NodeProcessState, state: V2ProcessState, exitCode: number): void {
		if (process.state !== "running" && state !== "terminated") return;
		process.state = state;
		process.exitCode = process.exitCode ?? exitCode;
		const snapshot = this.snapshot(process);
		for (const resolve of process.waiters) resolve(snapshot);
		process.waiters = [];
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

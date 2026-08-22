import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { StringDecoder } from "node:string_decoder";

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

export interface V2ProcessWriteOptions {
	readonly eof?: boolean;
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
	write(processId: string, input: string, options?: V2ProcessWriteOptions): Promise<V2ProcessOutput>;
	read(processId: string, cursor: number): Promise<V2ProcessOutput>;
	wait(processId: string): Promise<V2ProcessSnapshot>;
	terminate(processId: string): Promise<V2ProcessSnapshot>;
	/** Mark processes owned by a daemon generation that did not shut down cleanly. */
	markLost(): Promise<number>;
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
	inputClosed?: boolean;
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

	async write(processId: string, input: string, options: V2ProcessWriteOptions = {}): Promise<V2ProcessOutput> {
		const process = this.get(processId);
		if (process.state !== "running") throw new Error(`Process ${processId} is not running`);
		if (process.inputClosed) throw new Error(`Process ${processId} input is closed`);
		const cursor = process.totalBytes;
		this.append(process, input);
		if (options.eof) process.inputClosed = true;
		return this.read(processId, cursor);
	}

	getSnapshot(processId: string): Promise<V2ProcessSnapshot> {
		return Promise.resolve(this.snapshot(this.get(processId)));
	}

	async read(processId: string, cursor: number): Promise<V2ProcessOutput> {
		const process = this.get(processId);
		if (!Number.isInteger(cursor) || cursor < 0) throw new Error("Process cursor must be a non-negative integer");
		const baseCursor = process.totalBytes - Buffer.byteLength(process.output, "utf8");
		const start = Math.max(cursor, baseCursor);
		return {
			output: readUtf8FromCursor(process.output, start - baseCursor),
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

	markLost(): Promise<number> {
		let count = 0;
		for (const process of this.processes.values()) {
			if (process.state !== "running") continue;
			process.state = "lost";
			count += 1;
		}
		return Promise.resolve(count);
	}

	private append(process: ProcessState, value: string): void {
		process.totalBytes += Buffer.byteLength(value, "utf8");
		process.output = retainUtf8(`${process.output}${value}`, this.maxOutputBytes);
	}

	private snapshot(process: ProcessState): V2ProcessSnapshot {
		const baseCursor = process.totalBytes - Buffer.byteLength(process.output, "utf8");
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
	readonly stdoutDecoder: StringDecoder;
	readonly stderrDecoder: StringDecoder;
	terminationTimer?: NodeJS.Timeout;
	waiters: Array<(snapshot: V2ProcessSnapshot) => void>;
}

function spawnNodeProcess(request: V2ProcessStartRequest, ptyLauncher?: V2PtyLauncher): ChildProcess {
	if (request.pty) {
		if (!ptyLauncher) throw new Error("PTY process execution requires a host PTY launcher");
		return ptyLauncher.spawn(request);
	}
	const argv = parseArgv(request.command);
	return spawn(argv[0]!, argv.slice(1), {
		detached: true,
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
			stdoutDecoder: new StringDecoder("utf8"),
			stderrDecoder: new StringDecoder("utf8"),
			waiters: [],
		};
		this.processes.set(state.processId, state);
		const append = (value: string): void => {
			state.totalBytes += Buffer.byteLength(value, "utf8");
			state.output = retainUtf8(`${state.output}${value}`, this.maxOutputBytes);
		};
		child.stdout?.on("data", (chunk: Buffer) => append(state.stdoutDecoder.write(chunk)));
		child.stderr?.on("data", (chunk: Buffer) => append(state.stderrDecoder.write(chunk)));
		child.once("error", (error) => {
			append(error.message);
			this.finish(state, "exited", 1);
		});
		child.once("close", (code) => {
			append(state.stdoutDecoder.end());
			append(state.stderrDecoder.end());
			this.finish(state, state.state === "terminated" ? "terminated" : "exited", code ?? 0);
		});
		return Promise.resolve(this.snapshot(state));
	}

	async write(processId: string, input: string, options: V2ProcessWriteOptions = {}): Promise<V2ProcessOutput> {
		const process = this.get(processId);
		if (process.state !== "running" || !process.child.stdin) throw new Error(`Process ${processId} is not running`);
		if (process.inputClosed) throw new Error(`Process ${processId} input is closed`);
		const cursor = process.totalBytes;
		process.child.stdin.write(input);
		if (options.eof) {
			process.inputClosed = true;
			process.child.stdin.end();
		}
		return this.read(processId, cursor);
	}

	getSnapshot(processId: string): Promise<V2ProcessSnapshot> {
		return Promise.resolve(this.snapshot(this.get(processId)));
	}

	async read(processId: string, cursor: number): Promise<V2ProcessOutput> {
		const process = this.get(processId);
		if (!Number.isInteger(cursor) || cursor < 0) throw new Error("Process cursor must be a non-negative integer");
		const baseCursor = process.totalBytes - Buffer.byteLength(process.output, "utf8");
		return {
			output: readUtf8FromCursor(process.output, Math.max(0, cursor - baseCursor)),
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
			signalProcessTree(process.child, "SIGTERM");
			process.terminationTimer = setTimeout(() => {
				if (process.state === "terminated") signalProcessTree(process.child, "SIGKILL");
			}, 500);
			process.terminationTimer.unref();
		}
		return this.snapshot(process);
	}

	markLost(): Promise<number> {
		let count = 0;
		for (const process of this.processes.values()) {
			if (process.state !== "running") continue;
			process.state = "lost";
			count += 1;
			if (process.terminationTimer !== undefined) {
				clearTimeout(process.terminationTimer);
				process.terminationTimer = undefined;
			}
			signalProcessTree(process.child, "SIGTERM");
			const snapshot = this.snapshot(process);
			for (const resolve of process.waiters) resolve(snapshot);
			process.waiters = [];
		}
		return Promise.resolve(count);
	}

	private finish(process: NodeProcessState, state: V2ProcessState, exitCode: number): void {
		if (process.state !== "running" && state !== "terminated") return;
		if (process.terminationTimer !== undefined) {
			clearTimeout(process.terminationTimer);
			process.terminationTimer = undefined;
		}
		process.state = state;
		process.exitCode = process.exitCode ?? exitCode;
		const snapshot = this.snapshot(process);
		for (const resolve of process.waiters) resolve(snapshot);
		process.waiters = [];
	}

	private snapshot(process: NodeProcessState): V2ProcessSnapshot {
		const baseCursor = process.totalBytes - Buffer.byteLength(process.output, "utf8");
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

/**
 * Persists process snapshots so a newly constructed daemon can classify the
 * previous generation's running processes as lost before accepting clients.
 * Live process ownership remains in the delegate; the journal is recovery
 * metadata, not a claim that an OS process can be reattached.
 */
export class JsonlV2ProcessRegistry implements V2ProcessRegistry {
	private readonly path: string;
	private readonly delegate: V2ProcessRegistry;
	private readonly records = new Map<string, V2ProcessSnapshot>();
	private readonly ready: Promise<void>;

	constructor(path: string, delegate: V2ProcessRegistry = new NodeV2ProcessRegistry()) {
		if (path.length === 0) throw new TypeError("Process journal path must not be empty");
		this.path = path;
		this.delegate = delegate;
		this.ready = this.load();
	}

	async start(request: V2ProcessStartRequest): Promise<V2ProcessSnapshot> {
		await this.ready;
		const snapshot = await this.delegate.start(request);
		await this.persist(snapshot);
		return snapshot;
	}

	async getSnapshot(processId: string): Promise<V2ProcessSnapshot> {
		await this.ready;
		const persisted = this.records.get(processId);
		try {
			const snapshot = await this.delegate.getSnapshot(processId);
			await this.persist(snapshot);
			return snapshot;
		} catch (error) {
			if (persisted !== undefined) return persisted;
			throw error;
		}
	}

	async write(processId: string, input: string, options?: V2ProcessWriteOptions): Promise<V2ProcessOutput> {
		await this.ready;
		const output = await this.delegate.write(processId, input, options);
		await this.persist(await this.delegate.getSnapshot(processId));
		return output;
	}

	async read(processId: string, cursor: number): Promise<V2ProcessOutput> {
		await this.ready;
		try {
			return await this.delegate.read(processId, cursor);
		} catch (error) {
			const snapshot = this.records.get(processId);
			if (snapshot === undefined) throw error;
			if (!Number.isInteger(cursor) || cursor < 0) throw new Error("Process cursor must be a non-negative integer");
			const baseCursor = snapshot.cursor - Buffer.byteLength(snapshot.output, "utf8");
			return {
				output: readUtf8FromCursor(snapshot.output, Math.max(0, cursor - baseCursor)),
				cursor: snapshot.cursor,
				truncated: cursor < baseCursor,
			};
		}
	}

	async wait(processId: string): Promise<V2ProcessSnapshot> {
		await this.ready;
		try {
			const snapshot = await this.delegate.wait(processId);
			await this.persist(snapshot);
			return snapshot;
		} catch (error) {
			const snapshot = this.records.get(processId);
			if (snapshot !== undefined) return snapshot;
			throw error;
		}
	}

	async terminate(processId: string): Promise<V2ProcessSnapshot> {
		await this.ready;
		try {
			const snapshot = await this.delegate.terminate(processId);
			await this.persist(snapshot);
			return snapshot;
		} catch (error) {
			const snapshot = this.records.get(processId);
			if (snapshot !== undefined) return snapshot;
			throw error;
		}
	}

	async markLost(): Promise<number> {
		await this.ready;
		let count = 0;
		for (const [processId, snapshot] of this.records) {
			if (snapshot.state !== "running") continue;
			count += 1;
			const lost = { ...snapshot, state: "lost" as const };
			this.records.set(processId, lost);
			await this.append(lost);
		}
		await this.delegate.markLost();
		return count;
	}

	private async load(): Promise<void> {
		try {
			const content = await readFile(this.path, "utf8");
			for (const line of content.split("\n")) {
				if (line.length === 0) continue;
				const value = JSON.parse(line) as V2ProcessSnapshot;
				if (typeof value.processId === "string" && typeof value.state === "string")
					this.records.set(value.processId, value);
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}

	private async persist(snapshot: V2ProcessSnapshot): Promise<void> {
		this.records.set(snapshot.processId, snapshot);
		await this.append(snapshot);
	}

	private async append(snapshot: V2ProcessSnapshot): Promise<void> {
		await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
		await appendFile(this.path, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
	}
}

function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
	if (process.platform !== "win32" && child.pid !== undefined) {
		try {
			process.kill(-child.pid, signal);
			return;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
		}
	}
	child.kill(signal);
}

function retainUtf8(value: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	const bytes = Buffer.from(value, "utf8");
	let start = Math.max(0, bytes.length - maxBytes);
	while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start += 1;
	return bytes.subarray(start).toString("utf8");
}

function readUtf8FromCursor(value: string, offset: number): string {
	const bytes = Buffer.from(value, "utf8");
	let start = Math.max(0, Math.min(offset, bytes.length));
	while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start += 1;
	return bytes.subarray(start).toString("utf8");
}

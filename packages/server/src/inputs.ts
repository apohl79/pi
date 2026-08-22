import { randomUUID } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface V2InputOption {
	readonly label: string;
	readonly value?: string;
}

export interface V2InputQuestion {
	readonly id: string;
	readonly prompt: string;
	readonly options?: readonly V2InputOption[];
	readonly allowFreeform?: boolean;
}

export type V2InputRequestStatus = "pending" | "responded" | "cancelled" | "expired";

export interface V2InputRequest {
	readonly id: string;
	readonly sessionId: string;
	readonly questions: readonly V2InputQuestion[];
	readonly status: V2InputRequestStatus;
	readonly answers?: Readonly<Record<string, string>>;
	readonly deadlineAt?: number;
}

interface InputState {
	request: V2InputRequest;
	timer?: NodeJS.Timeout;
	waiters: Array<(request: V2InputRequest) => void>;
}

function validateQuestions(questions: readonly V2InputQuestion[]): void {
	if (questions.length < 1 || questions.length > 3)
		throw new Error("Input request must contain one to three questions");
	const ids = new Set<string>();
	for (const question of questions) {
		if (question.id.trim().length === 0 || question.prompt.trim().length === 0)
			throw new Error("Input question id and prompt are required");
		if (ids.has(question.id)) throw new Error(`Duplicate input question ${question.id}`);
		ids.add(question.id);
		if (question.options && new Set(question.options.map((option) => option.label)).size !== question.options.length)
			throw new Error(`Input question ${question.id} has duplicate options`);
	}
}

function validateDeadline(autoResolutionMs: number | undefined): void {
	if (autoResolutionMs !== undefined && (!Number.isInteger(autoResolutionMs) || autoResolutionMs < 0))
		throw new Error("autoResolutionMs must be non-negative");
}

export interface V2InputRegistry {
	create(sessionId: string, questions: readonly V2InputQuestion[], autoResolutionMs?: number): Promise<V2InputRequest>;
	read(requestId: string): Promise<V2InputRequest>;
	respond(requestId: string, answers: Readonly<Record<string, string>>): Promise<V2InputRequest>;
	cancel(requestId: string): Promise<V2InputRequest>;
	wait(requestId: string): Promise<V2InputRequest>;
	pendingForSession(sessionId: string): Promise<string | undefined>;
	takeRespondedForSession(sessionId: string): Promise<Readonly<Record<string, string>> | undefined>;
}

export class InMemoryV2InputRegistry implements V2InputRegistry {
	private readonly requests = new Map<string, InputState>();
	private readonly consumedResponses = new Set<string>();

	async create(
		sessionId: string,
		questions: readonly V2InputQuestion[],
		autoResolutionMs?: number,
	): Promise<V2InputRequest> {
		validateQuestions(questions);
		validateDeadline(autoResolutionMs);
		const request: V2InputRequest = {
			id: randomUUID(),
			sessionId,
			questions: questions.map((question) => ({
				...question,
				...(question.options ? { options: question.options.map((option) => ({ ...option })) } : {}),
			})),
			status: "pending",
			...(autoResolutionMs === undefined ? {} : { deadlineAt: Date.now() + autoResolutionMs }),
		};
		const state: InputState = { request, waiters: [] };
		if (autoResolutionMs !== undefined) {
			state.timer = setTimeout(() => {
				if (state.request.status === "pending") {
					state.request = { ...state.request, status: "expired", answers: {} };
					this.resolveWaiters(state);
				}
			}, autoResolutionMs);
			state.timer.unref();
		}
		this.requests.set(request.id, state);
		return structuredClone(request);
	}

	/** Rehydrates a request from a durable registry without creating a new id. */
	restore(request: V2InputRequest): void {
		validateQuestions(request.questions);
		const state: InputState = { request: structuredClone(request), waiters: [] };
		this.requests.set(request.id, state);
		this.scheduleExpiry(state);
	}

	async read(requestId: string): Promise<V2InputRequest> {
		return structuredClone(this.get(requestId).request);
	}

	async respond(requestId: string, answers: Readonly<Record<string, string>>): Promise<V2InputRequest> {
		const state = this.get(requestId);
		if (state.request.status !== "pending") throw new Error(`Input request ${requestId} is not pending`);
		for (const question of state.request.questions) {
			const answer = answers[question.id];
			if (answer === undefined) continue;
			if (question.options && !question.options.some((option) => option.label === answer || option.value === answer))
				throw new Error(`Answer for ${question.id} is not one of the offered options`);
			if (!question.allowFreeform && question.options === undefined && answer.trim().length === 0)
				throw new Error(`Answer for ${question.id} must not be empty`);
		}
		state.request = { ...state.request, status: "responded", answers: { ...answers } };
		if (state.timer) clearTimeout(state.timer);
		this.resolveWaiters(state);
		return structuredClone(state.request);
	}

	async cancel(requestId: string): Promise<V2InputRequest> {
		const state = this.get(requestId);
		if (state.request.status !== "pending") throw new Error(`Input request ${requestId} is not pending`);
		state.request = { ...state.request, status: "cancelled" };
		if (state.timer) clearTimeout(state.timer);
		this.resolveWaiters(state);
		return structuredClone(state.request);
	}

	async wait(requestId: string): Promise<V2InputRequest> {
		const state = this.get(requestId);
		if (state.request.status !== "pending") return structuredClone(state.request);
		return new Promise((resolve) => state.waiters.push((request) => resolve(structuredClone(request))));
	}

	async pendingForSession(sessionId: string): Promise<string | undefined> {
		return [...this.requests.values()].find(
			(state) => state.request.sessionId === sessionId && state.request.status === "pending",
		)?.request.id;
	}

	async takeRespondedForSession(sessionId: string): Promise<Readonly<Record<string, string>> | undefined> {
		const state = [...this.requests.values()]
			.reverse()
			.find(
				(candidate) =>
					candidate.request.sessionId === sessionId &&
					candidate.request.status === "responded" &&
					!this.consumedResponses.has(candidate.request.id),
			);
		if (!state) return undefined;
		this.consumedResponses.add(state.request.id);
		return structuredClone(state.request.answers ?? {});
	}

	private get(requestId: string): InputState {
		const state = this.requests.get(requestId);
		if (!state) throw new Error(`Unknown input request ${requestId}`);
		return state;
	}

	private scheduleExpiry(state: InputState): void {
		if (state.request.status !== "pending" || state.request.deadlineAt === undefined) return;
		const delay = Math.max(0, state.request.deadlineAt - Date.now());
		state.timer = setTimeout(() => {
			if (state.request.status === "pending") {
				state.request = { ...state.request, status: "expired", answers: {} };
				this.resolveWaiters(state);
			}
		}, delay);
		state.timer.unref();
	}

	private resolveWaiters(state: InputState): void {
		const waiters = state.waiters.splice(0);
		for (const resolve of waiters) resolve(state.request);
	}
}

type InputRecord = V2InputRequest;

/** Durable append-only structured-input requests for configured daemon restart recovery. */
export class JsonlV2InputRegistry implements V2InputRegistry {
	private readonly memory = new InMemoryV2InputRegistry();
	private readonly path: string;
	private loaded: Promise<void>;
	private pendingWrite: Promise<void> = Promise.resolve();

	constructor(path: string) {
		this.path = path;
		this.loaded = this.load();
	}

	async create(
		sessionId: string,
		questions: readonly V2InputQuestion[],
		autoResolutionMs?: number,
	): Promise<V2InputRequest> {
		await this.loaded;
		const write = this.pendingWrite.then(async () => {
			const request = await this.memory.create(sessionId, questions, autoResolutionMs);
			await this.append(request);
			return request;
		});
		this.pendingWrite = write.then(
			() => undefined,
			() => undefined,
		);
		return structuredClone(await write);
	}

	async read(requestId: string): Promise<V2InputRequest> {
		await this.loaded;
		return this.memory.read(requestId);
	}

	async respond(requestId: string, answers: Readonly<Record<string, string>>): Promise<V2InputRequest> {
		await this.loaded;
		return this.mutate(() => this.memory.respond(requestId, answers));
	}

	async cancel(requestId: string): Promise<V2InputRequest> {
		await this.loaded;
		return this.mutate(() => this.memory.cancel(requestId));
	}

	async wait(requestId: string): Promise<V2InputRequest> {
		await this.loaded;
		return this.memory.wait(requestId);
	}

	async pendingForSession(sessionId: string): Promise<string | undefined> {
		await this.loaded;
		return this.memory.pendingForSession(sessionId);
	}

	async takeRespondedForSession(sessionId: string): Promise<Readonly<Record<string, string>> | undefined> {
		await this.loaded;
		return this.memory.takeRespondedForSession(sessionId);
	}

	private async mutate(operation: () => Promise<V2InputRequest>): Promise<V2InputRequest> {
		const write = this.pendingWrite.then(async () => {
			const request = await operation();
			await this.append(request);
			return request;
		});
		this.pendingWrite = write.then(
			() => undefined,
			() => undefined,
		);
		return structuredClone(await write);
	}

	private async load(): Promise<void> {
		let contents: string;
		try {
			contents = await readFile(this.path, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		for (const line of contents.split("\n").filter(Boolean)) this.memory.restore(JSON.parse(line) as InputRecord);
	}

	private append(request: V2InputRequest): Promise<void> {
		return (async () => {
			await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
			const handle = await open(this.path, "a", 0o600);
			try {
				await handle.write(`${JSON.stringify(request)}\n`, undefined, "utf8");
				await handle.sync();
			} finally {
				await handle.close();
			}
		})();
	}
}

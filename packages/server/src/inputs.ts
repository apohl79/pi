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

function validateRestoredRequest(value: unknown): asserts value is V2InputRequest {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error("Input record must be an object");
	const record = value as Record<string, unknown>;
	if (typeof record.id !== "string" || record.id.trim().length === 0) throw new Error("Input record id is required");
	if (typeof record.sessionId !== "string" || record.sessionId.trim().length === 0)
		throw new Error("Input record sessionId is required");
	if (!(typeof record.status === "string" && ["pending", "responded", "cancelled", "expired"].includes(record.status)))
		throw new Error("Input record status is invalid");
	if (!Array.isArray(record.questions)) throw new Error("Input record questions are required");
	for (const question of record.questions) {
		if (typeof question !== "object" || question === null || Array.isArray(question))
			throw new Error("Input record question must be an object");
		const candidate = question as Record<string, unknown>;
		if (typeof candidate.id !== "string" || typeof candidate.prompt !== "string")
			throw new Error("Input record question id and prompt are required");
		if (candidate.allowFreeform !== undefined && typeof candidate.allowFreeform !== "boolean")
			throw new Error("Input record question allowFreeform is invalid");
		if (candidate.options !== undefined) {
			if (!Array.isArray(candidate.options)) throw new Error("Input record question options are invalid");
			for (const option of candidate.options) {
				if (typeof option !== "object" || option === null || Array.isArray(option))
					throw new Error("Input record option must be an object");
				const item = option as Record<string, unknown>;
				if (typeof item.label !== "string" || (item.value !== undefined && typeof item.value !== "string"))
					throw new Error("Input record option label and value are invalid");
			}
		}
	}
	validateQuestions(record.questions as readonly V2InputQuestion[]);
	if (record.answers !== undefined) {
		if (typeof record.answers !== "object" || record.answers === null || Array.isArray(record.answers))
			throw new Error("Input record answers are invalid");
		if (!Object.values(record.answers).every((answer) => typeof answer === "string"))
			throw new Error("Input record answers must be strings");
	}
	if (record.deadlineAt !== undefined && (!Number.isInteger(record.deadlineAt) || (record.deadlineAt as number) < 0))
		throw new Error("Input record deadlineAt is invalid");
}

function validateDeadline(autoResolutionMs: number | undefined): void {
	if (autoResolutionMs !== undefined && (!Number.isInteger(autoResolutionMs) || autoResolutionMs < 0))
		throw new Error("autoResolutionMs must be non-negative");
}

export function createV2InputRequest(
	sessionId: string,
	questions: readonly V2InputQuestion[],
	autoResolutionMs?: number,
): V2InputRequest {
	validateQuestions(questions);
	validateDeadline(autoResolutionMs);
	return {
		id: randomUUID(),
		sessionId,
		questions: questions.map((question) => ({
			...question,
			...(question.options ? { options: question.options.map((option) => ({ ...option })) } : {}),
		})),
		status: "pending",
		...(autoResolutionMs === undefined ? {} : { deadlineAt: Date.now() + autoResolutionMs }),
	};
}

export function respondV2InputRequest(
	request: V2InputRequest,
	answers: Readonly<Record<string, string>>,
): V2InputRequest {
	if (request.status !== "pending") throw new Error(`Input request ${request.id} is not pending`);
	for (const question of request.questions) {
		const answer = answers[question.id];
		if (answer === undefined) continue;
		if (question.options && !question.options.some((option) => option.label === answer || option.value === answer))
			throw new Error(`Answer for ${question.id} is not one of the offered options`);
		if (!question.allowFreeform && question.options === undefined && answer.trim().length === 0)
			throw new Error(`Answer for ${question.id} must not be empty`);
	}
	return { ...request, status: "responded", answers: { ...answers } };
}

export function cancelV2InputRequest(request: V2InputRequest): V2InputRequest {
	if (request.status !== "pending") throw new Error(`Input request ${request.id} is not pending`);
	return { ...request, status: "cancelled" };
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
		const request = createV2InputRequest(sessionId, questions, autoResolutionMs);
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
		validateRestoredRequest(request);
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
		state.request = respondV2InputRequest(state.request, answers);
		if (state.timer) clearTimeout(state.timer);
		this.resolveWaiters(state);
		return structuredClone(state.request);
	}

	async cancel(requestId: string): Promise<V2InputRequest> {
		const state = this.get(requestId);
		state.request = cancelV2InputRequest(state.request);
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

	peekRespondedForSession(
		sessionId: string,
	): { requestId: string; answers: Readonly<Record<string, string>> } | undefined {
		const state = [...this.requests.values()]
			.reverse()
			.find(
				(candidate) =>
					candidate.request.sessionId === sessionId &&
					candidate.request.status === "responded" &&
					!this.consumedResponses.has(candidate.request.id),
			);
		if (!state) return undefined;
		return { requestId: state.request.id, answers: structuredClone(state.request.answers ?? {}) };
	}

	consumeResponded(requestId: string): void {
		this.get(requestId);
		this.consumedResponses.add(requestId);
	}

	async takeRespondedForSession(sessionId: string): Promise<Readonly<Record<string, string>> | undefined> {
		const response = this.peekRespondedForSession(sessionId);
		if (response === undefined) return undefined;
		this.consumeResponded(response.requestId);
		return response.answers;
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

type InputRecord = V2InputRequest | { readonly kind: "consumed"; readonly requestId: string };

function isConsumedInputRecord(value: unknown): value is { readonly kind: "consumed"; readonly requestId: string } {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	return (value as Record<string, unknown>).kind === "consumed";
}

/** Durable append-only structured-input requests for configured daemon restart recovery. */
export class JsonlV2InputRegistry implements V2InputRegistry {
	private readonly memory = new InMemoryV2InputRegistry();
	private readonly consumed = new Set<string>();
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
			const request = createV2InputRequest(sessionId, questions, autoResolutionMs);
			await this.append(request);
			this.memory.restore(request);
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
		return this.mutate(async () => {
			const next = respondV2InputRequest(await this.memory.read(requestId), answers);
			return { durable: next, commit: () => this.memory.respond(requestId, answers) };
		});
	}

	async cancel(requestId: string): Promise<V2InputRequest> {
		await this.loaded;
		return this.mutate(async () => {
			const next = cancelV2InputRequest(await this.memory.read(requestId));
			return { durable: next, commit: () => this.memory.cancel(requestId) };
		});
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
		const write = this.pendingWrite.then(async () => {
			const response = this.memory.peekRespondedForSession(sessionId);
			if (response === undefined) return undefined;
			await this.append({ kind: "consumed", requestId: response.requestId });
			this.memory.consumeResponded(response.requestId);
			this.consumed.add(response.requestId);
			return response.answers;
		});
		this.pendingWrite = write.then(
			() => undefined,
			() => undefined,
		);
		return structuredClone(await write);
	}

	private async mutate(
		operation: () => Promise<{ durable: V2InputRequest; commit: () => Promise<V2InputRequest> }>,
	): Promise<V2InputRequest> {
		const write = this.pendingWrite.then(async () => {
			const transition = await operation();
			await this.append(transition.durable);
			return transition.commit();
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
		for (const line of contents.split("\n").filter(Boolean)) {
			const record: unknown = JSON.parse(line);
			if (isConsumedInputRecord(record)) {
				if (typeof record.requestId !== "string" || record.requestId.length === 0)
					throw new Error("Input consumed record requestId is required");
				this.consumed.add(record.requestId);
				this.memory.consumeResponded(record.requestId);
			} else this.memory.restore(record as V2InputRequest);
		}
	}

	private append(request: InputRecord): Promise<void> {
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

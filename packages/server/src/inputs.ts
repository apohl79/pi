import { randomUUID } from "node:crypto";

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

export interface V2InputRegistry {
	create(sessionId: string, questions: readonly V2InputQuestion[], autoResolutionMs?: number): Promise<V2InputRequest>;
	read(requestId: string): Promise<V2InputRequest>;
	respond(requestId: string, answers: Readonly<Record<string, string>>): Promise<V2InputRequest>;
	cancel(requestId: string): Promise<V2InputRequest>;
	wait(requestId: string): Promise<V2InputRequest>;
	pendingForSession(sessionId: string): Promise<string | undefined>;
}

export class InMemoryV2InputRegistry implements V2InputRegistry {
	private readonly requests = new Map<string, InputState>();

	async create(
		sessionId: string,
		questions: readonly V2InputQuestion[],
		autoResolutionMs?: number,
	): Promise<V2InputRequest> {
		if (questions.length < 1 || questions.length > 3)
			throw new Error("Input request must contain one to three questions");
		const ids = new Set<string>();
		for (const question of questions) {
			if (question.id.trim().length === 0 || question.prompt.trim().length === 0)
				throw new Error("Input question id and prompt are required");
			if (ids.has(question.id)) throw new Error(`Duplicate input question ${question.id}`);
			ids.add(question.id);
			if (
				question.options &&
				new Set(question.options.map((option) => option.label)).size !== question.options.length
			)
				throw new Error(`Input question ${question.id} has duplicate options`);
		}
		if (autoResolutionMs !== undefined && (!Number.isInteger(autoResolutionMs) || autoResolutionMs < 0))
			throw new Error("autoResolutionMs must be non-negative");
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

	private get(requestId: string): InputState {
		const state = this.requests.get(requestId);
		if (!state) throw new Error(`Unknown input request ${requestId}`);
		return state;
	}

	private resolveWaiters(state: InputState): void {
		const waiters = state.waiters.splice(0);
		for (const resolve of waiters) resolve(state.request);
	}
}

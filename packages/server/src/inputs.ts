import { randomUUID } from "node:crypto";

export const MAX_V2_INPUT_REQUESTS = 1_000;
export const MAX_V2_INPUT_SESSION_ID_LENGTH = 256;
export const MAX_V2_INPUT_TEXT_LENGTH = 4_096;
export const MAX_V2_INPUT_OPTIONS = 32;
export const MAX_V2_INPUT_TIMER_MS = 2_147_483_647;

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
}

export type InMemoryV2InputRegistryOptions = Readonly<{ maxRequests?: number }>;

export interface V2InputRegistry {
	create(sessionId: string, questions: readonly V2InputQuestion[], autoResolutionMs?: number): Promise<V2InputRequest>;
	read(requestId: string): Promise<V2InputRequest>;
	respond(requestId: string, answers: Readonly<Record<string, string>>): Promise<V2InputRequest>;
	cancel(requestId: string): Promise<V2InputRequest>;
	pendingForSession(sessionId: string): Promise<string | undefined>;
}

export class InMemoryV2InputRegistry implements V2InputRegistry {
	private readonly requests = new Map<string, InputState>();
	private readonly pendingBySession = new Map<string, Set<string>>();
	private readonly terminalRequestIds = new Set<string>();
	private readonly maxRequests: number;

	constructor(options: InMemoryV2InputRegistryOptions = {}) {
		this.maxRequests = options.maxRequests ?? MAX_V2_INPUT_REQUESTS;
		if (!Number.isSafeInteger(this.maxRequests) || this.maxRequests < 1)
			throw new Error("maxRequests must be a positive safe integer");
	}

	async create(
		sessionId: string,
		questions: readonly V2InputQuestion[],
		autoResolutionMs?: number,
	): Promise<V2InputRequest> {
		if (sessionId.trim().length === 0 || sessionId.length > MAX_V2_INPUT_SESSION_ID_LENGTH)
			throw new Error(`Session id must contain one to ${MAX_V2_INPUT_SESSION_ID_LENGTH} characters`);
		if (questions.length < 1 || questions.length > 3)
			throw new Error("Input request must contain one to three questions");
		const ids = new Set<string>();
		for (const question of questions) {
			if (
				question.id.trim().length === 0 ||
				question.id.length > MAX_V2_INPUT_TEXT_LENGTH ||
				question.prompt.trim().length === 0 ||
				question.prompt.length > MAX_V2_INPUT_TEXT_LENGTH
			)
				throw new Error("Input question id and prompt are required");
			if (ids.has(question.id)) throw new Error(`Duplicate input question ${question.id}`);
			ids.add(question.id);
			if (question.options && question.options.length > MAX_V2_INPUT_OPTIONS)
				throw new Error(`Input question ${question.id} has too many options`);
			if (question.options?.some((option) => option.label.trim().length === 0))
				throw new Error(`Input question ${question.id} option label must not be empty`);
			if (
				question.options &&
				question.options.some(
					(option) =>
						option.label.length > MAX_V2_INPUT_TEXT_LENGTH ||
						(option.value !== undefined && option.value.length > MAX_V2_INPUT_TEXT_LENGTH),
				)
			)
				throw new Error(`Input question ${question.id} option is too long`);
			if (
				question.options &&
				new Set(question.options.map((option) => option.label)).size !== question.options.length
			)
				throw new Error(`Input question ${question.id} has duplicate options`);
		}
		if (
			autoResolutionMs !== undefined &&
			(!Number.isInteger(autoResolutionMs) || autoResolutionMs < 0 || autoResolutionMs > MAX_V2_INPUT_TIMER_MS)
		)
			throw new Error(`autoResolutionMs must be between zero and ${MAX_V2_INPUT_TIMER_MS}`);
		this.evictTerminalRequests(true);
		if (this.requests.size >= this.maxRequests) throw new Error("Input request capacity exceeded");
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
		const state: InputState = { request };
		if (autoResolutionMs !== undefined) {
			state.timer = setTimeout(() => {
				if (state.request.status === "pending") {
					state.request = { ...state.request, status: "expired", answers: {} };
					this.markTerminal(state);
				}
			}, autoResolutionMs);
			state.timer.unref();
		}
		this.requests.set(request.id, state);
		this.addPending(request);
		return structuredClone(request);
	}

	async read(requestId: string): Promise<V2InputRequest> {
		return structuredClone(this.get(requestId).request);
	}

	async respond(requestId: string, answers: Readonly<Record<string, string>>): Promise<V2InputRequest> {
		const state = this.get(requestId);
		if (state.request.status !== "pending") throw new Error(`Input request ${requestId} is not pending`);
		const answerKeys = Object.keys(answers);
		const questionIds = new Set(state.request.questions.map((question) => question.id));
		if (answerKeys.some((answerKey) => !questionIds.has(answerKey)))
			throw new Error("Input response contains an unknown question");
		if (answerKeys.length > state.request.questions.length)
			throw new Error("Input response contains too many answers");
		for (const question of state.request.questions) {
			if (!Object.hasOwn(answers, question.id)) continue;
			const answer = answers[question.id];
			if (typeof answer !== "string" || answer.length > MAX_V2_INPUT_TEXT_LENGTH)
				throw new Error(`Answer for ${question.id} is too long`);
			if (answer.trim().length === 0) throw new Error(`Answer for ${question.id} must not be empty`);
			if (
				question.options &&
				question.allowFreeform !== true &&
				!question.options.some((option) => option.label === answer || option.value === answer)
			)
				throw new Error(`Answer for ${question.id} is not one of the offered options`);
		}
		state.request = { ...state.request, status: "responded", answers: { ...answers } };
		if (state.timer) clearTimeout(state.timer);
		this.markTerminal(state);
		return structuredClone(state.request);
	}

	async cancel(requestId: string): Promise<V2InputRequest> {
		const state = this.get(requestId);
		if (state.request.status !== "pending") throw new Error(`Input request ${requestId} is not pending`);
		state.request = { ...state.request, status: "cancelled" };
		if (state.timer) clearTimeout(state.timer);
		this.markTerminal(state);
		return structuredClone(state.request);
	}

	async pendingForSession(sessionId: string): Promise<string | undefined> {
		const requestIds = this.pendingBySession.get(sessionId);
		return requestIds?.values().next().value;
	}

	private get(requestId: string): InputState {
		const state = this.requests.get(requestId);
		if (!state) throw new Error(`Unknown input request ${requestId}`);
		return state;
	}

	private addPending(request: V2InputRequest): void {
		const requestIds = this.pendingBySession.get(request.sessionId) ?? new Set<string>();
		requestIds.add(request.id);
		this.pendingBySession.set(request.sessionId, requestIds);
	}

	private markTerminal(state: InputState): void {
		this.removePending(state.request);
		this.terminalRequestIds.add(state.request.id);
		this.evictTerminalRequests(false);
	}

	private removePending(request: V2InputRequest): void {
		const requestIds = this.pendingBySession.get(request.sessionId);
		if (!requestIds) return;
		requestIds.delete(request.id);
		if (requestIds.size === 0) this.pendingBySession.delete(request.sessionId);
	}

	private evictTerminalRequests(requireAvailableSlot: boolean): void {
		while (
			(requireAvailableSlot ? this.requests.size >= this.maxRequests : this.requests.size > this.maxRequests) &&
			this.terminalRequestIds.size > 0
		) {
			const requestId = this.terminalRequestIds.values().next().value;
			if (requestId === undefined) return;
			this.terminalRequestIds.delete(requestId);
			this.requests.delete(requestId);
		}
	}
}

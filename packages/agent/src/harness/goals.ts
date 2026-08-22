import { uuidv7 } from "@earendil-works/pi-ai";
import type { Session } from "./session/index.ts";

export type GoalStatus = "active" | "paused" | "blocked" | "usageLimited" | "budgetLimited" | "complete";

export interface GoalSnapshot {
	id: string;
	objective: string;
	status: GoalStatus;
	tokenBudget?: number;
	tokensUsed: number;
	activeTimeSeconds: number;
	createdAt: number;
	updatedAt: number;
}

export interface GoalUpdate {
	status?: GoalStatus;
	tokensUsed?: number;
	activeTimeSeconds?: number;
	tokenBudget?: number;
}

export interface GoalContinuationSchedulerOptions {
	readonly goals: GoalManager;
	readonly waitForIdle: (callback: () => void | Promise<void>) => Promise<void>;
	readonly continueGoal: (goal: GoalSnapshot) => Promise<void>;
	readonly maxContinuations?: number;
}

/** Schedules one server-owned continuation after the durable lane becomes idle. */
export class GoalContinuationScheduler {
	private readonly options: GoalContinuationSchedulerOptions;
	private readonly maxContinuations: number;
	private scheduled = false;
	private completed = 0;
	private closed = false;

	constructor(options: GoalContinuationSchedulerOptions) {
		this.options = options;
		if (
			options.maxContinuations !== undefined &&
			(!Number.isInteger(options.maxContinuations) || options.maxContinuations < 0)
		)
			throw new Error("maxContinuations must be a non-negative integer");
		this.maxContinuations = options.maxContinuations ?? Number.POSITIVE_INFINITY;
	}

	async schedule(): Promise<boolean> {
		if (this.closed || this.scheduled || this.completed >= this.maxContinuations) return false;
		this.scheduled = true;
		let continued = false;
		try {
			await this.options.waitForIdle(async () => {
				if (this.closed) return;
				const goal = await this.options.goals.read();
				if (this.closed || !goal || goal.status !== "active" || this.completed >= this.maxContinuations) return;
				this.completed += 1;
				continued = true;
				if (this.closed) return;
				await this.options.continueGoal(goal);
			});
			return continued;
		} finally {
			this.scheduled = false;
		}
	}

	close(): void {
		this.closed = true;
	}
}

const GOAL_ENTRY_TYPE = "goal";
const GOAL_STATUSES = new Set<GoalStatus>(["active", "paused", "blocked", "usageLimited", "budgetLimited", "complete"]);

function isGoal(value: unknown): value is GoalSnapshot {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const candidate = value as Record<string, unknown>;
	return (
		typeof candidate.id === "string" &&
		typeof candidate.objective === "string" &&
		GOAL_STATUSES.has(candidate.status as GoalStatus) &&
		typeof candidate.tokensUsed === "number" &&
		typeof candidate.activeTimeSeconds === "number" &&
		typeof candidate.createdAt === "number" &&
		typeof candidate.updatedAt === "number" &&
		(candidate.tokenBudget === undefined || typeof candidate.tokenBudget === "number")
	);
}

function assertNonNegativeInteger(value: number | undefined, field: string): void {
	if (value !== undefined && (!Number.isInteger(value) || value < 0))
		throw new Error(`${field} must be a non-negative integer`);
}

export class GoalManager {
	private readonly session: Session;
	private readonly now: () => number;

	constructor(session: Session, now: () => number = Date.now) {
		this.session = session;
		this.now = now;
	}

	async read(): Promise<GoalSnapshot | undefined> {
		const entries = await this.session.findEntriesOnBranch({ order: "newestFirst" });
		const entry = entries.find(
			(candidate) => candidate.type === "custom" && candidate.customType === GOAL_ENTRY_TYPE,
		);
		return entry?.type === "custom" && isGoal(entry.data) ? structuredClone(entry.data) : undefined;
	}

	async create(objective: string, tokenBudget?: number): Promise<GoalSnapshot> {
		if (objective.trim().length === 0) throw new Error("Goal objective must not be empty");
		assertNonNegativeInteger(tokenBudget, "tokenBudget");
		if (await this.read()) throw new Error("A goal already exists");
		const timestamp = this.now();
		const goal: GoalSnapshot = {
			id: uuidv7(),
			objective,
			status: "active",
			...(tokenBudget === undefined ? {} : { tokenBudget }),
			tokensUsed: 0,
			activeTimeSeconds: 0,
			createdAt: timestamp,
			updatedAt: timestamp,
		};
		await this.session.appendCustomEntry(GOAL_ENTRY_TYPE, goal);
		return structuredClone(goal);
	}

	async update(patch: GoalUpdate): Promise<GoalSnapshot> {
		const current = await this.read();
		if (!current) throw new Error("No active goal");
		const timestamp = this.now();
		assertNonNegativeInteger(patch.tokensUsed, "tokensUsed");
		assertNonNegativeInteger(patch.tokenBudget, "tokenBudget");
		if (
			patch.activeTimeSeconds !== undefined &&
			(!Number.isFinite(patch.activeTimeSeconds) || patch.activeTimeSeconds < 0)
		)
			throw new Error("activeTimeSeconds must be non-negative");
		if (patch.status !== undefined && !GOAL_STATUSES.has(patch.status)) throw new Error("Invalid goal status");
		const activeTimeSeconds =
			current.status === "active"
				? current.activeTimeSeconds + Math.max(0, timestamp - current.updatedAt) / 1000
				: current.activeTimeSeconds;
		const goal: GoalSnapshot = {
			...current,
			...patch,
			...(patch.activeTimeSeconds === undefined ? { activeTimeSeconds } : {}),
			updatedAt: timestamp,
		};
		if (goal.tokenBudget !== undefined && goal.tokensUsed > goal.tokenBudget && goal.status === "active")
			goal.status = "budgetLimited";
		await this.session.appendCustomEntry(GOAL_ENTRY_TYPE, goal);
		return structuredClone(goal);
	}

	async pause(): Promise<GoalSnapshot> {
		return this.update({ status: "paused" });
	}

	async resume(): Promise<GoalSnapshot> {
		return this.update({ status: "active" });
	}
}

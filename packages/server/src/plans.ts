import { mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { PlanItem, PlanSnapshot } from "@earendil-works/pi-protocol";

export interface V2PlanRegistry {
	read(sessionId: string): Promise<PlanSnapshot | undefined>;
	update(
		sessionId: string,
		input: { readonly items: readonly PlanItem[]; readonly version?: number },
	): Promise<PlanSnapshot>;
	clear?(sessionId: string): Promise<void>;
}

export class InMemoryV2PlanRegistry implements V2PlanRegistry {
	private readonly plans = new Map<string, PlanSnapshot>();

	async read(sessionId: string): Promise<PlanSnapshot | undefined> {
		const plan = this.plans.get(sessionId);
		return plan === undefined ? undefined : structuredClone(plan);
	}

	async update(
		sessionId: string,
		input: { readonly items: readonly PlanItem[]; readonly version?: number },
	): Promise<PlanSnapshot> {
		const plan = validateV2Plan(this.plans.get(sessionId), input);
		this.plans.set(sessionId, plan);
		return structuredClone(plan);
	}

	async clear(sessionId: string): Promise<void> {
		this.plans.delete(sessionId);
	}
}

type PlanRecord = { readonly sessionId: string; readonly plan?: PlanSnapshot };

/** Durable append-only plan snapshots for daemon restart recovery. */
export class JsonlV2PlanRegistry implements V2PlanRegistry {
	private readonly plans = new Map<string, PlanSnapshot>();
	private readonly path: string;
	private loaded: Promise<void>;
	private pendingWrite: Promise<void> = Promise.resolve();

	constructor(path: string) {
		this.path = path;
		this.loaded = this.load();
	}

	async read(sessionId: string): Promise<PlanSnapshot | undefined> {
		await this.loaded;
		const plan = this.plans.get(sessionId);
		return plan === undefined ? undefined : structuredClone(plan);
	}

	async update(
		sessionId: string,
		input: { readonly items: readonly PlanItem[]; readonly version?: number },
	): Promise<PlanSnapshot> {
		await this.loaded;
		const plan = validateV2Plan(this.plans.get(sessionId), input);
		await this.append({ sessionId, plan });
		this.plans.set(sessionId, plan);
		return structuredClone(plan);
	}

	async clear(sessionId: string): Promise<void> {
		await this.loaded;
		await this.append({ sessionId });
		this.plans.delete(sessionId);
	}

	private async load(): Promise<void> {
		let contents: string;
		try {
			contents = await readFile(this.path, "utf8");
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
			throw error;
		}
		for (const line of contents.split("\n").filter(Boolean)) {
			const record = parsePlanRecord(JSON.parse(line));
			if (record.plan === undefined) this.plans.delete(record.sessionId);
			else this.plans.set(record.sessionId, record.plan);
		}
	}

	private append(record: PlanRecord): Promise<void> {
		const write = this.pendingWrite.then(async () => {
			await mkdir(dirname(this.path), { recursive: true });
			const handle = await open(this.path, "a");
			try {
				await handle.write(`${JSON.stringify(record)}\n`, undefined, "utf8");
				await handle.sync();
			} finally {
				await handle.close();
			}
		});
		this.pendingWrite = write.catch(() => undefined);
		return write;
	}
}

export function validateV2Plan(
	current: PlanSnapshot | undefined,
	input: { readonly items: readonly PlanItem[]; readonly version?: number },
): PlanSnapshot {
	validatePlanItems(input.items);
	if (input.items.length === 0) throw new Error("Plan must contain at least one step");
	if (input.items.filter((item) => item.status === "in_progress").length > 1)
		throw new Error("Plan may contain only one in-progress step");
	if (input.version !== undefined && input.version !== (current?.version ?? 0) + 1)
		throw new Error(`Plan version must be ${(current?.version ?? 0) + 1}`);
	return {
		version: (current?.version ?? 0) + 1,
		items: input.items.map((item) => ({ ...item })),
	};
}

function validatePlanItems(items: readonly PlanItem[]): void {
	for (const item of items) {
		if (
			typeof item !== "object" ||
			item === null ||
			typeof item.step !== "string" ||
			!(item.status === "pending" || item.status === "in_progress" || item.status === "completed")
		)
			throw new Error("Plan items are invalid");
	}
	if (items.some((item) => item.step.trim().length === 0)) throw new Error("Plan steps must not be empty");
}

function parsePlanRecord(value: unknown): PlanRecord {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid plan record");
	const record = value as Record<string, unknown>;
	if (typeof record.sessionId !== "string" || record.sessionId.trim().length === 0)
		throw new Error("Invalid plan record session id");
	if (record.plan === undefined) return { sessionId: record.sessionId };
	if (typeof record.plan !== "object" || record.plan === null || Array.isArray(record.plan))
		throw new Error("Invalid plan record plan");
	const plan = record.plan as Record<string, unknown>;
	if (!Number.isInteger(plan.version) || (plan.version as number) < 1 || !Array.isArray(plan.items))
		throw new Error("Invalid plan record snapshot");
	validatePlanItems(plan.items as readonly PlanItem[]);
	if (plan.items.filter((item) => item.status === "in_progress").length > 1)
		throw new Error("Invalid plan record snapshot");
	return { sessionId: record.sessionId, plan: { version: plan.version as number, items: plan.items } };
}

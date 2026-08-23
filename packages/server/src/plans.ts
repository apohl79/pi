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
		const current = this.plans.get(sessionId);
		const plan = validatePlan(current, input);
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
		const plan = validatePlan(this.plans.get(sessionId), input);
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
			const record = JSON.parse(line) as PlanRecord;
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

function validatePlan(
	current: PlanSnapshot | undefined,
	input: { readonly items: readonly PlanItem[]; readonly version?: number },
): PlanSnapshot {
	if (input.items.length === 0) throw new Error("Plan must contain at least one step");
	if (input.items.filter((item) => item.status === "in_progress").length > 1)
		throw new Error("Plan may contain only one in-progress step");
	if (input.items.some((item) => item.step.trim().length === 0)) throw new Error("Plan steps must not be empty");
	if (input.version !== undefined && input.version !== (current?.version ?? 0) + 1)
		throw new Error(`Plan version must be ${(current?.version ?? 0) + 1}`);
	return {
		version: (current?.version ?? 0) + 1,
		items: input.items.map((item) => ({ ...item })),
	};
}

export type PlanItem = Readonly<{
	step: string;
	status: "pending" | "in_progress" | "completed";
}>;

export type PlanSnapshot = Readonly<{
	version: number;
	items: readonly PlanItem[];
}>;

export interface V2PlanRegistry {
	read(sessionId: string): Promise<PlanSnapshot | undefined>;
	update(
		sessionId: string,
		input: { readonly items: readonly PlanItem[]; readonly version?: number },
	): Promise<PlanSnapshot>;
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
		if (input.items.length === 0) throw new Error("Plan must contain at least one step");
		if (input.items.filter((item) => item.status === "in_progress").length > 1)
			throw new Error("Plan may contain only one in-progress step");
		if (input.items.some((item) => item.step.trim().length === 0)) throw new Error("Plan steps must not be empty");
		const current = this.plans.get(sessionId);
		if (input.version !== undefined && input.version !== (current?.version ?? 0) + 1)
			throw new Error(`Plan version must be ${(current?.version ?? 0) + 1}`);
		const plan: PlanSnapshot = {
			version: (current?.version ?? 0) + 1,
			items: input.items.map((item) => ({ ...item })),
		};
		this.plans.set(sessionId, plan);
		return structuredClone(plan);
	}
}

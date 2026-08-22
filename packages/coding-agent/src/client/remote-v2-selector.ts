import type { PiClientV2, V2SessionLeaseMode } from "@earendil-works/pi-client";
import type { SessionMetadataV2, SessionPhaseV2, SessionSnapshotV2 } from "@earendil-works/pi-protocol";
import { RemoteV2Session } from "./remote-v2-session.ts";

export type RemoteV2SessionStatus = "idle" | "running" | "awaiting-input" | "suspended" | "goal-active" | "failed";
const MAX_CONCURRENT_SESSION_READS = 8;

export interface RemoteV2SessionEntry extends SessionMetadataV2 {
	readonly phase: SessionPhaseV2;
	readonly status: RemoteV2SessionStatus;
	readonly snapshot: SessionSnapshotV2;
}

/** Server-backed session list and attach boundary for remote TUI selectors. */
export class RemoteV2SessionSelector {
	readonly #client: PiClientV2;

	constructor(client: PiClientV2) {
		this.#client = client;
	}

	async list(): Promise<readonly RemoteV2SessionEntry[]> {
		const metadata = await this.#client.listSessions();
		const results: RemoteV2SessionEntry[] = new Array(metadata.length);
		let nextIndex = 0;
		const readNext = async (): Promise<void> => {
			while (nextIndex < metadata.length) {
				const index = nextIndex++;
				results[index] = await this.#readEntry(metadata[index]!);
			}
		};
		const workerCount = Math.min(MAX_CONCURRENT_SESSION_READS, metadata.length);
		await Promise.all(Array.from({ length: workerCount }, () => readNext()));
		return results;
	}

	attach(sessionId: string, mode: V2SessionLeaseMode = "observer"): Promise<RemoteV2Session> {
		return RemoteV2Session.open(this.#client, sessionId, { mode });
	}

	async #readEntry(metadata: SessionMetadataV2): Promise<RemoteV2SessionEntry> {
		const handle = await this.#client.openSession(metadata.id, "observer");
		let result: RemoteV2SessionEntry;
		try {
			const snapshot = await handle.read();
			result = { ...metadata, phase: snapshot.phase, status: sessionStatus(snapshot), snapshot };
		} catch (error) {
			try {
				await handle.detach();
			} catch (cleanupError) {
				throw new AggregateError([error, cleanupError], "Failed to read and detach remote session");
			}
			throw error;
		}
		try {
			await handle.detach();
		} catch (cleanupError) {
			throw new Error("Failed to detach remote session after read", { cause: cleanupError });
		}
		return result;
	}
}

export function sessionStatus(snapshot: SessionSnapshotV2): RemoteV2SessionStatus {
	if (snapshot.phase === "failed") return "failed";
	if (snapshot.phase === "awaitingInput") return "awaiting-input";
	if (snapshot.phase === "suspended") return "suspended";
	if (snapshot.goal?.status === "active") return "goal-active";
	if (snapshot.phase === "turn" || snapshot.phase === "compaction") return "running";
	return "idle";
}

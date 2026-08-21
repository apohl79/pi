import type { PiClientV2, V2SessionLeaseMode } from "@earendil-works/pi-client";
import type { SessionMetadataV2, SessionPhaseV2, SessionSnapshotV2 } from "@earendil-works/pi-protocol";
import { RemoteV2Session } from "./remote-v2-session.ts";

export type RemoteV2SessionStatus = "idle" | "running" | "awaiting-input" | "suspended" | "goal-active" | "failed";

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
		return Promise.all(metadata.map((entry) => this.#readEntry(entry)));
	}

	attach(sessionId: string, mode: V2SessionLeaseMode = "observer"): Promise<RemoteV2Session> {
		return RemoteV2Session.open(this.#client, sessionId, { mode });
	}

	async #readEntry(metadata: SessionMetadataV2): Promise<RemoteV2SessionEntry> {
		const handle = await this.#client.openSession(metadata.id, "observer");
		try {
			const snapshot = await handle.read();
			return { ...metadata, phase: snapshot.phase, status: sessionStatus(snapshot), snapshot };
		} finally {
			await handle.detach();
		}
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

export type V2AppAuthState = "unsupported" | "unauthenticated" | "authenticated" | "pending";

export type V2App = Readonly<{
	id: string;
	name: string;
	description?: string;
	auth: V2AppAuthState;
	enabled: boolean;
	metadata?: Readonly<Record<string, unknown>>;
}>;

export type V2AppAuthStart = Readonly<{
	appId: string;
	state: "pending";
	authorizationUrl?: string;
}>;

export type V2AppAuthComplete = Readonly<{ appId: string; state: "authenticated" }>;

export interface V2AppRegistry {
	list(): Promise<readonly V2App[]>;
	read(id: string): Promise<V2App | undefined>;
	startAuth(id: string, payload: Record<string, unknown>): Promise<V2AppAuthStart>;
	completeAuth(id: string, payload: Record<string, unknown>): Promise<V2AppAuthComplete>;
}

/** Server-owned OAuth/app credential storage; credentials never enter plugin state or transcripts. */
export interface V2AppCredentialStore {
	save(appId: string, credentials: Readonly<Record<string, unknown>>): Promise<void>;
	read(appId: string): Promise<Readonly<Record<string, unknown>> | undefined>;
}

function credentialId(value: string): string {
	const normalized = value.trim();
	if (normalized.length === 0) throw new Error("app id must not be empty");
	return normalized;
}

function credentialObject(value: unknown): Readonly<Record<string, unknown>> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? structuredClone(value as Record<string, unknown>)
		: undefined;
}

export class InMemoryV2AppCredentialStore implements V2AppCredentialStore {
	private readonly credentials = new Map<string, Readonly<Record<string, unknown>>>();

	async save(appId: string, credentials: Readonly<Record<string, unknown>>): Promise<void> {
		this.credentials.set(credentialId(appId), structuredClone(credentials));
	}

	async read(appId: string): Promise<Readonly<Record<string, unknown>> | undefined> {
		const value = this.credentials.get(credentialId(appId));
		return value === undefined ? undefined : structuredClone(value);
	}
}

/** JSON-backed credential store kept at an agent-owned path separate from plugin directories. */
export class JsonV2AppCredentialStore implements V2AppCredentialStore {
	private readonly filePath: string;
	private readonly credentials = new Map<string, Readonly<Record<string, unknown>>>();
	private loaded = false;

	constructor(filePath: string) {
		this.filePath = filePath;
	}

	private async ensureLoaded(): Promise<void> {
		if (this.loaded) return;
		this.loaded = true;
		try {
			const parsed: unknown = JSON.parse(await readFile(this.filePath, "utf8"));
			if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
				throw new Error("Invalid app credentials");
			for (const [id, value] of Object.entries(parsed)) {
				const normalized = credentialObject(value);
				if (!normalized) throw new Error("Invalid app credentials");
				this.credentials.set(credentialId(id), normalized);
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}

	private async persist(): Promise<void> {
		await mkdir(dirname(this.filePath), { recursive: true });
		const temporary = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
		const state = Object.fromEntries(this.credentials.entries());
		await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
		await rename(temporary, this.filePath);
	}

	async save(appId: string, credentials: Readonly<Record<string, unknown>>): Promise<void> {
		await this.ensureLoaded();
		this.credentials.set(credentialId(appId), structuredClone(credentials));
		await this.persist();
	}

	async read(appId: string): Promise<Readonly<Record<string, unknown>> | undefined> {
		await this.ensureLoaded();
		const value = this.credentials.get(credentialId(appId));
		return value === undefined ? undefined : structuredClone(value);
	}
}

export type V2AppRegistryState = Readonly<{ apps: readonly V2App[] }>;

function required(value: string, field: string): string {
	const normalized = value.trim();
	if (normalized.length === 0) throw new Error(`${field} must not be empty`);
	return normalized;
}

export class InMemoryV2AppRegistry implements V2AppRegistry {
	private readonly apps = new Map<string, V2App>();

	constructor(state: V2AppRegistryState = { apps: [] }) {
		for (const app of state.apps) this.apps.set(required(app.id, "app id"), structuredClone(app));
	}

	toState(): V2AppRegistryState {
		return { apps: [...this.apps.values()].map((app) => structuredClone(app)) };
	}

	async list(): Promise<readonly V2App[]> {
		return [...this.apps.values()].map((app) => structuredClone(app));
	}

	async read(id: string): Promise<V2App | undefined> {
		const app = this.apps.get(required(id, "app id"));
		return app === undefined ? undefined : structuredClone(app);
	}

	async startAuth(id: string, payload: Record<string, unknown>): Promise<V2AppAuthStart> {
		const appId = required(id, "app id");
		const app = this.apps.get(appId);
		if (!app) throw new Error(`Unknown app: ${appId}`);
		if (app.auth === "unsupported") throw new Error(`App does not support authentication: ${appId}`);
		const authorizationUrl = typeof payload.authorizationUrl === "string" ? payload.authorizationUrl : undefined;
		this.apps.set(appId, { ...app, auth: "pending" });
		return { appId, state: "pending", ...(authorizationUrl === undefined ? {} : { authorizationUrl }) };
	}

	async completeAuth(id: string, payload: Record<string, unknown>): Promise<V2AppAuthComplete> {
		const appId = required(id, "app id");
		const app = this.apps.get(appId);
		if (!app) throw new Error(`Unknown app: ${appId}`);
		if (app.auth !== "pending") throw new Error(`App authentication is not pending: ${appId}`);
		if (typeof payload.code !== "string" && typeof payload.redirectUri !== "string")
			throw new Error("app auth completion requires code or redirectUri");
		this.apps.set(appId, { ...app, auth: "authenticated" });
		return { appId, state: "authenticated" };
	}
}

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

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

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

export interface V2AppRegistry {
	list(): Promise<readonly V2App[]>;
	read(id: string): Promise<V2App | undefined>;
	startAuth(id: string, payload: Record<string, unknown>): Promise<V2AppAuthStart>;
}

export type V2AppRegistryState = Readonly<{ apps: readonly V2App[] }>;

function required(value: string, field: string): string {
	const normalized = value.trim();
	if (normalized.length === 0 || normalized.length > 256) throw new Error(`${field} must be non-empty and bounded`);
	return normalized;
}

function normalizeApp(app: V2App): V2App {
	const id = required(app.id, "app id");
	const name = app.name.trim();
	if (name.length === 0 || name.length > 256) throw new Error("app name must be non-empty and bounded");
	const description = app.description?.trim();
	if (description !== undefined && description.length > 2048) throw new Error("app description is too long");
	const metadata = app.metadata === undefined ? undefined : structuredClone(app.metadata);
	if (metadata !== undefined && JSON.stringify(metadata).length > 8192) throw new Error("app metadata is too large");
	return { id, name, ...(description === undefined ? {} : { description }), auth: app.auth, enabled: app.enabled, ...(metadata === undefined ? {} : { metadata }) };
}

export class InMemoryV2AppRegistry implements V2AppRegistry {
	private readonly apps = new Map<string, V2App>();

	constructor(state: V2AppRegistryState = { apps: [] }) {
		for (const app of state.apps) { const normalized = normalizeApp(app); this.apps.set(normalized.id, normalized); }
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
		if (!app.enabled) throw new Error(`App is disabled: ${appId}`);
		if (app.auth === "unsupported") throw new Error(`App does not support authentication: ${appId}`);
		const authorizationUrl = typeof payload.authorizationUrl === "string" ? payload.authorizationUrl : undefined;
		if (authorizationUrl !== undefined) {
			if (authorizationUrl.length > 2048) throw new Error("authorizationUrl is too long");
			const parsed = new URL(authorizationUrl);
			if (parsed.protocol !== "https:") throw new Error("authorizationUrl must use https");
		}
		return { appId, state: "pending", ...(authorizationUrl === undefined ? {} : { authorizationUrl }) };
	}
}

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type V2PluginScope = "user" | "project";

export type V2PluginSamplingEntry = Readonly<{
	id: string;
	slot: "contextual_user" | "developer_policy" | "developer_capabilities" | "separate_developer";
	position: "preamble" | "supplement";
	text: string;
	conditionShell?: string;
}>;

export type V2PluginApp = Readonly<{
	id: string;
	name: string;
	description?: string;
	auth: "unsupported" | "unauthenticated" | "authenticated" | "pending";
	enabled: boolean;
	metadata?: Readonly<Record<string, unknown>>;
}>;

export type V2PluginAppAuthStart = Readonly<{
	appId: string;
	state: "pending";
	authorizationUrl?: string;
}>;

export type V2Marketplace = Readonly<{
	name: string;
	source: string;
	addedAt: number;
}>;

export type V2Plugin = Readonly<{
	id: string;
	name: string;
	marketplace: string;
	version: string;
	manifestDigest: string;
	root?: string;
	enabled: boolean;
	scope: V2PluginScope;
	provenance: "manifest" | "package";
	resources: Readonly<{
		skills: readonly string[];
		commands: readonly string[];
		apps: number;
		hooks: number;
	}>;
	appDescriptors?: readonly V2PluginApp[];
	sampling: readonly V2PluginSamplingEntry[];
}>;

export type V2PluginRegistryState = Readonly<{
	marketplaces: readonly V2Marketplace[];
	plugins: readonly V2Plugin[];
}>;

export interface V2PluginRegistry {
	listMarketplaces(): Promise<readonly V2Marketplace[]>;
	addMarketplace(name: string, source: string): Promise<V2Marketplace>;
	removeMarketplace(name: string): Promise<void>;
	upgradeMarketplace(name: string): Promise<V2Marketplace>;
	listPlugins(installedOnly?: boolean): Promise<readonly V2Plugin[]>;
	readPlugin(id: string): Promise<V2Plugin | undefined>;
	installPlugin(input: {
		name: string;
		marketplace: string;
		version: string;
		manifest: Record<string, unknown>;
		root?: string;
		scope?: V2PluginScope;
	}): Promise<V2Plugin>;
	uninstallPlugin(id: string): Promise<void>;
	setEnabled(id: string, enabled: boolean, scope?: V2PluginScope): Promise<V2Plugin>;
	startAppAuth?(id: string, payload: Record<string, unknown>): Promise<V2PluginAppAuthStart>;
}

function requireName(value: string, field: string): string {
	const normalized = value.trim();
	if (normalized.length === 0) throw new Error(`${field} must not be empty`);
	return normalized;
}

function manifestDigest(manifest: Record<string, unknown>): string {
	return createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
}

function resourceCount(value: unknown): number {
	return Array.isArray(value) ? value.length : value === undefined ? 0 : 1;
}

function appDescriptors(pluginId: string, value: unknown, enabled: boolean): readonly V2PluginApp[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((raw) => {
		if (!raw || typeof raw !== "object" || Array.isArray(raw) || typeof raw.id !== "string") return [];
		const id = raw.id.trim();
		if (id.length === 0) return [];
		const auth = raw.auth;
		return [
			{
				id: `${pluginId}:${id}`,
				name: typeof raw.name === "string" && raw.name.trim().length > 0 ? raw.name : id,
				...(typeof raw.description === "string" ? { description: raw.description } : {}),
				auth: auth === "authenticated" || auth === "pending" || auth === "unauthenticated" ? auth : "unsupported",
				enabled,
				...(raw.metadata && typeof raw.metadata === "object" && !Array.isArray(raw.metadata)
					? { metadata: raw.metadata as Record<string, unknown> }
					: {}),
			},
		];
	});
}

const samplingSlots = new Set<V2PluginSamplingEntry["slot"]>([
	"contextual_user",
	"developer_policy",
	"developer_capabilities",
	"separate_developer",
]);
const samplingPositions = new Set<V2PluginSamplingEntry["position"]>(["preamble", "supplement"]);

function samplingEntries(manifest: Record<string, unknown>): readonly V2PluginSamplingEntry[] {
	const context = manifest.context;
	if (!context || typeof context !== "object" || Array.isArray(context)) return [];
	const sampling = (context as Record<string, unknown>).sampling;
	if (!Array.isArray(sampling)) return [];
	return sampling
		.flatMap((value) => {
			if (!value || typeof value !== "object" || Array.isArray(value)) return [];
			const entry = value as Record<string, unknown>;
			if (
				typeof entry.id !== "string" ||
				typeof entry.text !== "string" ||
				!samplingSlots.has(entry.slot as V2PluginSamplingEntry["slot"]) ||
				!samplingPositions.has(entry.position as V2PluginSamplingEntry["position"])
			)
				return [];
			const text = entry.text.slice(0, 8_000);
			return [
				{
					id: entry.id,
					slot: entry.slot as V2PluginSamplingEntry["slot"],
					position: entry.position as V2PluginSamplingEntry["position"],
					text,
					...(typeof entry.condition_shell === "string"
						? { conditionShell: entry.condition_shell }
						: typeof entry.conditionShell === "string"
							? { conditionShell: entry.conditionShell }
							: {}),
				},
			];
		})
		.slice(0, 32);
}

function normalizePlugin(plugin: V2Plugin): V2Plugin {
	return { ...plugin, appDescriptors: plugin.appDescriptors ?? [], sampling: plugin.sampling ?? [] };
}

export class InMemoryV2PluginRegistry implements V2PluginRegistry {
	private readonly marketplaces = new Map<string, V2Marketplace>();
	private readonly plugins = new Map<string, V2Plugin>();

	constructor(state?: V2PluginRegistryState) {
		for (const marketplace of state?.marketplaces ?? [])
			this.marketplaces.set(marketplace.name, structuredClone(marketplace));
		for (const plugin of state?.plugins ?? []) this.plugins.set(plugin.id, structuredClone(normalizePlugin(plugin)));
	}

	toState(): V2PluginRegistryState {
		return { marketplaces: [...this.marketplaces.values()], plugins: [...this.plugins.values()] };
	}

	replace(state: V2PluginRegistryState): void {
		this.marketplaces.clear();
		this.plugins.clear();
		for (const marketplace of state.marketplaces)
			this.marketplaces.set(marketplace.name, structuredClone(marketplace));
		for (const plugin of state.plugins ?? []) this.plugins.set(plugin.id, structuredClone(normalizePlugin(plugin)));
	}

	async listMarketplaces(): Promise<readonly V2Marketplace[]> {
		return [...this.marketplaces.values()].map((marketplace) => structuredClone(marketplace));
	}

	async addMarketplace(name: string, source: string): Promise<V2Marketplace> {
		const normalizedName = requireName(name, "marketplace name");
		const normalizedSource = requireName(source, "marketplace source");
		if (this.marketplaces.has(normalizedName)) throw new Error(`Marketplace already exists: ${normalizedName}`);
		const marketplace = { name: normalizedName, source: normalizedSource, addedAt: Date.now() };
		this.marketplaces.set(normalizedName, marketplace);
		return structuredClone(marketplace);
	}

	async removeMarketplace(name: string): Promise<void> {
		const normalizedName = requireName(name, "marketplace name");
		if ([...this.plugins.values()].some((plugin) => plugin.marketplace === normalizedName))
			throw new Error(`Marketplace has installed plugins: ${normalizedName}`);
		if (!this.marketplaces.delete(normalizedName)) throw new Error(`Unknown marketplace: ${normalizedName}`);
	}

	async upgradeMarketplace(name: string): Promise<V2Marketplace> {
		const normalizedName = requireName(name, "marketplace name");
		const existing = this.marketplaces.get(normalizedName);
		if (!existing) throw new Error(`Unknown marketplace: ${normalizedName}`);
		const upgraded = { ...existing, addedAt: Date.now() };
		this.marketplaces.set(normalizedName, upgraded);
		return structuredClone(upgraded);
	}

	async listPlugins(installedOnly = false): Promise<readonly V2Plugin[]> {
		void installedOnly;
		return [...this.plugins.values()].map((plugin) => structuredClone(normalizePlugin(plugin)));
	}

	async readPlugin(id: string): Promise<V2Plugin | undefined> {
		return this.plugins.has(id) ? structuredClone(normalizePlugin(this.plugins.get(id)!)) : undefined;
	}

	async installPlugin(input: {
		name: string;
		marketplace: string;
		version: string;
		manifest: Record<string, unknown>;
		root?: string;
		scope?: V2PluginScope;
	}): Promise<V2Plugin> {
		const name = requireName(input.name, "plugin name");
		const marketplace = requireName(input.marketplace, "marketplace name");
		const version = requireName(input.version, "plugin version");
		if (!this.marketplaces.has(marketplace)) throw new Error(`Unknown marketplace: ${marketplace}`);
		const id = `${name}@${marketplace}`;
		if (this.plugins.has(id)) throw new Error(`Plugin already installed: ${id}`);
		const manifest = input.manifest;
		const plugin: V2Plugin = {
			id,
			name,
			marketplace,
			version,
			manifestDigest: manifestDigest(manifest),
			...(input.root === undefined ? {} : { root: input.root }),
			enabled: true,
			scope: input.scope ?? "user",
			provenance: "manifest",
			resources: {
				skills: Array.isArray(manifest.skills)
					? manifest.skills.filter((value): value is string => typeof value === "string")
					: [],
				commands: Array.isArray(manifest.commands)
					? manifest.commands.filter((value): value is string => typeof value === "string")
					: [],
				apps: resourceCount(manifest.apps),
				hooks: resourceCount(manifest.hooks),
			},
			appDescriptors: appDescriptors(id, manifest.apps, true),
			sampling: samplingEntries(manifest),
		};
		this.plugins.set(id, plugin);
		return structuredClone(plugin);
	}

	async uninstallPlugin(id: string): Promise<void> {
		if (!this.plugins.delete(requireName(id, "plugin id"))) throw new Error(`Unknown plugin: ${id}`);
	}

	async setEnabled(id: string, enabled: boolean, scope?: V2PluginScope): Promise<V2Plugin> {
		const existing = this.plugins.get(requireName(id, "plugin id"));
		if (!existing) throw new Error(`Unknown plugin: ${id}`);
		const updated = {
			...existing,
			enabled,
			appDescriptors: (existing.appDescriptors ?? []).map((app) => ({ ...app, enabled })),
			...(scope === undefined ? {} : { scope }),
		};
		this.plugins.set(id, updated);
		return structuredClone(updated);
	}

	async startAppAuth(id: string, payload: Record<string, unknown>): Promise<V2PluginAppAuthStart> {
		const normalizedId = requireName(id, "app id");
		for (const [pluginId, plugin] of this.plugins) {
			const app = (plugin.appDescriptors ?? []).find((candidate) => candidate.id === normalizedId);
			if (!app) continue;
			if (app.auth === "unsupported") throw new Error(`App does not support authentication: ${normalizedId}`);
			const updatedApp = {
				...app,
				auth: "pending" as const,
				...(typeof payload.authorizationUrl === "string"
					? { metadata: { ...app.metadata, authorizationUrl: payload.authorizationUrl } }
					: {}),
			};
			this.plugins.set(pluginId, {
				...plugin,
				appDescriptors: (plugin.appDescriptors ?? []).map((candidate) =>
					candidate.id === normalizedId ? updatedApp : candidate,
				),
			});
			return {
				appId: normalizedId,
				state: "pending",
				...(typeof payload.authorizationUrl === "string" ? { authorizationUrl: payload.authorizationUrl } : {}),
			};
		}
		throw new Error(`Unknown app: ${normalizedId}`);
	}
}

/** JSON-backed registry with atomic replacement and restart recovery. */
export class JsonV2PluginRegistry implements V2PluginRegistry {
	private readonly memory: InMemoryV2PluginRegistry;
	private readonly filePath: string;
	private loaded = false;

	constructor(filePath: string) {
		this.filePath = filePath;
		this.memory = new InMemoryV2PluginRegistry();
	}

	private async ensureLoaded(): Promise<void> {
		if (this.loaded) return;
		this.loaded = true;
		try {
			const value: unknown = JSON.parse(await readFile(this.filePath, "utf8"));
			if (!value || typeof value !== "object" || !Array.isArray((value as { marketplaces?: unknown }).marketplaces))
				throw new Error("Plugin registry file is invalid");
			const state = value as V2PluginRegistryState;
			for (const marketplace of state.marketplaces) {
				if (!marketplace || typeof marketplace.name !== "string" || typeof marketplace.source !== "string")
					throw new Error("Plugin registry marketplace record is invalid");
			}
			for (const plugin of state.plugins ?? []) {
				if (!plugin || typeof plugin.id !== "string" || typeof plugin.name !== "string")
					throw new Error("Plugin registry plugin record is invalid");
			}
			this.memory.replace(state);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}

	private async persist(): Promise<void> {
		await mkdir(dirname(this.filePath), { recursive: true });
		const temporary = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
		await writeFile(temporary, `${JSON.stringify(this.memory.toState())}\n`, { mode: 0o600 });
		await rename(temporary, this.filePath);
	}

	async listMarketplaces(): Promise<readonly V2Marketplace[]> {
		await this.ensureLoaded();
		return this.memory.listMarketplaces();
	}

	async addMarketplace(name: string, source: string): Promise<V2Marketplace> {
		await this.ensureLoaded();
		const value = await this.memory.addMarketplace(name, source);
		await this.persist();
		return value;
	}

	async removeMarketplace(name: string): Promise<void> {
		await this.ensureLoaded();
		await this.memory.removeMarketplace(name);
		await this.persist();
	}

	async upgradeMarketplace(name: string): Promise<V2Marketplace> {
		await this.ensureLoaded();
		const value = await this.memory.upgradeMarketplace(name);
		await this.persist();
		return value;
	}

	async listPlugins(installedOnly = false): Promise<readonly V2Plugin[]> {
		await this.ensureLoaded();
		return this.memory.listPlugins(installedOnly);
	}

	async readPlugin(id: string): Promise<V2Plugin | undefined> {
		await this.ensureLoaded();
		return this.memory.readPlugin(id);
	}

	async installPlugin(input: Parameters<V2PluginRegistry["installPlugin"]>[0]): Promise<V2Plugin> {
		await this.ensureLoaded();
		const value = await this.memory.installPlugin(input);
		await this.persist();
		return value;
	}

	async uninstallPlugin(id: string): Promise<void> {
		await this.ensureLoaded();
		await this.memory.uninstallPlugin(id);
		await this.persist();
	}

	async setEnabled(id: string, enabled: boolean, scope?: V2PluginScope): Promise<V2Plugin> {
		await this.ensureLoaded();
		const value = await this.memory.setEnabled(id, enabled, scope);
		await this.persist();
		return value;
	}

	async startAppAuth(id: string, payload: Record<string, unknown>): Promise<V2PluginAppAuthStart> {
		await this.ensureLoaded();
		const value = await this.memory.startAppAuth(id, payload);
		await this.persist();
		return value;
	}
}

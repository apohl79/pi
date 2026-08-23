import { createHash, randomUUID } from "node:crypto";
import { MAX_V2_ARRAY_ITEMS, MAX_V2_JSON_DEPTH, MAX_V2_STRING_LENGTH } from "@earendil-works/pi-protocol";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type V2PluginScope = "user" | "project";

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
}

function requireName(value: string, field: string): string {
	const normalized = value.trim();
	if (normalized.length === 0 || normalized.length > 1024)
		throw new Error(`${field} must be non-empty and bounded`);
	return normalized;
}

function assertBoundedManifest(value: unknown, depth = 0): asserts value is Record<string, unknown> {
	if (depth > MAX_V2_JSON_DEPTH || typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error("Plugin manifest must be a bounded object");
	const entries = Object.entries(value);
	if (entries.length > MAX_V2_ARRAY_ITEMS) throw new Error("Plugin manifest has too many properties");
	for (const [key, child] of entries) {
		if (key.length > MAX_V2_STRING_LENGTH) throw new Error("Plugin manifest key is too long");
		if (typeof child === "string") {
			if (child.length > MAX_V2_STRING_LENGTH) throw new Error("Plugin manifest string is too long");
		} else if (Array.isArray(child)) {
			if (child.length > MAX_V2_ARRAY_ITEMS) throw new Error("Plugin manifest array is too large");
			child.forEach((item) => assertBoundedValue(item, depth + 1));
		} else if (typeof child === "object" && child !== null) {
			assertBoundedManifest(child, depth + 1);
		}
	}
}

function assertBoundedValue(value: unknown, depth: number): void {
	if (depth > MAX_V2_JSON_DEPTH) throw new Error("Plugin manifest is too deeply nested");
	if (typeof value === "string") {
		if (value.length > MAX_V2_STRING_LENGTH) throw new Error("Plugin manifest string is too long");
	} else if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error("Plugin manifest number is invalid");
	} else if (value !== null && typeof value !== "boolean" && value !== undefined && !Array.isArray(value) && typeof value !== "object") {
		throw new Error("Plugin manifest value is invalid");
	} else if (Array.isArray(value)) {
		if (value.length > MAX_V2_ARRAY_ITEMS) throw new Error("Plugin manifest array is too large");
		value.forEach((item) => assertBoundedValue(item, depth + 1));
	} else if (typeof value === "object" && value !== null) assertBoundedManifest(value, depth + 1);
}

function manifestDigest(manifest: Record<string, unknown>): string {
	return createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
}

function resourceCount(value: unknown): number {
	return Array.isArray(value) ? value.length : value === undefined ? 0 : 1;
}

function assertPersistedString(value: unknown, field: string, max = 1024): asserts value is string {
	if (typeof value !== "string" || value.length === 0 || value.length > max) throw new Error(`Invalid persisted ${field}`);
}

function assertPersistedState(state: V2PluginRegistryState): void {
	if (!Array.isArray(state.marketplaces) || state.marketplaces.length > MAX_V2_ARRAY_ITEMS)
		throw new Error("Invalid persisted marketplaces");
	for (const marketplace of state.marketplaces) {
		if (!marketplace || typeof marketplace !== "object") throw new Error("Invalid persisted marketplace");
		assertPersistedString(marketplace.name, "marketplace name");
		assertPersistedString(marketplace.source, "marketplace source");
		if (!Number.isFinite(marketplace.addedAt) || marketplace.addedAt < 0) throw new Error("Invalid persisted marketplace timestamp");
	}
	if (!Array.isArray(state.plugins) || state.plugins.length > MAX_V2_ARRAY_ITEMS) throw new Error("Invalid persisted plugins");
	for (const plugin of state.plugins) {
		if (!plugin || typeof plugin !== "object") throw new Error("Invalid persisted plugin");
		for (const [value, field] of [[plugin.id, "plugin id"], [plugin.name, "plugin name"], [plugin.marketplace, "plugin marketplace"], [plugin.version, "plugin version"], [plugin.manifestDigest, "plugin digest"]] as const)
			assertPersistedString(value, field, field === "plugin digest" ? 64 : 1024);
		if (!/^[a-f0-9]{64}$/u.test(plugin.manifestDigest)) throw new Error("Invalid persisted plugin digest");
		if (plugin.root !== undefined) assertPersistedString(plugin.root, "plugin root");
		if (typeof plugin.enabled !== "boolean" || (plugin.scope !== "user" && plugin.scope !== "project") || plugin.provenance !== "manifest" && plugin.provenance !== "package")
			throw new Error("Invalid persisted plugin metadata");
		if (!plugin.resources || typeof plugin.resources !== "object") throw new Error("Invalid persisted plugin resources");
		for (const key of ["skills", "commands"] as const) {
			const values = plugin.resources[key];
			if (!Array.isArray(values) || values.length > 256 || values.some((value) => typeof value !== "string" || value.length > 1024))
				throw new Error("Invalid persisted plugin resource list");
		}
		for (const key of ["apps", "hooks"] as const) {
			const value = plugin.resources[key];
			if (!Number.isSafeInteger(value) || value < 0 || value > MAX_V2_ARRAY_ITEMS) throw new Error("Invalid persisted plugin resource count");
		}
	}
}

export class InMemoryV2PluginRegistry implements V2PluginRegistry {
	private readonly marketplaces = new Map<string, V2Marketplace>();
	private readonly plugins = new Map<string, V2Plugin>();

	constructor(state?: V2PluginRegistryState) {
		for (const marketplace of state?.marketplaces ?? [])
			this.marketplaces.set(marketplace.name, structuredClone(marketplace));
		for (const plugin of state?.plugins ?? []) this.plugins.set(plugin.id, structuredClone(plugin));
	}

	toState(): V2PluginRegistryState {
		return { marketplaces: [...this.marketplaces.values()], plugins: [...this.plugins.values()] };
	}

	replace(state: V2PluginRegistryState): void {
		this.marketplaces.clear();
		this.plugins.clear();
		for (const marketplace of state.marketplaces)
			this.marketplaces.set(marketplace.name, structuredClone(marketplace));
		for (const plugin of state.plugins ?? []) this.plugins.set(plugin.id, structuredClone(plugin));
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
		return [...this.plugins.values()].map((plugin) => structuredClone(plugin));
	}

	async readPlugin(id: string): Promise<V2Plugin | undefined> {
		return this.plugins.has(id) ? structuredClone(this.plugins.get(id)!) : undefined;
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
		assertBoundedManifest(input.manifest);
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
					? manifest.skills
						.filter((value): value is string => typeof value === "string")
						.slice(0, 256)
						.map((value) => value.slice(0, 1024))
					: [],
				commands: Array.isArray(manifest.commands)
					? manifest.commands
						.filter((value): value is string => typeof value === "string")
						.slice(0, 256)
						.map((value) => value.slice(0, 1024))
					: [],
				apps: resourceCount(manifest.apps),
				hooks: resourceCount(manifest.hooks),
			},
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
		const updated = { ...existing, enabled, ...(scope === undefined ? {} : { scope }) };
		this.plugins.set(id, updated);
		return structuredClone(updated);
	}
}

/** JSON-backed registry with atomic replacement and restart recovery. */
export class JsonV2PluginRegistry implements V2PluginRegistry {
	private readonly memory: InMemoryV2PluginRegistry;
	private readonly filePath: string;
	private loaded = false;
	private mutationTail: Promise<void> = Promise.resolve();

	constructor(filePath: string) {
		this.filePath = filePath;
		this.memory = new InMemoryV2PluginRegistry();
	}

	private async ensureLoaded(): Promise<void> {
		if (this.loaded) return;
		try {
			const value: unknown = JSON.parse(await readFile(this.filePath, "utf8"));
			if (!value || typeof value !== "object" || !Array.isArray((value as { marketplaces?: unknown }).marketplaces))
				throw new Error("Plugin registry file is invalid");
			const state = value as V2PluginRegistryState;
			assertPersistedState(state);
			this.memory.replace(state);
			this.loaded = true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				this.loaded = true;
				return;
			}
			this.loaded = false;
			throw error;
		}
	}

	private async persist(): Promise<void> {
		await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
		const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
		await writeFile(temporary, `${JSON.stringify(this.memory.toState())}\n`, { mode: 0o600 });
		await rename(temporary, this.filePath);
	}

	private async mutate<T>(action: () => Promise<T>): Promise<T> {
		const previous = this.mutationTail;
		let release!: () => void;
		this.mutationTail = new Promise<void>((resolve) => (release = resolve));
		return previous
			.catch(() => undefined)
			.then(async () => {
				const before = this.memory.toState();
				try {
					const value = await action();
					await this.persist();
					return value;
				} catch (error) {
					this.memory.replace(before);
					throw error;
				}
			})
			.finally(release);
	}

	async listMarketplaces(): Promise<readonly V2Marketplace[]> {
		await this.ensureLoaded();
		return this.memory.listMarketplaces();
	}

	async addMarketplace(name: string, source: string): Promise<V2Marketplace> {
		await this.ensureLoaded();
		return this.mutate(() => this.memory.addMarketplace(name, source));
	}

	async removeMarketplace(name: string): Promise<void> {
		await this.ensureLoaded();
		await this.mutate(() => this.memory.removeMarketplace(name));
	}

	async upgradeMarketplace(name: string): Promise<V2Marketplace> {
		await this.ensureLoaded();
		return this.mutate(() => this.memory.upgradeMarketplace(name));
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
		return this.mutate(() => this.memory.installPlugin(input));
	}

	async uninstallPlugin(id: string): Promise<void> {
		await this.ensureLoaded();
		await this.mutate(() => this.memory.uninstallPlugin(id));
	}

	async setEnabled(id: string, enabled: boolean, scope?: V2PluginScope): Promise<V2Plugin> {
		await this.ensureLoaded();
		return this.mutate(() => this.memory.setEnabled(id, enabled, scope));
	}
}

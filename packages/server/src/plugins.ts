import { createHash } from "node:crypto";

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
	if (normalized.length === 0) throw new Error(`${field} must not be empty`);
	return normalized;
}

function manifestDigest(manifest: Record<string, unknown>): string {
	return createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
}

function resourceCount(value: unknown): number {
	return Array.isArray(value) ? value.length : value === undefined ? 0 : 1;
}

export class InMemoryV2PluginRegistry implements V2PluginRegistry {
	private readonly marketplaces = new Map<string, V2Marketplace>();
	private readonly plugins = new Map<string, V2Plugin>();

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

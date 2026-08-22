import { realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export type CodexPluginJson = null | boolean | number | string | CodexPluginJson[] | { [key: string]: CodexPluginJson };

export interface CodexPluginDiagnostic {
	code: "invalid_manifest" | "unsupported_mcp_resource";
	severity: "error" | "warning";
	message: string;
}

export interface CodexPluginManifest {
	name: string;
	version: string;
	description?: string;
	root?: string;
	skills: string[];
	commands: string[];
	apps?: CodexPluginJson;
	hooks?: CodexPluginJson;
	context?: CodexPluginJson;
	interface?: CodexPluginJson;
	mcpServers?: CodexPluginJson;
}

export interface CodexPluginParseResult {
	manifest?: CodexPluginManifest;
	diagnostics: CodexPluginDiagnostic[];
}

export type CodexMarketplaceSource = { kind: "local" | "git" | "npm"; value: string };

export interface CodexMarketplacePlugin {
	name: string;
	source: CodexMarketplaceSource;
}

export interface CodexMarketplaceManifest {
	plugins: CodexMarketplacePlugin[];
}

export interface CodexMarketplaceParseResult {
	manifest?: CodexMarketplaceManifest;
	diagnostics: CodexPluginDiagnostic[];
}

export type CodexPluginResourceResolution =
	| { ok: true; path: string }
	| { ok: false; code: "absolute_path" | "path_escape"; message: string };

function canonicalizeWithMissingSuffix(path: string): string | undefined {
	const missing: string[] = [];
	let current = path;
	while (true) {
		try {
			const canonical = realpathSync(current);
			return join(canonical, ...missing.reverse());
		} catch {
			const parent = dirname(current);
			if (parent === current) return undefined;
			missing.push(current.slice(parent.length + 1));
			current = parent;
		}
	}
}

/** Resolve a manifest resource without allowing absolute paths or root escape. */
export function resolveCodexPluginResource(root: string, resource: string): CodexPluginResourceResolution {
	const normalized = resource.replaceAll("\\", "/");
	if (isAbsolute(normalized) || /^[A-Za-z]:\//.test(normalized)) {
		return { ok: false, code: "absolute_path", message: `Plugin resource must be relative: ${resource}` };
	}
	const pluginRoot = resolve(root);
	const candidate = resolve(pluginRoot, normalized);
	const canonicalRoot = canonicalizeWithMissingSuffix(pluginRoot) ?? pluginRoot;
	const canonicalCandidate = canonicalizeWithMissingSuffix(candidate);
	const fromRoot = relative(canonicalRoot, canonicalCandidate ?? candidate);
	if (fromRoot === ".." || fromRoot.startsWith("../") || isAbsolute(fromRoot)) {
		return { ok: false, code: "path_escape", message: `Plugin resource escapes its root: ${resource}` };
	}
	return { ok: true, path: canonicalCandidate ?? candidate };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown, field: string, diagnostics: CodexPluginDiagnostic[]): string[] {
	if (value === undefined) return [];
	if (typeof value === "string") return [value];
	if (Array.isArray(value) && value.every((item) => typeof item === "string")) return [...value];
	diagnostics.push({
		code: "invalid_manifest",
		severity: "error",
		message: `${field} must be a string or string array`,
	});
	return [];
}

function marketplaceSource(value: unknown): CodexMarketplaceSource | undefined {
	if (typeof value === "string") {
		if (value.startsWith("npm:")) return { kind: "npm", value: value.slice(4) };
		if (value.startsWith("git+") || value.endsWith(".git") || value.includes("github.com/"))
			return { kind: "git", value };
		return { kind: "local", value };
	}
	if (!isRecord(value)) return undefined;
	if (typeof value.path === "string") return { kind: "local", value: value.path };
	if (typeof value.url === "string") return { kind: "git", value: value.url };
	if (typeof value.package === "string") return { kind: "npm", value: value.package };
	return undefined;
}

export function parseCodexMarketplaceManifest(input: unknown): CodexMarketplaceParseResult {
	const diagnostics: CodexPluginDiagnostic[] = [];
	if (!isRecord(input) || !Array.isArray(input.plugins)) {
		return {
			diagnostics: [
				{ code: "invalid_manifest", severity: "error", message: "Marketplace manifest requires a plugins array" },
			],
		};
	}
	const plugins: CodexMarketplacePlugin[] = [];
	for (const [index, raw] of input.plugins.entries()) {
		if (!isRecord(raw) || typeof raw.name !== "string" || raw.name.length === 0) {
			diagnostics.push({
				code: "invalid_manifest",
				severity: "error",
				message: `Marketplace plugin ${index} requires a name`,
			});
			continue;
		}
		const source = marketplaceSource(raw.source);
		if (!source) {
			diagnostics.push({
				code: "invalid_manifest",
				severity: "error",
				message: `Marketplace plugin ${raw.name} requires a source`,
			});
			continue;
		}
		plugins.push({ name: raw.name, source });
	}
	return diagnostics.some((diagnostic) => diagnostic.severity === "error")
		? { diagnostics }
		: { manifest: { plugins }, diagnostics };
}

export function parseCodexPluginManifest(input: unknown): CodexPluginParseResult {
	const diagnostics: CodexPluginDiagnostic[] = [];
	if (!isRecord(input)) {
		return {
			diagnostics: [{ code: "invalid_manifest", severity: "error", message: "Plugin manifest must be an object" }],
		};
	}
	const name = input.name;
	const version = input.version;
	if (typeof name !== "string" || name.length === 0)
		diagnostics.push({
			code: "invalid_manifest",
			severity: "error",
			message: "Plugin manifest requires a non-empty name",
		});
	if (typeof version !== "string" || version.length === 0)
		diagnostics.push({
			code: "invalid_manifest",
			severity: "error",
			message: "Plugin manifest requires a non-empty version",
		});
	const skills = stringArray(input.skills, "skills", diagnostics);
	const commands = stringArray(input.commands, "commands", diagnostics);
	if (input.mcpServers !== undefined) {
		diagnostics.push({
			code: "unsupported_mcp_resource",
			severity: "warning",
			message: "MCP resources are not started by Pi; supported plugin resources may still activate",
		});
	}
	if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) return { diagnostics };
	return {
		manifest: {
			name: name as string,
			version: version as string,
			...(typeof input.description === "string" ? { description: input.description } : {}),
			...(typeof input.root === "string" ? { root: input.root } : {}),
			skills,
			commands,
			...(input.apps === undefined ? {} : { apps: input.apps as CodexPluginJson }),
			...(input.hooks === undefined ? {} : { hooks: input.hooks as CodexPluginJson }),
			...(input.context === undefined ? {} : { context: input.context as CodexPluginJson }),
			...(input.interface === undefined ? {} : { interface: input.interface as CodexPluginJson }),
			...(input.mcpServers === undefined ? {} : { mcpServers: input.mcpServers as CodexPluginJson }),
		},
		diagnostics,
	};
}

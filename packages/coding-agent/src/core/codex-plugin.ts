import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

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

export type CodexPluginDiskResolution =
	| { ok: true; path: string }
	| { ok: false; code: "absolute_path" | "path_escape" | "symlink_escape" | "missing"; message: string };

/** Resolve a manifest resource without allowing absolute paths or root escape. */
export function resolveCodexPluginResource(root: string, resource: string): CodexPluginResourceResolution {
	const normalized = resource.replaceAll("\\", "/");
	if (isAbsolute(normalized) || /^[A-Za-z]:\//.test(normalized)) {
		return { ok: false, code: "absolute_path", message: `Plugin resource must be relative: ${resource}` };
	}
	const pluginRoot = resolve(root);
	const candidate = resolve(pluginRoot, normalized);
	const fromRoot = relative(pluginRoot, candidate);
	if (fromRoot === ".." || fromRoot.startsWith("../") || isAbsolute(fromRoot)) {
		return { ok: false, code: "path_escape", message: `Plugin resource escapes its root: ${resource}` };
	}
	return { ok: true, path: candidate };
}

/** Resolve an existing resource and reject symlink targets outside the plugin root. */
export async function resolveCodexPluginResourceOnDisk(
	root: string,
	resource: string,
): Promise<CodexPluginDiskResolution> {
	const lexical = resolveCodexPluginResource(root, resource);
	if (!lexical.ok) return lexical;
	try {
		const [canonicalRoot, canonicalPath] = await Promise.all([realpath(root), realpath(lexical.path)]);
		const fromRoot = relative(canonicalRoot, canonicalPath);
		if (fromRoot === ".." || fromRoot.startsWith("../") || isAbsolute(fromRoot))
			return { ok: false, code: "symlink_escape", message: `Plugin resource symlink escapes its root: ${resource}` };
		return { ok: true, path: canonicalPath };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT")
			return { ok: false, code: "missing", message: `Plugin resource does not exist: ${resource}` };
		throw error;
	}
}

async function readJson(path: string): Promise<unknown | undefined> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as unknown;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

/** Load the Codex plugin manifest from a declared plugin root. */
export async function loadCodexPluginManifest(root: string): Promise<CodexPluginParseResult & { root: string }> {
	const canonicalRoot = await realpath(root);
	const manifestPath = await resolveCodexPluginResourceOnDisk(canonicalRoot, ".codex-plugin/plugin.json");
	if (!manifestPath.ok && manifestPath.code === "missing") {
		return {
			root: canonicalRoot,
			diagnostics: [{ code: "invalid_manifest", severity: "error", message: "Codex plugin manifest was not found" }],
		};
	}
	if (!manifestPath.ok) {
		return {
			root: canonicalRoot,
			diagnostics: [{ code: "invalid_manifest", severity: "error", message: manifestPath.message }],
		};
	}
	return { root: canonicalRoot, ...parseCodexPluginManifest(await readJson(manifestPath.path)) };
}

/** Discover a marketplace manifest at a supported Codex marketplace location. */
export async function loadCodexMarketplaceManifest(
	root: string,
): Promise<CodexMarketplaceParseResult & { root: string; path?: string }> {
	const canonicalRoot = await realpath(root);
	for (const relativePath of [".agents/plugins/marketplace.json", ".codex-plugin/marketplace.json"]) {
		const candidate = await resolveCodexPluginResourceOnDisk(canonicalRoot, relativePath);
		if (!candidate.ok && candidate.code === "missing") continue;
		if (!candidate.ok)
			return {
				root: canonicalRoot,
				diagnostics: [{ code: "invalid_manifest", severity: "error", message: candidate.message }],
			};
		return {
			root: canonicalRoot,
			path: candidate.path,
			...parseCodexMarketplaceManifest(await readJson(candidate.path)),
		};
	}
	return {
		root: canonicalRoot,
		diagnostics: [
			{ code: "invalid_manifest", severity: "error", message: "Codex marketplace manifest was not found" },
		],
	};
}

/** Resolve a local marketplace plugin source relative to the marketplace root. */
export async function resolveLocalCodexMarketplacePlugin(
	marketplaceRoot: string,
	plugin: CodexMarketplacePlugin,
): Promise<CodexPluginParseResult & { root: string }> {
	if (plugin.source.kind !== "local") {
		return {
			root: marketplaceRoot,
			diagnostics: [
				{ code: "invalid_manifest", severity: "error", message: `Plugin source is not local: ${plugin.name}` },
			],
		};
	}
	const source = await resolveCodexPluginResourceOnDisk(marketplaceRoot, plugin.source.value);
	if (!source.ok)
		return {
			root: marketplaceRoot,
			diagnostics: [{ code: "invalid_manifest", severity: "error", message: source.message }],
		};
	return loadCodexPluginManifest(source.path);
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

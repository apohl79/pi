import { constants, realpathSync } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { MAX_V2_ARRAY_ITEMS, MAX_V2_JSON_DEPTH, MAX_V2_STRING_LENGTH } from "@earendil-works/pi-protocol";

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
	const canonicalRoot = canonicalizeWithMissingSuffix(pluginRoot) ?? pluginRoot;
	const canonicalCandidate = canonicalizeWithMissingSuffix(candidate);
	const fromRoot = relative(canonicalRoot, canonicalCandidate ?? candidate);
	if (fromRoot === ".." || fromRoot.startsWith("../") || isAbsolute(fromRoot)) {
		return { ok: false, code: "path_escape", message: `Plugin resource escapes its root: ${resource}` };
	}
	return { ok: true, path: canonicalCandidate ?? candidate };
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

const MAX_MANIFEST_BYTES = MAX_V2_STRING_LENGTH;

function assertBoundedJson(value: unknown, depth = 0): void {
	if (depth > MAX_V2_JSON_DEPTH) throw new Error("Manifest nesting exceeds the supported depth");
	if (typeof value === "string") {
		if (value.length > MAX_V2_STRING_LENGTH) throw new Error("Manifest string exceeds the supported length");
	} else if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error("Manifest number is invalid");
	} else if (Array.isArray(value)) {
		if (value.length > MAX_V2_ARRAY_ITEMS) throw new Error("Manifest array exceeds the supported size");
		value.forEach((item) => assertBoundedJson(item, depth + 1));
	} else if (isRecord(value)) {
		const entries = Object.entries(value);
		if (entries.length > MAX_V2_ARRAY_ITEMS) throw new Error("Manifest object exceeds the supported size");
		for (const [key, child] of entries) {
			if (key.length > MAX_V2_STRING_LENGTH) throw new Error("Manifest key exceeds the supported length");
			assertBoundedJson(child, depth + 1);
		}
	}
}

type JsonReadResult = { kind: "ok"; value: unknown } | { kind: "missing" | "malformed" };

async function readJson(path: string): Promise<JsonReadResult> {
	try {
		const metadata = await stat(path);
		if (!metadata.isFile() || metadata.size > MAX_MANIFEST_BYTES) return { kind: "malformed" };
		const canonical = await realpath(path);
		const handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
		let value: unknown;
		try {
			value = JSON.parse(await handle.readFile("utf8")) as unknown;
		} finally {
			await handle.close();
		}
		assertBoundedJson(value);
		return { kind: "ok", value };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
		return { kind: "malformed" };
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
	const parsed = await readJson(manifestPath.path);
	if (parsed.kind !== "ok")
		return {
			root: canonicalRoot,
			diagnostics: [{ code: "invalid_manifest", severity: "error", message: "Codex plugin manifest is malformed" }],
		};
	return { root: canonicalRoot, ...parseCodexPluginManifest(parsed.value) };
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
		const parsed = await readJson(candidate.path);
		if (parsed.kind !== "ok")
			return {
				root: canonicalRoot,
				path: candidate.path,
				diagnostics: [{ code: "invalid_manifest", severity: "error", message: "Codex marketplace manifest is malformed" }],
			};
		return {
			root: canonicalRoot,
			path: candidate.path,
			...parseCodexMarketplaceManifest(parsed.value),
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
	try {
		assertBoundedJson(input);
	} catch (error) {
		return {
			diagnostics: [
				{
					code: "invalid_manifest",
					severity: "error",
					message: error instanceof Error ? error.message : "Marketplace manifest exceeds supported bounds",
				},
			],
		};
	}
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
	try {
		assertBoundedJson(input);
	} catch (error) {
		return {
			diagnostics: [
				{
					code: "invalid_manifest",
					severity: "error",
					message: error instanceof Error ? error.message : "Plugin manifest exceeds supported bounds",
				},
			],
		};
	}
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

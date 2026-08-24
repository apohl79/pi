import { realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import {
	type CodexPluginManifest,
	loadCodexMarketplaceManifest,
	loadCodexPluginManifest,
	resolveCodexPluginResourceOnDisk,
	resolveLocalCodexMarketplacePlugin,
} from "./codex-plugin.ts";

export type CodexPluginAcquisition = Readonly<{
	root: string;
	manifest: CodexPluginManifest;
	provenance: "local" | "git" | "npm";
	source: string;
}>;

export type CodexPluginAcquisitionAdapter = (source: string) => Promise<string>;

export type CodexPluginAcquisitionOptions = Readonly<{
	baseRoot?: string;
	git?: CodexPluginAcquisitionAdapter;
	npm?: CodexPluginAcquisitionAdapter;
}>;

export type CodexMarketplacePluginAcquisition = CodexPluginAcquisition;

export class CodexPluginAcquisitionError extends Error {
	readonly code: "unsupported_source" | "invalid_source" | "manifest_invalid";

	constructor(code: CodexPluginAcquisitionError["code"], message: string) {
		super(message);
		this.name = "CodexPluginAcquisitionError";
		this.code = code;
	}
}

function sourceKind(source: string): "local" | "git" | "npm" {
	if (source.startsWith("npm:")) return "npm";
	if (source.startsWith("git+") || source.endsWith(".git") || source.includes("github.com/")) return "git";
	return "local";
}

/** Acquire a plugin root through an injected local, Git, or npm adapter. */
export async function acquireCodexPlugin(
	source: string,
	options: CodexPluginAcquisitionOptions = {},
): Promise<CodexPluginAcquisition> {
	const normalized = source.trim();
	if (normalized.length === 0)
		throw new CodexPluginAcquisitionError("invalid_source", "Plugin source must not be empty");
	const provenance = sourceKind(normalized);
	let root: string;
	if (provenance === "local") {
		const baseRoot = options.baseRoot ?? process.cwd();
		if (isAbsolute(normalized)) {
			root = await realpath(normalized);
		} else {
			const resource = await resolveCodexPluginResourceOnDisk(baseRoot, normalized);
			if (!resource.ok) throw new CodexPluginAcquisitionError("invalid_source", resource.message);
			root = resource.path;
		}
	} else {
		const adapter = provenance === "git" ? options.git : options.npm;
		if (!adapter)
			throw new CodexPluginAcquisitionError(
				"unsupported_source",
				`No ${provenance} plugin acquisition adapter is configured`,
			);
		root = await adapter(normalized);
		if (isAbsolute(root) === false)
			throw new CodexPluginAcquisitionError("invalid_source", "Acquisition adapter must return an absolute root");
		root = await realpath(resolve(root));
	}
	const loaded = await loadCodexPluginManifest(root);
	if (!loaded.manifest) {
		throw new CodexPluginAcquisitionError(
			"manifest_invalid",
			loaded.diagnostics.map((diagnostic) => diagnostic.message).join("; "),
		);
	}
	return { root: loaded.root, manifest: loaded.manifest, provenance, source: normalized };
}

/** Resolve and acquire a named plugin from a Codex marketplace root. */
export async function acquireCodexMarketplacePlugin(
	marketplaceSource: string,
	pluginName: string,
	options: CodexPluginAcquisitionOptions = {},
): Promise<CodexMarketplacePluginAcquisition> {
	const marketplace = await acquireMarketplaceRoot(marketplaceSource, options);
	const loaded = await loadCodexMarketplaceManifest(marketplace.root);
	if (!loaded.manifest)
		throw new CodexPluginAcquisitionError(
			"manifest_invalid",
			loaded.diagnostics.map((diagnostic) => diagnostic.message).join("; "),
		);
	const plugin = loaded.manifest.plugins.find((candidate) => candidate.name === pluginName);
	if (!plugin)
		throw new CodexPluginAcquisitionError("invalid_source", `Marketplace plugin was not found: ${pluginName}`);
	if (plugin.source.kind === "local") {
		const resolved = await resolveLocalCodexMarketplacePlugin(marketplace.root, plugin);
		if (!resolved.manifest)
			throw new CodexPluginAcquisitionError(
				"manifest_invalid",
				resolved.diagnostics.map((diagnostic) => diagnostic.message).join("; "),
			);
		return { root: resolved.root, manifest: resolved.manifest, provenance: "local", source: plugin.source.value };
	}
	return acquireCodexPlugin(
		plugin.source.kind === "npm" ? `npm:${plugin.source.value}` : plugin.source.value,
		options,
	);
}

async function acquireMarketplaceRoot(
	source: string,
	options: CodexPluginAcquisitionOptions,
): Promise<{ root: string; provenance: "local" | "git" | "npm" }> {
	const normalized = source.trim();
	const provenance = sourceKind(normalized);
	if (provenance === "local") {
		const baseRoot = options.baseRoot ?? process.cwd();
		const resource = isAbsolute(normalized)
			? { ok: true as const, path: await realpath(normalized) }
			: await resolveCodexPluginResourceOnDisk(baseRoot, normalized);
		if (!resource.ok) throw new CodexPluginAcquisitionError("invalid_source", resource.message);
		return { root: resource.path, provenance };
	}
	const adapter = provenance === "git" ? options.git : options.npm;
	if (!adapter)
		throw new CodexPluginAcquisitionError(
			"unsupported_source",
			`No ${provenance} marketplace acquisition adapter is configured`,
		);
	const root = await adapter(normalized);
	if (!isAbsolute(root))
		throw new CodexPluginAcquisitionError("invalid_source", "Acquisition adapter must return an absolute root");
	return { root: await realpath(resolve(root)), provenance };
}

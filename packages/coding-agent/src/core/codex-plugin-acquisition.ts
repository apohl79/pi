import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { type CodexPluginManifest, loadCodexPluginManifest, resolveCodexPluginResourceOnDisk } from "./codex-plugin.ts";

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

function isWithin(root: string, candidate: string): boolean {
	const path = relative(root, candidate);
	return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
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
	let authorizedRoot: string;
	try {
		authorizedRoot = await realpath(options.baseRoot ?? process.cwd());
	} catch {
		throw new CodexPluginAcquisitionError("invalid_source", "Configured plugin acquisition root is unavailable");
	}
	let root: string;
	if (provenance === "local") {
		if (isAbsolute(normalized)) {
			root = await realpath(normalized);
		} else {
			const resource = await resolveCodexPluginResourceOnDisk(authorizedRoot, normalized);
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
	if (!isWithin(authorizedRoot, root))
		throw new CodexPluginAcquisitionError("invalid_source", "Acquired plugin root escapes the authorized root");
	const loaded = await loadCodexPluginManifest(root);
	if (!loaded.manifest) {
		throw new CodexPluginAcquisitionError(
			"manifest_invalid",
			loaded.diagnostics.map((diagnostic) => diagnostic.message).join("; "),
		);
	}
	return { root: loaded.root, manifest: loaded.manifest, provenance, source: normalized };
}

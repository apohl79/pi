import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type CodexPluginManifest, loadCodexPluginManifest, resolveCodexPluginResourceOnDisk } from "./codex-plugin.ts";

export type CodexPluginActivation = Readonly<{
	id: string;
	version: string;
	root: string;
	manifestDigest: string;
	previousVersion?: string;
}>;

export type CodexPluginActivationOptions = Readonly<{
	id: string;
	version: string;
	sourceRoot: string;
	manifest: CodexPluginManifest;
}>;

export class CodexPluginActivationError extends Error {
	readonly code: "invalid_manifest" | "already_active" | "activation_failed";

	constructor(code: CodexPluginActivationError["code"], message: string) {
		super(message);
		this.name = "CodexPluginActivationError";
		this.code = code;
	}
}

function activationKey(id: string): string {
	return createHash("sha256").update(id).digest("hex");
}

function manifestDigest(manifest: CodexPluginManifest): string {
	return createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
}

async function validateResources(root: string, manifest: CodexPluginManifest): Promise<void> {
	for (const resource of [...manifest.skills, ...manifest.commands]) {
		const resolved = await resolveCodexPluginResourceOnDisk(root, resource);
		if (!resolved.ok)
			throw new CodexPluginActivationError("invalid_manifest", `Plugin resource is invalid: ${resolved.message}`);
	}
}

/** Stage and atomically activate a validated plugin version under a private cache root. */
export class CodexPluginActivationStore {
	private readonly cacheRoot: string;

	constructor(cacheRoot: string) {
		this.cacheRoot = cacheRoot;
	}

	async activate(options: CodexPluginActivationOptions): Promise<CodexPluginActivation> {
		if (options.id.trim().length === 0 || options.version.trim().length === 0)
			throw new CodexPluginActivationError("invalid_manifest", "Plugin id and version are required");
		if (options.version.includes("/") || options.version.includes("\\"))
			throw new CodexPluginActivationError("invalid_manifest", "Plugin version must be a single path segment");
		const sourceRoot = await realpath(options.sourceRoot);
		const loaded = await loadCodexPluginManifest(sourceRoot);
		if (
			!loaded.manifest ||
			loaded.manifest.name !== options.manifest.name ||
			loaded.manifest.version !== options.version
		) {
			throw new CodexPluginActivationError(
				"invalid_manifest",
				"Staged plugin manifest does not match activation metadata",
			);
		}
		await validateResources(sourceRoot, loaded.manifest);
		const key = activationKey(options.id);
		const versionRoot = join(this.cacheRoot, key, "versions", options.version);
		const activePath = join(this.cacheRoot, key, "active.json");
		let previousVersion: string | undefined;
		try {
			const current = JSON.parse(await readFile(activePath, "utf8")) as { version?: unknown };
			if (typeof current.version === "string") previousVersion = current.version;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		if (previousVersion === options.version) {
			throw new CodexPluginActivationError(
				"already_active",
				`Plugin version is already active: ${options.id}@${options.version}`,
			);
		}
		const stageRoot = join(this.cacheRoot, `.staging-${randomUUID()}`);
		try {
			await mkdir(join(this.cacheRoot, key, "versions"), { recursive: true, mode: 0o700 });
			await cp(sourceRoot, stageRoot, { recursive: true, force: false, errorOnExist: true });
			const staged = await loadCodexPluginManifest(stageRoot);
			if (
				!staged.manifest ||
				staged.manifest.name !== options.manifest.name ||
				staged.manifest.version !== options.version
			)
				throw new CodexPluginActivationError("invalid_manifest", "Copied plugin manifest failed validation");
			await validateResources(stageRoot, staged.manifest);
			await rename(stageRoot, versionRoot);
			const temporaryPointer = `${activePath}.${randomUUID()}.tmp`;
			await writeFile(temporaryPointer, `${JSON.stringify({ version: options.version })}\n`, { mode: 0o600 });
			await rename(temporaryPointer, activePath);
			return {
				id: options.id,
				version: options.version,
				root: versionRoot,
				manifestDigest: manifestDigest(options.manifest),
				...(previousVersion === undefined ? {} : { previousVersion }),
			};
		} catch (error) {
			await rm(stageRoot, { recursive: true, force: true });
			if (error instanceof CodexPluginActivationError) throw error;
			throw new CodexPluginActivationError(
				"activation_failed",
				error instanceof Error ? error.message : String(error),
			);
		}
	}

	/** Restore the pointer that was active before an activation failed to persist. */
	async rollback(activation: CodexPluginActivation): Promise<void> {
		const key = activationKey(activation.id);
		const activePath = join(this.cacheRoot, key, "active.json");
		try {
			const current = JSON.parse(await readFile(activePath, "utf8")) as { version?: unknown };
			if (current.version !== activation.version) return;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		const versionRoot = join(this.cacheRoot, key, "versions", activation.version);
		if (activation.previousVersion === undefined) {
			await rm(activePath, { force: true });
			await rm(join(this.cacheRoot, key), { recursive: true, force: true });
			return;
		}
		const temporaryPointer = [activePath, randomUUID(), "tmp"].join(".");
		await writeFile(temporaryPointer, JSON.stringify({ version: activation.previousVersion }).concat("\n"), {
			mode: 0o600,
		});
		await rename(temporaryPointer, activePath);
		await rm(versionRoot, { recursive: true, force: true });
	}

	/** Remove all private staged state after a plugin is uninstalled. */
	async remove(id: string): Promise<void> {
		await rm(join(this.cacheRoot, activationKey(id)), { recursive: true, force: true });
	}
}

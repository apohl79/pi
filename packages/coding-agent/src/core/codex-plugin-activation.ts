import { createHash, randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { type CodexPluginManifest, loadCodexPluginManifest } from "./codex-plugin.ts";

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

async function rejectSymlinkEntries(root: string): Promise<void> {
	const entries = await readdir(root, { withFileTypes: true });
	for (const entry of entries) {
		const path = join(root, entry.name);
		if (entry.isSymbolicLink()) throw new CodexPluginActivationError("activation_failed", "Plugin source contains a symlink");
		if (entry.isDirectory()) await rejectSymlinkEntries(path);
	}
}

async function ensurePrivateCacheRoot(root: string): Promise<void> {
	await mkdir(root, { recursive: true, mode: 0o700 });
	let metadata = await lstat(root);
	if (!metadata.isDirectory()) throw new Error("Plugin cache root is not a directory");
	const uid = process.getuid?.();
	if (uid !== undefined && metadata.uid !== uid) throw new Error("Plugin cache root has an unexpected owner");
	if ((metadata.mode & 0o077) !== 0) {
		await chmod(root, 0o700);
		metadata = await lstat(root);
		if ((metadata.mode & 0o077) !== 0) throw new Error("Plugin cache root permissions are unsafe");
	}
}

/** Stage and atomically activate a validated plugin version under a private cache root. */
export class CodexPluginActivationStore {
	private readonly cacheRoot: string;
	private readonly activationTails = new Map<string, Promise<void>>();

	constructor(cacheRoot: string) {
		this.cacheRoot = cacheRoot;
	}

	async activate(options: CodexPluginActivationOptions): Promise<CodexPluginActivation> {
		const previous = this.activationTails.get(options.id) ?? Promise.resolve();
		let release!: () => void;
		const current = new Promise<void>((resolve) => (release = resolve));
		this.activationTails.set(options.id, current);
		try {
			await previous;
			return await this.activateUnlocked(options);
		} finally {
			release();
			if (this.activationTails.get(options.id) === current) this.activationTails.delete(options.id);
		}
	}

	private async activateUnlocked(options: CodexPluginActivationOptions): Promise<CodexPluginActivation> {
		if (options.id.trim().length === 0 || options.version.trim().length === 0)
			throw new CodexPluginActivationError("invalid_manifest", "Plugin id and version are required");
		if (options.version.includes("/") || options.version.includes("\\"))
			throw new CodexPluginActivationError("invalid_manifest", "Plugin version must be a single path segment");
		const sourceRoot = await realpath(options.sourceRoot);
		await rejectSymlinkEntries(sourceRoot);
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
		await ensurePrivateCacheRoot(this.cacheRoot);
		const stageRoot = join(this.cacheRoot, `.staging-${randomUUID()}`);
		let versionInstalled = false;
		try {
			await mkdir(join(this.cacheRoot, key, "versions"), { recursive: true, mode: 0o700 });
			await cp(sourceRoot, stageRoot, { recursive: true, force: false, errorOnExist: true });
			await rejectSymlinkEntries(stageRoot);
			const staged = await loadCodexPluginManifest(stageRoot);
			if (
				!staged.manifest ||
				staged.manifest.name !== options.manifest.name ||
				staged.manifest.version !== options.version
			)
				throw new CodexPluginActivationError("invalid_manifest", "Copied plugin manifest failed validation");
			await rename(stageRoot, versionRoot);
			versionInstalled = true;
			const temporaryPointer = `${activePath}.${randomUUID()}.tmp`;
			await writeFile(temporaryPointer, `${JSON.stringify({ version: options.version })}\n`, { mode: 0o600 });
			await rename(temporaryPointer, activePath);
			return {
				id: options.id,
				version: options.version,
				root: versionRoot,
				manifestDigest: manifestDigest(staged.manifest),
				...(previousVersion === undefined ? {} : { previousVersion }),
			};
		} catch (error) {
			await rm(stageRoot, { recursive: true, force: true });
			if (versionInstalled) await rm(versionRoot, { recursive: true, force: true });
			if (error instanceof CodexPluginActivationError) throw error;
			throw new CodexPluginActivationError(
				"activation_failed",
				error instanceof Error ? error.message : String(error),
			);
		}
	}
}

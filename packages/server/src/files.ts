import { lstat, open, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export type V2FileReferenceKind = "file" | "directory";

export interface V2FileReference {
	readonly reference: string;
	readonly path: string;
	readonly kind: V2FileReferenceKind;
	readonly size?: number;
	readonly mimeType?: string;
}

export interface V2FileCompletion {
	readonly reference: string;
	readonly display: string;
	readonly hostScope: "server";
	readonly path: string;
	readonly canonicalPath: string;
	readonly kind: V2FileReferenceKind;
	readonly size?: number;
	readonly mimeType?: string;
}

export interface V2FileReferenceService {
	complete(
		sessionId: string,
		prefix: string,
		options?: { readonly signal?: AbortSignal },
	): Promise<readonly V2FileCompletion[]>;
	resolve(sessionId: string, reference: string): Promise<V2FileReference>;
	read(sessionId: string, reference: string): Promise<{ readonly file: V2FileReference; readonly data: Uint8Array }>;
}

export interface V2FileReferenceOptions {
	readonly projectRoot: string;
	readonly cwd?: string;
	readonly homeDirectory?: string;
	readonly allowAbsolute?: boolean;
	readonly maxReadBytes?: number;
	readonly maxCompletions?: number;
	readonly maxCompletionMs?: number;
}

type FileScope = "project" | "relative" | "server" | "local" | "home" | "absolute";

const DEFAULT_MAX_READ_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_COMPLETIONS = 256;
const DEFAULT_MAX_COMPLETION_MS = 250;

function cleanReference(reference: string): string {
	const value = reference.trim();
	return value.startsWith("@") ? value.slice(1) : value;
}

function scopeOf(reference: string): FileScope {
	return reference.startsWith("~/") || reference === "~"
		? "home"
		: isAbsolute(reference)
			? "absolute"
			: reference.startsWith("server:")
				? "server"
				: reference.startsWith("local:")
					? "local"
					: reference.startsWith("project:")
						? "project"
						: "relative";
}

function projectReference(reference: string): string {
	return reference.startsWith("project:") ? reference.slice("project:".length) : reference;
}

function serverReference(reference: string): string {
	return reference.startsWith("server:") ? reference.slice("server:".length) : reference;
}

function isWithin(root: string, candidate: string): boolean {
	const path = relative(root, candidate);
	return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function referenceFor(scope: FileScope, root: string, path: string, absoluteServerPath = false): string {
	return scope === "project"
		? `project:${relative(root, path) || "."}`
		: scope === "server"
			? `server:${absoluteServerPath ? path : relative(root, path) || "."}`
			: scope === "home"
				? `~/${relative(root, path)}`
				: path;
}

function mimeTypeFor(path: string): string | undefined {
	const extension = path.split(".").at(-1)?.toLowerCase();
	return extension === "ts"
		? "text/typescript"
		: extension === "js"
			? "text/javascript"
			: extension === "json"
				? "application/json"
				: extension === "md"
					? "text/markdown"
					: extension === "png"
						? "image/png"
						: extension === "jpg" || extension === "jpeg"
							? "image/jpeg"
							: extension === "webp"
								? "image/webp"
								: extension === "gif"
									? "image/gif"
									: undefined;
}

export class LocalV2FileReferenceService implements V2FileReferenceService {
	private readonly projectRoot: string;
	private readonly cwd: string;
	private readonly homeDirectory: string;
	private readonly allowAbsolute: boolean;
	private readonly maxReadBytes: number;
	private readonly maxCompletions: number;
	private readonly maxCompletionMs: number;

	constructor(options: V2FileReferenceOptions) {
		this.projectRoot = resolve(options.projectRoot);
		this.cwd = resolve(options.cwd ?? options.projectRoot);
		this.homeDirectory = resolve(options.homeDirectory ?? homedir());
		this.allowAbsolute = options.allowAbsolute ?? true;
		this.maxReadBytes = options.maxReadBytes ?? DEFAULT_MAX_READ_BYTES;
		this.maxCompletions = options.maxCompletions ?? DEFAULT_MAX_COMPLETIONS;
		this.maxCompletionMs = options.maxCompletionMs ?? DEFAULT_MAX_COMPLETION_MS;
		if (!Number.isSafeInteger(this.maxReadBytes) || this.maxReadBytes < 0)
			throw new TypeError("maxReadBytes must be a non-negative safe integer");
		if (!Number.isSafeInteger(this.maxCompletions) || this.maxCompletions <= 0)
			throw new TypeError("maxCompletions must be a positive safe integer");
		if (!Number.isSafeInteger(this.maxCompletionMs) || this.maxCompletionMs <= 0)
			throw new TypeError("maxCompletionMs must be a positive safe integer");
	}

	async complete(
		sessionId: string,
		prefix: string,
		options: { readonly signal?: AbortSignal } = {},
	): Promise<readonly V2FileCompletion[]> {
		void sessionId;
		const timeout = new AbortController();
		const timeoutId = setTimeout(() => timeout.abort(), this.maxCompletionMs);
		const onAbort = () => timeout.abort();
		if (options.signal?.aborted) timeout.abort();
		options.signal?.addEventListener("abort", onAbort, { once: true });
		try {
			return await this.completeWithSignal(prefix, timeout.signal);
		} finally {
			clearTimeout(timeoutId);
			options.signal?.removeEventListener("abort", onAbort);
		}
	}

	private async completeWithSignal(prefix: string, signal: AbortSignal): Promise<readonly V2FileCompletion[]> {
		if (signal.aborted) throw new Error("filesystem completion cancelled");
		const clean = cleanReference(prefix);
		const scope = scopeOf(clean);
		if (scope === "local") throw new Error("Client-local file references must be uploaded as blobs");
		const logical =
			scope === "project"
				? projectReference(clean)
				: scope === "server"
					? serverReference(clean)
					: scope === "home"
						? clean.slice(2)
						: clean;
		const base = scope === "project" ? this.projectRoot : scope === "home" ? this.homeDirectory : this.cwd;
		const candidate = isAbsolute(logical) ? logical : resolve(base, logical);
		const absoluteServerPath = scope === "server" && isAbsolute(logical);
		const directory = await this.directoryForCompletion(candidate);
		if (signal.aborted) throw new Error("filesystem completion cancelled");
		const prefixName = candidate === directory ? "" : candidate.slice(directory.length + 1);
		const entries = await readdir(directory, { withFileTypes: true });
		const completions = await Promise.all(
			entries
				.filter((entry) => entry.name.startsWith(prefixName))
				.map(async (entry): Promise<V2FileCompletion | undefined> => {
					if (signal.aborted) throw new Error("filesystem completion cancelled");
					const path = resolve(directory, entry.name);
					if (!this.allowedLexically(path, scope === "absolute" || absoluteServerPath)) return undefined;
					try {
						const resolved = await realpath(path);
						if (!(await this.allowed(resolved, scope === "absolute" || absoluteServerPath))) return undefined;
						const reference = referenceFor(scope, base, path, absoluteServerPath);
						return {
							reference,
							display: reference,
							hostScope: "server",
							path,
							canonicalPath: resolved,
							kind: entry.isDirectory() ? "directory" : "file",
							...(entry.isDirectory() ? {} : { size: (await lstat(path)).size, mimeType: mimeTypeFor(path) }),
						} satisfies V2FileCompletion;
					} catch {
						return undefined;
					}
				}),
		);
		if (signal.aborted) throw new Error("filesystem completion cancelled");
		return completions
			.filter((entry): entry is V2FileCompletion => entry !== undefined)
			.sort(
				(left, right) =>
					Number(right.kind === "directory") - Number(left.kind === "directory") ||
					left.reference.localeCompare(right.reference),
			)
			.slice(0, this.maxCompletions);
	}

	async resolve(sessionId: string, reference: string): Promise<V2FileReference> {
		void sessionId;
		const clean = cleanReference(reference);
		const path = await this.authorize(clean);
		const stats = await lstat(path);
		return {
			reference: clean,
			path,
			kind: stats.isDirectory() ? "directory" : "file",
			...(stats.isFile() ? { size: stats.size, mimeType: mimeTypeFor(path) } : {}),
		};
	}

	async read(
		sessionId: string,
		reference: string,
	): Promise<{ readonly file: V2FileReference; readonly data: Uint8Array }> {
		const file = await this.resolve(sessionId, reference);
		if (file.kind !== "file") throw new Error("File reference must resolve to a file");
		const handle = await open(file.path, "r");
		try {
			const buffer = Buffer.alloc(this.maxReadBytes + 1);
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
			if (bytesRead > this.maxReadBytes) throw new Error(`File exceeds maximum size of ${this.maxReadBytes} bytes`);
			const data = new Uint8Array(buffer.subarray(0, bytesRead));
			return { file: { ...file, size: bytesRead }, data };
		} finally {
			await handle.close();
		}
	}

	private async authorize(reference: string): Promise<string> {
		const scope = scopeOf(reference);
		if (scope === "local") throw new Error("Client-local file references must be uploaded as blobs");
		const logical =
			scope === "project"
				? projectReference(reference)
				: scope === "server"
					? serverReference(reference)
					: scope === "home"
						? reference.slice(2)
						: reference;
		const base = scope === "project" ? this.projectRoot : scope === "home" ? this.homeDirectory : this.cwd;
		const absoluteServerPath = scope === "server" && isAbsolute(logical);
		if ((scope === "absolute" || absoluteServerPath) && !this.allowAbsolute)
			throw new Error("Absolute file references are disabled");
		const candidate = scope === "absolute" ? resolve(reference) : resolve(base, logical);
		if (!this.allowedLexically(candidate, scope === "absolute" || absoluteServerPath))
			throw new Error(`File reference escapes the accessible filesystem: ${reference}`);
		const resolved = await realpath(candidate);
		if (!(await this.allowed(resolved, scope === "absolute" || absoluteServerPath)))
			throw new Error(`File reference escapes the accessible filesystem: ${reference}`);
		return resolved;
	}

	private allowedLexically(path: string, absoluteScope = false): boolean {
		if (absoluteScope && this.allowAbsolute) return true;
		return (
			isWithin(this.projectRoot, path) ||
			isWithin(this.cwd, path) ||
			(this.allowAbsolute && isWithin(this.homeDirectory, path))
		);
	}

	private async allowed(path: string, absoluteScope = false): Promise<boolean> {
		if (absoluteScope && this.allowAbsolute) return true;
		const roots = await Promise.all([realpath(this.projectRoot), realpath(this.cwd), realpath(this.homeDirectory)]);
		return roots.some((root) => isWithin(root, path));
	}

	private async directoryForCompletion(candidate: string): Promise<string> {
		try {
			const stats = await lstat(candidate);
			return stats.isDirectory() ? candidate : dirname(candidate);
		} catch {
			return dirname(candidate);
		}
	}
}

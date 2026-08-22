import { lstat, open, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { MAX_V2_ARRAY_ITEMS } from "@earendil-works/pi-protocol";

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
	readonly path: string;
	readonly kind: V2FileReferenceKind;
}

export interface V2FileReferenceService {
	complete(sessionId: string, prefix: string): Promise<readonly V2FileCompletion[]>;
	resolve(sessionId: string, reference: string): Promise<V2FileReference>;
	read(sessionId: string, reference: string): Promise<{ readonly file: V2FileReference; readonly data: Uint8Array }>;
}

export interface V2FileReferenceOptions {
	readonly projectRoot: string;
	readonly cwd?: string;
	readonly homeDirectory?: string;
	readonly allowAbsolute?: boolean;
	readonly maxReadBytes?: number;
}

type FileScope = "project" | "relative" | "home" | "absolute";

// Leave room for the base64 payload and response envelope within the default 4 MiB frame.
const DEFAULT_MAX_READ_BYTES = 2 * 1024 * 1024;

function cleanReference(reference: string): string {
	const value = reference.trim();
	return value.startsWith("@") ? value.slice(1) : value;
}

function scopeOf(reference: string): FileScope {
	return reference.startsWith("~/") || reference === "~"
		? "home"
		: isAbsolute(reference)
			? "absolute"
			: reference.startsWith("project:")
				? "project"
				: "relative";
}

function projectReference(reference: string): string {
	return reference.startsWith("project:") ? reference.slice("project:".length) : reference;
}

function isWithin(root: string, candidate: string): boolean {
	const path = relative(root, candidate);
	return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function referenceFor(scope: FileScope, root: string, path: string): string {
	return scope === "project"
		? `project:${relative(root, path) || "."}`
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
					: undefined;
}

export class LocalV2FileReferenceService implements V2FileReferenceService {
	private readonly projectRoot: string;
	private readonly cwd: string;
	private readonly homeDirectory: string;
	private readonly allowAbsolute: boolean;
	private readonly maxReadBytes: number;

	constructor(options: V2FileReferenceOptions) {
		this.projectRoot = resolve(options.projectRoot);
		this.cwd = resolve(options.cwd ?? options.projectRoot);
		this.homeDirectory = resolve(options.homeDirectory ?? homedir());
		this.allowAbsolute = options.allowAbsolute ?? true;
		const maxReadBytes = options.maxReadBytes ?? DEFAULT_MAX_READ_BYTES;
		if (!Number.isSafeInteger(maxReadBytes) || maxReadBytes < 1)
			throw new Error("maxReadBytes must be a positive safe integer");
		this.maxReadBytes = maxReadBytes;
	}

	async complete(sessionId: string, prefix: string): Promise<readonly V2FileCompletion[]> {
		void sessionId;
		const clean = cleanReference(prefix);
		const scope = scopeOf(clean);
		const logical = scope === "project" ? projectReference(clean) : scope === "home" ? clean.slice(2) : clean;
		const base = scope === "project" ? this.projectRoot : scope === "home" ? this.homeDirectory : this.cwd;
		const candidate = isAbsolute(logical) ? logical : resolve(base, logical);
		const directory = await this.directoryForCompletion(candidate);
		const prefixName = candidate === directory ? "" : candidate.slice(directory.length + 1);
		const resolvedDirectory = await realpath(directory);
		if (!(await this.allowed(resolvedDirectory))) return [];
		const entries = await readdir(directory, { withFileTypes: true });
		const completions = await Promise.all(
			entries
				.filter((entry) => entry.name.startsWith(prefixName))
				.slice(0, MAX_V2_ARRAY_ITEMS)
				.map(async (entry): Promise<V2FileCompletion | undefined> => {
					const path = resolve(directory, entry.name);
					if (!this.allowedLexically(path)) return undefined;
					try {
						const resolved = await realpath(path);
						if (!(await this.allowed(resolved))) return undefined;
						const stats = await lstat(resolved);
						return {
							reference: referenceFor(scope, base, path),
							path,
							kind: stats.isDirectory() ? "directory" : "file",
						} satisfies V2FileCompletion;
					} catch {
						return undefined;
					}
				}),
		);
		return completions.filter((entry): entry is V2FileCompletion => entry !== undefined).slice(0, MAX_V2_ARRAY_ITEMS);
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
			const currentPath = await realpath(file.path);
			if (currentPath !== file.path || !(await this.allowed(currentPath)))
				throw new Error("File reference changed outside the accessible filesystem");
			const stats = await handle.stat();
			if (!stats.isFile()) throw new Error("File reference must resolve to a regular file");
			if (stats.size > this.maxReadBytes)
				throw new Error(`File exceeds maximum size of ${this.maxReadBytes} bytes`);
			const chunks: Buffer[] = [];
			let total = 0;
			while (total < this.maxReadBytes) {
				const buffer = Buffer.alloc(Math.min(64 * 1024, this.maxReadBytes - total));
				const result = await handle.read(buffer, 0, buffer.length, total);
				if (result.bytesRead === 0) break;
				chunks.push(buffer.subarray(0, result.bytesRead));
				total += result.bytesRead;
			}
			const extra = Buffer.alloc(1);
			const result = await handle.read(extra, 0, 1, total);
			if (result.bytesRead > 0) throw new Error(`File exceeds maximum size of ${this.maxReadBytes} bytes`);
			return {
				file: { ...file, size: total },
				data: new Uint8Array(Buffer.concat(chunks, total)),
			};
		} finally {
			await handle.close();
		}
	}

	private async authorize(reference: string): Promise<string> {
		const scope = scopeOf(reference);
		const logical =
			scope === "project" ? projectReference(reference) : scope === "home" ? reference.slice(2) : reference;
		const base = scope === "project" ? this.projectRoot : scope === "home" ? this.homeDirectory : this.cwd;
		if (scope === "absolute" && !this.allowAbsolute) throw new Error("Absolute file references are disabled");
		const candidate = scope === "absolute" ? resolve(reference) : resolve(base, logical);
		if (!this.allowedLexically(candidate))
			throw new Error(`File reference escapes the accessible filesystem: ${reference}`);
		const resolved = await realpath(candidate);
		if (!(await this.allowed(resolved)))
			throw new Error(`File reference escapes the accessible filesystem: ${reference}`);
		return resolved;
	}

	private allowedLexically(path: string): boolean {
		return (
			isWithin(this.projectRoot, path) ||
			isWithin(this.cwd, path) ||
			(this.allowAbsolute && isWithin(this.homeDirectory, path))
		);
	}

	private async allowed(path: string): Promise<boolean> {
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

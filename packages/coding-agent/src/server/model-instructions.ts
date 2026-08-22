import { createHash } from "node:crypto";
import { open, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

export interface ModelInstructionProfile {
	readonly id: string;
	readonly provider: string;
	readonly model: string;
	readonly mode: "append" | "replaceDefault";
	readonly text?: string;
	readonly file?: string;
	readonly applyTo?: readonly ("root" | "subagent")[];
}

export interface ResolvedModelInstructionProfile {
	readonly id: string;
	readonly source: "text" | "file";
	readonly mode: ModelInstructionProfile["mode"];
	readonly text: string;
	readonly contentHash: string;
	readonly byteLength: number;
}

export interface ModelInstructionResolverOptions {
	readonly cwd: string;
	readonly trustedRoots?: readonly string[];
	readonly maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 64 * 1024;
const MAX_MAX_BYTES = 16 * 1024 * 1024;

function validateMaxBytes(value: number | undefined): number {
	const maxBytes = value ?? DEFAULT_MAX_BYTES;
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_MAX_BYTES)
		throw new Error(`maxBytes must be a positive safe integer no larger than ${MAX_MAX_BYTES}`);
	return maxBytes;
}

export class ModelInstructionResolver {
	private readonly profiles: readonly ModelInstructionProfile[];
	private readonly cwd: string;
	private readonly trustedRoots: readonly string[];
	private readonly maxBytes: number;

	public constructor(profiles: readonly ModelInstructionProfile[], options: ModelInstructionResolverOptions) {
		this.profiles = profiles;
		this.cwd = resolve(options.cwd);
		this.trustedRoots = (options.trustedRoots ?? [this.cwd]).map((root) => resolve(root));
		this.maxBytes = validateMaxBytes(options.maxBytes);
		for (const profile of profiles) {
			const hasText = profile.text !== undefined;
			const hasFile = profile.file !== undefined;
			if (hasText === hasFile) throw new Error(`Model profile ${profile.id} requires exactly one of text or file`);
		}
	}

	public async resolve(
		model: { readonly provider: string; readonly id: string },
		scope: "root" | "subagent" = "root",
	): Promise<ResolvedModelInstructionProfile | undefined> {
		const matches = this.profiles.filter(
			(profile) =>
				profile.provider === model.provider &&
				profile.model === model.id &&
				(profile.applyTo === undefined || profile.applyTo.includes(scope)),
		);
		if (matches.length > 1)
			throw new Error(`Multiple model instruction profiles match ${model.provider}/${model.id}`);
		const profile = matches[0];
		if (!profile) return undefined;
		const source = profile.text !== undefined ? "text" : "file";
		const text = profile.text ?? (await this.readProfileFile(profile.file!));
		const bytes = Buffer.byteLength(text, "utf8");
		if (bytes > this.maxBytes) throw new Error(`Model profile ${profile.id} exceeds ${this.maxBytes}-byte limit`);
		return {
			id: profile.id,
			source,
			mode: profile.mode,
			text,
			contentHash: createHash("sha256").update(text).digest("hex"),
			byteLength: bytes,
		};
	}

	private async readProfileFile(file: string): Promise<string> {
		const requestedPath = resolve(this.cwd, file);
		if (isAbsolute(file) && !this.isTrusted(requestedPath))
			throw new Error(`Model profile file is outside trusted roots: ${file}`);
		if (!this.isTrusted(requestedPath)) throw new Error(`Model profile file escapes trusted roots: ${file}`);
		const path = await realpath(requestedPath);
		if (!this.isTrusted(path)) throw new Error(`Model profile file resolves outside trusted roots: ${file}`);
		const metadata = await stat(path);
		if (metadata.size > this.maxBytes) throw new Error(`Model profile file exceeds ${this.maxBytes}-byte limit`);
		const handle = await open(path, "r");
		try {
			const buffer = Buffer.allocUnsafe(this.maxBytes + 1);
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
			if (bytesRead > this.maxBytes) throw new Error(`Model profile file exceeds ${this.maxBytes}-byte limit`);
			return buffer.subarray(0, bytesRead).toString("utf8");
		} finally {
			await handle.close();
		}
	}

	private isTrusted(path: string): boolean {
		return this.trustedRoots.some((root) => {
			const pathFromRoot = relative(root, path);
			return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot));
		});
	}
}

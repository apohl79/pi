import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
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

export class ModelInstructionResolver {
	private readonly profiles: readonly ModelInstructionProfile[];
	private readonly cwd: string;
	private readonly trustedRoots: readonly string[];
	private readonly maxBytes: number;

	public constructor(profiles: readonly ModelInstructionProfile[], options: ModelInstructionResolverOptions) {
		this.profiles = profiles;
		this.cwd = resolve(options.cwd);
		this.trustedRoots = (options.trustedRoots ?? [this.cwd]).map((root) => resolve(root));
		this.maxBytes = options.maxBytes ?? 64 * 1024;
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
		const text = profile.text ?? (await this.readProfileFile(profile.id, profile.file!));
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

	private async readProfileFile(profileId: string, file: string): Promise<string> {
		const requestedPath = resolve(this.cwd, file);
		if (isAbsolute(file) && !this.isTrusted(requestedPath))
			throw new Error(`Model profile ${profileId} file is outside trusted roots: ${file}`);
		if (!this.isTrusted(requestedPath))
			throw new Error(`Model profile ${profileId} file escapes trusted roots: ${file}`);
		let path: string;
		try {
			path = await realpath(requestedPath);
		} catch (error) {
			throw new Error(
				`Model profile ${profileId} file cannot be read: ${file} (${error instanceof Error ? error.message : String(error)})`,
			);
		}
		if (!this.isTrusted(path))
			throw new Error(`Model profile ${profileId} file resolves outside trusted roots: ${file}`);
		try {
			return await readFile(path, "utf8");
		} catch (error) {
			throw new Error(
				`Model profile ${profileId} file cannot be read: ${file} (${error instanceof Error ? error.message : String(error)})`,
			);
		}
	}

	private isTrusted(path: string): boolean {
		return this.trustedRoots.some((root) => {
			const pathFromRoot = relative(root, path);
			return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot));
		});
	}
}

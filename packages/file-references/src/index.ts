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

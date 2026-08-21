import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface V2BlobStat {
	readonly digest: string;
	readonly mimeType: string;
	readonly size: number;
}

export interface V2BlobIntegrityReport {
	readonly ok: boolean;
	readonly blobs: number;
	readonly bytes: number;
	readonly errors: readonly string[];
}

export interface V2BlobStore {
	put(data: Uint8Array, mimeType: string): Promise<V2BlobStat>;
	read(digest: string): Promise<Uint8Array>;
	stat(digest: string): Promise<V2BlobStat>;
}

function digestOf(data: Uint8Array): string {
	return createHash("sha256").update(data).digest("hex");
}

function assertMimeType(mimeType: string): void {
	if (mimeType.trim().length === 0 || mimeType.includes("\n")) throw new Error("Blob MIME type is invalid");
}

export class InMemoryV2BlobStore implements V2BlobStore {
	private readonly maxBytes: number;
	private readonly blobs = new Map<string, { readonly data: Uint8Array; readonly mimeType: string }>();

	constructor(options: { maxBytes?: number } = {}) {
		this.maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
	}

	async put(data: Uint8Array, mimeType: string): Promise<V2BlobStat> {
		assertMimeType(mimeType);
		if (data.byteLength > this.maxBytes) throw new Error(`Blob exceeds maximum size of ${this.maxBytes} bytes`);
		const digest = digestOf(data);
		if (!this.blobs.has(digest)) this.blobs.set(digest, { data: data.slice(), mimeType });
		return this.stat(digest);
	}

	async read(digest: string): Promise<Uint8Array> {
		const blob = this.blobs.get(digest);
		if (!blob) throw new Error(`Unknown blob ${digest}`);
		return blob.data.slice();
	}

	async stat(digest: string): Promise<V2BlobStat> {
		const blob = this.blobs.get(digest);
		if (!blob) throw new Error(`Unknown blob ${digest}`);
		return { digest, mimeType: blob.mimeType, size: blob.data.byteLength };
	}
}

export class FileV2BlobStore implements V2BlobStore {
	private readonly root: string;
	private readonly maxBytes: number;

	constructor(root: string, options: { maxBytes?: number } = {}) {
		this.root = root;
		this.maxBytes = options.maxBytes ?? 256 * 1024 * 1024;
	}

	async put(data: Uint8Array, mimeType: string): Promise<V2BlobStat> {
		assertMimeType(mimeType);
		if (data.byteLength > this.maxBytes) throw new Error(`Blob exceeds maximum size of ${this.maxBytes} bytes`);
		const digest = digestOf(data);
		await mkdir(this.root, { recursive: true });
		const dataPath = join(this.root, `${digest}.blob`);
		const metadataPath = join(this.root, `${digest}.json`);
		if (!(await this.exists(dataPath))) {
			const tempPath = join(this.root, `${digest}.${randomUUID()}.tmp`);
			await writeFile(tempPath, data);
			await rename(tempPath, dataPath);
		}
		if (!(await this.exists(metadataPath)))
			await writeFile(metadataPath, JSON.stringify({ digest, mimeType, size: data.byteLength }), {
				encoding: "utf8",
			});
		return this.stat(digest);
	}

	async read(digest: string): Promise<Uint8Array> {
		const data = await readFile(join(this.root, `${digest}.blob`));
		if (data.byteLength > this.maxBytes) throw new Error(`Blob exceeds maximum size of ${this.maxBytes} bytes`);
		return new Uint8Array(data);
	}

	async stat(digest: string): Promise<V2BlobStat> {
		const metadata = JSON.parse(await readFile(join(this.root, `${digest}.json`), "utf8")) as V2BlobStat;
		if (metadata.digest !== digest) throw new Error(`Blob metadata digest mismatch for ${digest}`);
		return metadata;
	}

	/** Verifies bounded on-disk blob metadata and content-addressed bytes without repairing them. */
	async verify(maxEntries = 1024): Promise<V2BlobIntegrityReport> {
		let entries: string[];
		try {
			entries = (await readdir(this.root)).filter((entry) => entry.endsWith(".json"));
		} catch (error) {
			const missing = error instanceof Error && "code" in error && error.code === "ENOENT";
			return missing
				? { ok: true, blobs: 0, bytes: 0, errors: [] }
				: { ok: false, blobs: 0, bytes: 0, errors: [error instanceof Error ? error.name : "unknown"] };
		}
		const errors: string[] = [];
		if (entries.length > maxEntries) errors.push(`entry_limit:${entries.length}`);
		let bytes = 0;
		for (const metadataFile of entries.slice(0, maxEntries)) {
			const digest = metadataFile.slice(0, -5);
			try {
				const metadata = await this.stat(digest);
				const data = await this.read(digest);
				if (metadata.size !== data.byteLength || digestOf(data) !== digest)
					errors.push(`content_mismatch:${digest}`);
				bytes += data.byteLength;
			} catch (error) {
				errors.push(`${digest}:${error instanceof Error ? error.name : "unknown"}`);
			}
		}
		return { ok: errors.length === 0, blobs: entries.length, bytes, errors };
	}

	private async exists(path: string): Promise<boolean> {
		try {
			await access(path);
			return true;
		} catch {
			return false;
		}
	}
}

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
	list(): Promise<readonly V2BlobStat[]>;
}

function digestOf(data: Uint8Array): string {
	return createHash("sha256").update(data).digest("hex");
}

function assertDigest(digest: string): void {
	if (!/^[a-f0-9]{64}$/u.test(digest)) throw new Error(`Blob digest is invalid: ${digest}`);
}

function assertMimeType(mimeType: string): void {
	if (!/^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/u.test(mimeType))
		throw new Error("Blob MIME type is invalid");
}

export class InMemoryV2BlobStore implements V2BlobStore {
	private readonly maxBytes: number;
	private readonly maxTotalBytes: number;
	private readonly maxBlobs: number;
	private readonly blobs = new Map<string, { readonly data: Uint8Array; readonly mimeType: string }>();

	constructor(options: { maxBytes?: number; maxTotalBytes?: number; maxBlobs?: number } = {}) {
		this.maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
		this.maxTotalBytes = options.maxTotalBytes ?? 256 * 1024 * 1024;
		this.maxBlobs = options.maxBlobs ?? 1024;
	}

	async put(data: Uint8Array, mimeType: string): Promise<V2BlobStat> {
		assertMimeType(mimeType);
		if (data.byteLength > this.maxBytes) throw new Error(`Blob exceeds maximum size of ${this.maxBytes} bytes`);
		const digest = digestOf(data);
		if (!this.blobs.has(digest)) {
			if (this.blobs.size >= this.maxBlobs) throw new Error(`Blob count exceeds maximum of ${this.maxBlobs}`);
			const totalBytes = [...this.blobs.values()].reduce((total, blob) => total + blob.data.byteLength, 0);
			if (totalBytes + data.byteLength > this.maxTotalBytes)
				throw new Error(`Blob storage exceeds maximum of ${this.maxTotalBytes} bytes`);
			this.blobs.set(digest, { data: data.slice(), mimeType });
		}
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

	async list(): Promise<readonly V2BlobStat[]> {
		return [...this.blobs.keys()].sort().map((digest) => {
			const blob = this.blobs.get(digest)!;
			return { digest, mimeType: blob.mimeType, size: blob.data.byteLength };
		});
	}
}

export class FileV2BlobStore implements V2BlobStore {
	private readonly root: string;
	private readonly maxBytes: number;
	private readonly maxTotalBytes: number;
	private readonly maxBlobs: number;
	private writeQueue = Promise.resolve();

	constructor(root: string, options: { maxBytes?: number; maxTotalBytes?: number; maxBlobs?: number } = {}) {
		this.root = root;
		this.maxBytes = options.maxBytes ?? 256 * 1024 * 1024;
		this.maxTotalBytes = options.maxTotalBytes ?? 512 * 1024 * 1024;
		this.maxBlobs = options.maxBlobs ?? 4096;
	}

	async put(data: Uint8Array, mimeType: string): Promise<V2BlobStat> {
		const result = this.writeQueue.then(async () => this.putSerialized(data, mimeType));
		this.writeQueue = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	private async putSerialized(data: Uint8Array, mimeType: string): Promise<V2BlobStat> {
		assertMimeType(mimeType);
		if (data.byteLength > this.maxBytes) throw new Error(`Blob exceeds maximum size of ${this.maxBytes} bytes`);
		const digest = digestOf(data);
		await mkdir(this.root, { recursive: true });
		const dataPath = join(this.root, `${digest}.blob`);
		const metadataPath = join(this.root, `${digest}.json`);
		if (!(await this.exists(metadataPath))) {
			const usage = await this.storageUsage();
			if (usage.blobs >= this.maxBlobs) throw new Error(`Blob count exceeds maximum of ${this.maxBlobs}`);
			if (usage.bytes + data.byteLength > this.maxTotalBytes)
				throw new Error(`Blob storage exceeds maximum of ${this.maxTotalBytes} bytes`);
		}
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

	private async storageUsage(): Promise<{ blobs: number; bytes: number }> {
		const entries = (await readdir(this.root)).filter((entry) => entry.endsWith(".json"));
		let bytes = 0;
		for (const entry of entries) {
			const metadata = JSON.parse(await readFile(join(this.root, entry), "utf8")) as V2BlobStat;
			if (typeof metadata.size !== "number" || metadata.size < 0) throw new Error("Blob metadata size is invalid");
			bytes += metadata.size;
		}
		return { blobs: entries.length, bytes };
	}

	async read(digest: string): Promise<Uint8Array> {
		assertDigest(digest);
		const data = await readFile(join(this.root, `${digest}.blob`));
		if (data.byteLength > this.maxBytes) throw new Error(`Blob exceeds maximum size of ${this.maxBytes} bytes`);
		const metadata = await this.stat(digest);
		if (digestOf(data) !== digest) throw new Error(`Blob content digest mismatch for ${digest}`);
		if (metadata.size !== data.byteLength) throw new Error(`Blob metadata size mismatch for ${digest}`);
		return new Uint8Array(data);
	}

	async stat(digest: string): Promise<V2BlobStat> {
		assertDigest(digest);
		const metadata = JSON.parse(await readFile(join(this.root, `${digest}.json`), "utf8")) as V2BlobStat;
		if (metadata.digest !== digest) throw new Error(`Blob metadata digest mismatch for ${digest}`);
		if (!Number.isSafeInteger(metadata.size) || metadata.size < 0)
			throw new Error(`Blob metadata size is invalid for ${digest}`);
		assertMimeType(metadata.mimeType);
		return metadata;
	}

	async list(): Promise<readonly V2BlobStat[]> {
		let entries: string[];
		try {
			entries = (await readdir(this.root)).filter((entry) => entry.endsWith(".json")).sort();
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
		return Promise.all(entries.map((entry) => this.stat(entry.slice(0, -5))));
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
				const message = error instanceof Error ? error.message : "";
				errors.push(
					message.includes("digest mismatch") || message.includes("size mismatch")
						? `content_mismatch:${digest}`
						: `${digest}:${error instanceof Error ? error.name : "unknown"}`,
				);
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

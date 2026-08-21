import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, stat as statFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface V2BlobStat {
	readonly digest: string;
	readonly mimeType: string;
	readonly size: number;
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
	if (mimeType.trim().length === 0 || /[\u0000-\u001f\u007f-\u009f]/u.test(mimeType))
		throw new Error("Blob MIME type is invalid");
}

function assertDigest(digest: string): void {
	if (!/^[a-f0-9]{64}$/u.test(digest)) throw new Error(`Invalid blob digest ${digest}`);
}

function assertLimit(value: number, name: string): void {
	if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
}

export class InMemoryV2BlobStore implements V2BlobStore {
	private readonly maxBytes: number;
	private readonly maxTotalBytes: number;
	private readonly maxBlobCount: number;
	private totalBytes = 0;
	private readonly blobs = new Map<string, { readonly data: Uint8Array; readonly mimeType: string }>();

	constructor(options: { maxBytes?: number; maxTotalBytes?: number; maxBlobCount?: number } = {}) {
		this.maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
		this.maxTotalBytes = options.maxTotalBytes ?? 64 * 1024 * 1024;
		this.maxBlobCount = options.maxBlobCount ?? 10_000;
		assertLimit(this.maxBytes, "maxBytes");
		assertLimit(this.maxTotalBytes, "maxTotalBytes");
		assertLimit(this.maxBlobCount, "maxBlobCount");
		if (this.maxTotalBytes < this.maxBytes) throw new Error("maxTotalBytes must be at least maxBytes");
	}

	async put(data: Uint8Array, mimeType: string): Promise<V2BlobStat> {
		assertMimeType(mimeType);
		if (data.byteLength > this.maxBytes) throw new Error(`Blob exceeds maximum size of ${this.maxBytes} bytes`);
		const digest = digestOf(data);
		if (!this.blobs.has(digest)) {
			if (this.blobs.size >= this.maxBlobCount) throw new Error("Blob count exceeds maximum");
			if (this.totalBytes + data.byteLength > this.maxTotalBytes)
				throw new Error(`Blob store exceeds maximum size of ${this.maxTotalBytes} bytes`);
			this.blobs.set(digest, { data: data.slice(), mimeType });
			this.totalBytes += data.byteLength;
		}
		return this.stat(digest);
	}

	async read(digest: string): Promise<Uint8Array> {
		assertDigest(digest);
		const blob = this.blobs.get(digest);
		if (!blob) throw new Error(`Unknown blob ${digest}`);
		return blob.data.slice();
	}

	async stat(digest: string): Promise<V2BlobStat> {
		assertDigest(digest);
		const blob = this.blobs.get(digest);
		if (!blob) throw new Error(`Unknown blob ${digest}`);
		return { digest, mimeType: blob.mimeType, size: blob.data.byteLength };
	}
}

export class FileV2BlobStore implements V2BlobStore {
	private readonly root: string;
	private readonly maxBytes: number;
	private writeLock: Promise<void> = Promise.resolve();

	constructor(root: string, options: { maxBytes?: number } = {}) {
		this.root = root;
		this.maxBytes = options.maxBytes ?? 256 * 1024 * 1024;
		assertLimit(this.maxBytes, "maxBytes");
	}

	async put(data: Uint8Array, mimeType: string): Promise<V2BlobStat> {
		assertMimeType(mimeType);
		if (data.byteLength > this.maxBytes) throw new Error(`Blob exceeds maximum size of ${this.maxBytes} bytes`);
		const digest = digestOf(data);
		await mkdir(this.root, { recursive: true });
		const dataPath = join(this.root, `${digest}.blob`);
		const metadataPath = join(this.root, `${digest}.json`);
		await this.withWriteLock(async () => {
			if (!(await this.exists(dataPath))) {
				const tempPath = join(this.root, `${digest}.${randomUUID()}.tmp`);
				await writeFile(tempPath, data);
				await rename(tempPath, dataPath);
			}
			if (!(await this.exists(metadataPath))) {
				const tempPath = join(this.root, `${digest}.${randomUUID()}.json.tmp`);
				await writeFile(tempPath, JSON.stringify({ digest, mimeType, size: data.byteLength }), {
					encoding: "utf8",
				});
				await rename(tempPath, metadataPath);
			}
		});
		return this.stat(digest);
	}

	async read(digest: string): Promise<Uint8Array> {
		assertDigest(digest);
		const metadata = await this.stat(digest);
		const data = await readFile(join(this.root, `${digest}.blob`));
		if (data.byteLength > this.maxBytes) throw new Error(`Blob exceeds maximum size of ${this.maxBytes} bytes`);
		if (data.byteLength !== metadata.size) throw new Error(`Blob metadata size mismatch for ${digest}`);
		if (digestOf(data) !== digest) throw new Error(`Blob digest mismatch for ${digest}`);
		return new Uint8Array(data);
	}

	async stat(digest: string): Promise<V2BlobStat> {
		assertDigest(digest);
		const metadata = JSON.parse(await readFile(join(this.root, `${digest}.json`), "utf8")) as V2BlobStat;
		if (
			metadata.digest !== digest ||
			!Number.isSafeInteger(metadata.size) ||
			metadata.size < 0 ||
			metadata.size > this.maxBytes ||
			typeof metadata.mimeType !== "string"
		)
			throw new Error(`Blob metadata is invalid for ${digest}`);
		assertMimeType(metadata.mimeType);
		const file = await statFile(join(this.root, `${digest}.blob`));
		if (file.size !== metadata.size) throw new Error(`Blob metadata size mismatch for ${digest}`);
		if (digestOf(await readFile(join(this.root, `${digest}.blob`))) !== digest)
			throw new Error(`Blob digest mismatch for ${digest}`);
		return metadata;
	}

	private async withWriteLock(action: () => Promise<void>): Promise<void> {
		const previous = this.writeLock;
		let release: () => void = () => undefined;
		this.writeLock = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			await action();
		} finally {
			release();
		}
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

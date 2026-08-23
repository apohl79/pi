import { createHash } from "node:crypto";
import type { V2BlobStore } from "./blobs.ts";
import type { V2FileReferenceService } from "./files.ts";

export type V2ImageGenerationRequest = Readonly<{
	prompt: string;
	sourceDigest?: string;
	sourceOperationId?: string;
}>;

export type V2GeneratedImage = Readonly<{
	digest: string;
	mimeType: string;
	size: number;
	provider: string;
	model: string;
	sourceOperationId?: string;
	dimensions?: Readonly<{ width: number; height: number }>;
	promptHash: string;
	costUsd?: number;
}>;

export interface V2ImageGenerationAdapter {
	generate(request: V2ImageGenerationRequest): Promise<
		Readonly<{
			data: Uint8Array;
			mimeType: string;
			provider: string;
			model: string;
			sourceOperationId?: string;
			dimensions?: Readonly<{ width: number; height: number }>;
			costUsd?: number;
		}>
	>;
}

export interface V2ImageService {
	view(
		sessionId: string,
		reference: string,
	): Promise<Readonly<{ digest: string; mimeType: string; size: number; reference: string }>>;
	generate(sessionId: string, request: V2ImageGenerationRequest): Promise<V2GeneratedImage>;
}

function promptHash(prompt: string): string {
	return createHash("sha256").update(prompt).digest("hex");
}

function assertImageMime(mimeType: string): void {
	if (!mimeType.startsWith("image/")) throw new Error(`Unsupported image MIME type: ${mimeType}`);
}

function assertImageDimensions(dimensions: Readonly<{ width: number; height: number }>): void {
	if (
		!Number.isSafeInteger(dimensions.width) ||
		!Number.isSafeInteger(dimensions.height) ||
		dimensions.width <= 0 ||
		dimensions.height <= 0
	)
		throw new Error("Generated image dimensions must be positive safe integers");
}

export class BlobV2ImageService implements V2ImageService {
	private readonly files: V2FileReferenceService;
	private readonly blobs: V2BlobStore;
	private readonly generator: V2ImageGenerationAdapter | undefined;

	constructor(files: V2FileReferenceService, blobs: V2BlobStore, generator?: V2ImageGenerationAdapter) {
		this.files = files;
		this.blobs = blobs;
		this.generator = generator;
	}

	async view(
		sessionId: string,
		reference: string,
	): Promise<Readonly<{ digest: string; mimeType: string; size: number; reference: string }>> {
		const result = await this.files.read(sessionId, reference);
		const mimeType = result.file.mimeType;
		if (!mimeType) throw new Error("Image MIME type could not be determined");
		assertImageMime(mimeType);
		const blob = await this.blobs.put(result.data, mimeType);
		return { digest: blob.digest, mimeType: blob.mimeType, size: blob.size, reference: result.file.reference };
	}

	async generate(sessionId: string, request: V2ImageGenerationRequest): Promise<V2GeneratedImage> {
		void sessionId;
		if (!this.generator) throw new Error("Image generation service is not configured");
		if (request.prompt.trim().length === 0) throw new Error("Image prompt must not be empty");
		if (request.sourceDigest !== undefined) {
			const source = await this.blobs.stat(request.sourceDigest);
			assertImageMime(source.mimeType);
		}
		const generated = await this.generator.generate(request);
		assertImageMime(generated.mimeType);
		if (generated.dimensions !== undefined) assertImageDimensions(generated.dimensions);
		if (generated.costUsd !== undefined && (!Number.isFinite(generated.costUsd) || generated.costUsd < 0))
			throw new Error("Generated image cost must be a non-negative finite number");
		const blob = await this.blobs.put(generated.data, generated.mimeType);
		return {
			digest: blob.digest,
			mimeType: blob.mimeType,
			size: blob.size,
			provider: generated.provider,
			model: generated.model,
			...(request.sourceOperationId === undefined ? {} : { sourceOperationId: request.sourceOperationId }),
			...(generated.dimensions ? { dimensions: generated.dimensions } : {}),
			promptHash: promptHash(request.prompt),
			...(generated.costUsd === undefined ? {} : { costUsd: generated.costUsd }),
		};
	}
}

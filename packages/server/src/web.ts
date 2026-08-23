import {
	assertSafeWebUrl,
	type V2WebAdapter,
	type V2WebRequest,
	type V2WebResult,
	type V2WebSafetyPolicy,
	type V2WebService,
} from "@earendil-works/pi-web-tools";

export type {
	V2WebAdapter,
	V2WebOperation,
	V2WebRequest,
	V2WebResult,
	V2WebSafetyPolicy,
	V2WebService,
} from "@earendil-works/pi-web-tools";
export { assertSafeWebUrl } from "@earendil-works/pi-web-tools";

const DEFAULT_MAX_RESULTS = 8;
const DEFAULT_MAX_EXTRACT_BYTES = 32 * 1024;

export class AdapterV2WebService implements V2WebService {
	private readonly adapter: V2WebAdapter;
	private readonly policy: V2WebSafetyPolicy;

	constructor(adapter: V2WebAdapter, policy: V2WebSafetyPolicy = {}) {
		this.adapter = adapter;
		this.policy = policy;
	}

	async execute(sessionId: string, request: V2WebRequest): Promise<readonly V2WebResult[]> {
		void sessionId;
		const maxResults = nonNegativeLimit(this.policy.maxResults ?? DEFAULT_MAX_RESULTS, "maxResults");
		const maxExtractBytes = nonNegativeLimit(
			this.policy.maxExtractBytes ?? DEFAULT_MAX_EXTRACT_BYTES,
			"maxExtractBytes",
		);
		const policy = {
			...this.policy,
			maxResults,
			maxExtractBytes,
		};
		if (request.url) assertSafeWebUrl(request.url, policy);
		const results = await this.adapter.execute(request, policy);
		return results.slice(0, policy.maxResults).map((result) => {
			assertWebResult(result);
			if (
				(request.operation === "screenshot" || request.operation === "image_query") &&
				(!result.blobDigest || !result.mimeType?.startsWith("image/"))
			)
				throw new Error("Web media results must reference an image blob");
			return {
				...result,
				url: assertSafeWebUrl(result.url, policy).toString(),
				...(result.extract ? { extract: truncateUtf8(result.extract, policy.maxExtractBytes) } : {}),
			};
		});
	}
}

function assertWebResult(result: V2WebResult): void {
	if (result.id.trim().length === 0) throw new Error("Web result id must not be empty");
	if (result.title.trim().length === 0) throw new Error("Web result title must not be empty");
	if (result.source.trim().length === 0) throw new Error("Web result source must not be empty");
	if (!Number.isSafeInteger(result.retrievedAt) || result.retrievedAt < 0)
		throw new Error("Web result retrievedAt must be a non-negative safe integer");
	if (result.extract !== undefined && typeof result.extract !== "string")
		throw new Error("Web result extract must be a string");
	if (result.mimeType !== undefined && result.mimeType.trim().length === 0)
		throw new Error("Web result mimeType must not be empty");
	if (result.blobDigest !== undefined && !/^[a-f0-9]{64}$/u.test(result.blobDigest))
		throw new Error("Web result blobDigest is invalid");
}

function truncateUtf8(value: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	const bytes = Buffer.from(value, "utf8");
	if (bytes.length <= maxBytes) return value;
	let end = maxBytes;
	while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
	return bytes.subarray(0, end).toString("utf8");
}

function nonNegativeLimit(value: number, name: string): number {
	if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative safe integer`);
	return value;
}

export class UnavailableV2WebService implements V2WebService {
	execute(_sessionId: string, _request: V2WebRequest): Promise<readonly V2WebResult[]> {
		return Promise.reject(new Error("Web service is not configured"));
	}
}

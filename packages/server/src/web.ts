import { isIP } from "node:net";

export type V2WebOperation =
	| "search_query"
	| "open"
	| "click"
	| "find"
	| "screenshot"
	| "image_query"
	| "finance"
	| "weather"
	| "sports"
	| "time";

export type V2WebRequest = Readonly<{
	operation: V2WebOperation;
	query?: string;
	url?: string;
	refId?: string;
	pattern?: string;
	ticker?: string;
	market?: string;
	location?: string;
	duration?: number;
	start?: string;
	dateFrom?: string;
	dateTo?: string;
	league?: string;
	team?: string;
	opponent?: string;
	numGames?: number;
	locale?: string;
	utcOffset?: string;
}>;

export type V2WebResult = Readonly<{
	id: string;
	url: string;
	title: string;
	source: string;
	retrievedAt: number;
	extract?: string;
	mimeType?: string;
	blobDigest?: string;
}>;

export type V2WebSafetyPolicy = Readonly<{
	allowPrivateNetwork?: boolean;
	maxResults?: number;
	maxExtractBytes?: number;
}>;

export interface V2WebAdapter {
	execute(request: V2WebRequest, policy: V2WebSafetyPolicy): Promise<readonly V2WebResult[]>;
}

export interface V2WebService {
	execute(sessionId: string, request: V2WebRequest): Promise<readonly V2WebResult[]>;
}

const DEFAULT_MAX_RESULTS = 8;
const DEFAULT_MAX_EXTRACT_BYTES = 32 * 1024;

function isPrivateIpv4(hostname: string): boolean {
	const parts = hostname.split(".").map(Number);
	if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
	return (
		parts[0] === 0 ||
		parts[0] === 10 ||
		parts[0] === 127 ||
		(parts[0] === 169 && parts[1] === 254) ||
		(parts[0] === 192 && parts[1] === 168) ||
		(parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
		(parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) ||
		(parts[0] === 198 && parts[1] >= 18 && parts[1] <= 19)
	);
}

function isPrivateHost(hostname: string): boolean {
	const host = hostname
		.toLowerCase()
		.replace(/^\[|\]$/g, "")
		.replace(/\.$/, "");
	const mappedMatch = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u.exec(host);
	const mappedIpv4 = host.startsWith("::ffff:")
		? mappedMatch === null
			? host.slice("::ffff:".length)
			: `${Number.parseInt(mappedMatch[1]!, 16) >> 8}.${Number.parseInt(mappedMatch[1]!, 16) & 255}.${Number.parseInt(mappedMatch[2]!, 16) >> 8}.${Number.parseInt(mappedMatch[2]!, 16) & 255}`
		: undefined;
	return (
		host === "localhost" ||
		host.endsWith(".localhost") ||
		host.endsWith(".internal") ||
		isPrivateIpv4(host) ||
		(mappedIpv4 !== undefined && isPrivateIpv4(mappedIpv4)) ||
		(isIP(host) === 6 &&
			(host === "::" ||
				host === "::1" ||
				host.startsWith("fc") ||
				host.startsWith("fd") ||
				/^(?:fe[89ab]):/u.test(host)))
	);
}

export function assertSafeWebUrl(rawUrl: string, policy: V2WebSafetyPolicy = {}): URL {
	const url = new URL(rawUrl);
	if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Web URL scheme must be http or https");
	if (url.username || url.password) throw new Error("Web URL credentials are not allowed");
	if (!policy.allowPrivateNetwork && isPrivateHost(url.hostname)) throw new Error("Web URL targets a private network");
	return url;
}

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

export interface SessionNameNormalizationOptions {
	readonly secretFallback?: boolean;
}

/** Normalize untrusted model output into a short, display-safe session title. */
export function normalizeGeneratedName(value: string, options?: SessionNameNormalizationOptions): string | undefined {
	const cleaned = value
		.replace(/[\u0000-\u001f\u007f]/g, " ")
		.replace(/^(?:(?:title|session\s+name)\s*[:-]\s*)+/i, "")
		.replace(/^here(?:'s| is)\s+(?:a|the)?\s*(?:title|session\s+name)\s*[:-]?\s*/i, "")
		.replace(/\s+/g, " ")
		.replace(/^['"`]+|['"`]+$/g, "")
		.trim();
	if (/^(?:answer|sure|okay|ok|here you go)\b[.!]?$/i.test(cleaned)) return undefined;
	if (/(?:sk|pk|api[_-]?key|bearer)\s*[:=]\s*\S+/i.test(cleaned))
		return options?.secretFallback === true ? "Untitled session" : undefined;
	const words = cleaned.split(" ").filter(Boolean).slice(0, 7);
	if (words.length < 2) return undefined;
	const joined = words.join(" ");
	let name = joined.slice(0, 32);
	if (joined.length > 32) name = name.replace(/\s+\S*$/, "").trimEnd();
	if (name.split(" ").length < 2) return undefined;
	return name;
}

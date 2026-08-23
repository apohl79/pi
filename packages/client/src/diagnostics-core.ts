/** Browser-safe client diagnostic bundle helpers. */
export interface ClientDiagnosticSpoolReader {
	readonly clientInstanceId: string;
	read(afterSeq?: number): Promise<readonly unknown[]>;
	latestSeq(): Promise<number>;
}

/** Merge client-local records into a server diagnostic bundle when identities match. */
export async function mergeClientDiagnosticBundle(
	bundle: unknown,
	spool: ClientDiagnosticSpoolReader | undefined,
): Promise<Record<string, unknown>> {
	if (typeof bundle !== "object" || bundle === null || Array.isArray(bundle))
		throw new Error("diagnostics/export response did not contain a bundle");
	if (spool === undefined) return bundle as Record<string, unknown>;
	const source = bundle as Record<string, unknown>;
	const clientDiagnostics =
		typeof source.clientDiagnostics === "object" && source.clientDiagnostics !== null
			? (source.clientDiagnostics as Record<string, unknown>)
			: {};
	const afterSeq = typeof clientDiagnostics.afterSeq === "number" ? clientDiagnostics.afterSeq : 0;
	let records: readonly unknown[] = [];
	let latestSeq = afterSeq;
	const remoteManifest =
		typeof clientDiagnostics.manifest === "object" && clientDiagnostics.manifest !== null
			? (clientDiagnostics.manifest as Record<string, unknown>)
			: undefined;
	const remoteClientInstanceId =
		typeof remoteManifest?.clientInstanceId === "string" ? remoteManifest.clientInstanceId : undefined;
	let unavailableFromSpool = remoteClientInstanceId !== spool.clientInstanceId;
	if (!unavailableFromSpool) {
		try {
			records = await spool.read(afterSeq);
			latestSeq = await spool.latestSeq();
		} catch {
			unavailableFromSpool = true;
		}
	}
	const manifest =
		typeof source.manifest === "object" && source.manifest !== null
			? (source.manifest as Record<string, unknown>)
			: {};
	const unavailable = Array.isArray(manifest.unavailable)
		? manifest.unavailable.filter((item): item is string => item !== "client-diagnostic-spool")
		: [];
	return {
		...source,
		manifest: {
			...manifest,
			...(unavailableFromSpool || unavailable.length > 0
				? { unavailable: [...unavailable, "client-diagnostic-spool"] }
				: {}),
		},
		...(unavailableFromSpool ? {} : { clientDiagnostics: { ...clientDiagnostics, afterSeq: latestSeq, records } }),
	};
}

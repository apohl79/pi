/**
 * Release builds replace this file temporarily before compiling standalone
 * artifacts. Source checkouts retain an identity-free fallback.
 */
export const BUILD_IDENTITY = {
	buildVersion: undefined,
	forkCommit: undefined,
	upstreamBaseCommit: undefined,
	configHash: undefined,
} as const;

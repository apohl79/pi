import type { DiagnosticRuntimeManifest } from "@earendil-works/pi-server";

/** Builds a daemon runtime identity from metadata injected by CI or a release archive. */
export function createRuntimeManifest(environment: NodeJS.ProcessEnv = process.env): DiagnosticRuntimeManifest {
	const manifest: DiagnosticRuntimeManifest = {
		schemaVersion: 1,
		runtime: `node ${process.version}`,
		platform: process.platform,
		arch: process.arch,
	};
	const buildVersion = nonEmpty(environment.PI_BUILD_VERSION);
	const forkCommit = nonEmpty(environment.PI_FORK_COMMIT);
	const upstreamBaseCommit = nonEmpty(environment.PI_UPSTREAM_BASE_COMMIT);
	const configHash = nonEmpty(environment.PI_CONFIG_HASH);
	return {
		...manifest,
		...(buildVersion === undefined ? {} : { buildVersion }),
		...(forkCommit === undefined ? {} : { forkCommit }),
		...(upstreamBaseCommit === undefined ? {} : { upstreamBaseCommit }),
		...(configHash === undefined ? {} : { configHash }),
	};
}

function nonEmpty(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

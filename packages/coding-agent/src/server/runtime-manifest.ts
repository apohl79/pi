import type { DiagnosticRuntimeManifest } from "@earendil-works/pi-server";
import { BUILD_IDENTITY } from "./build-identity.generated.ts";

export interface RuntimeBuildIdentity {
	readonly buildVersion?: string;
	readonly forkCommit?: string;
	readonly upstreamBaseCommit?: string;
	readonly configHash?: string;
}

/** Builds a daemon runtime identity from metadata injected by CI or a release archive. */
export function createRuntimeManifest(
	environment: NodeJS.ProcessEnv = process.env,
	compiledIdentity: RuntimeBuildIdentity = BUILD_IDENTITY,
): DiagnosticRuntimeManifest {
	const manifest: DiagnosticRuntimeManifest = {
		schemaVersion: 1,
		runtime: `node ${process.version}`,
		platform: process.platform,
		arch: process.arch,
	};
	const buildVersion = nonEmpty(environment.PI_BUILD_VERSION) ?? nonEmpty(compiledIdentity.buildVersion);
	const forkCommit = nonEmpty(environment.PI_FORK_COMMIT) ?? nonEmpty(compiledIdentity.forkCommit);
	const upstreamBaseCommit =
		nonEmpty(environment.PI_UPSTREAM_BASE_COMMIT) ?? nonEmpty(compiledIdentity.upstreamBaseCommit);
	const configHash = nonEmpty(environment.PI_CONFIG_HASH) ?? nonEmpty(compiledIdentity.configHash);
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

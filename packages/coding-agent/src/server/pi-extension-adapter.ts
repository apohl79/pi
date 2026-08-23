import type { AgentMessage, SamplingInputContext } from "@earendil-works/pi-agent-core";
import type { Extension } from "../core/extensions/types.ts";
import type { ServerRuntimeExtension } from "./extension-host.ts";

export type PiExtensionUnsupportedServerResource =
	| "tools"
	| "commands"
	| "shortcuts"
	| "flags"
	| "message-renderers"
	| "entry-renderers"
	| "markdown-transformer"
	| "lifecycle-handlers";

export interface PiExtensionServerCompatibilityReport {
	readonly extensionPath: string;
	readonly supported: readonly ["sampling-input"] | readonly [];
	readonly unsupported: readonly PiExtensionUnsupportedServerResource[];
}

/** Report which parts of a Pi extension can cross the daemon boundary safely. */
export function inspectPiExtensionServerCompatibility(extension: Extension): PiExtensionServerCompatibilityReport {
	const unsupported: PiExtensionUnsupportedServerResource[] = [];
	if (extension.tools.size > 0) unsupported.push("tools");
	if (extension.commands.size > 0) unsupported.push("commands");
	if (extension.shortcuts.size > 0) unsupported.push("shortcuts");
	if (extension.flags.size > 0) unsupported.push("flags");
	if (extension.messageRenderers.size > 0) unsupported.push("message-renderers");
	if (extension.entryRenderers !== undefined && extension.entryRenderers.size > 0) unsupported.push("entry-renderers");
	if (extension.markdownTransformer !== undefined) unsupported.push("markdown-transformer");
	if (extension.handlers.size > 0) unsupported.push("lifecycle-handlers");
	return {
		extensionPath: extension.path,
		supported: extension.samplingInputs !== undefined && extension.samplingInputs.size > 0 ? ["sampling-input"] : [],
		unsupported,
	};
}

/**
 * Adapt the request-only part of a Pi-native extension to the daemon host.
 * Each registration becomes a separate server extension so a rejected
 * contributor does not suppress later registrations. Process-local tools,
 * commands, shortcuts, and UI handlers are intentionally not projected into
 * the server runtime by this adapter.
 */
export function adaptPiExtensionSampling(extension: Extension): readonly ServerRuntimeExtension[] {
	const registrations = [...(extension.samplingInputs?.values() ?? [])];
	return registrations.map((registration) => ({
		id: `pi:${extension.path}:sampling:${registration.id}`,
		scope: "server",
		capabilities: ["sampling-input"],
		contributeSamplingInput: async (context: SamplingInputContext): Promise<AgentMessage[]> => {
			const result = await registration.contribute(context);
			if (result === undefined) return [];
			if (Array.isArray(result)) return [...result] as AgentMessage[];
			return [result as AgentMessage];
		},
	}));
}

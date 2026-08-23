import type { AgentMessage, SamplingInputContext } from "@earendil-works/pi-agent-core";
import type { Extension } from "../core/extensions/types.ts";
import type { ServerRuntimeExtension } from "./extension-host.ts";

/**
 * Adapt the request-only part of a Pi-native extension to the daemon host.
 * Process-local tools, commands, shortcuts, and UI handlers are intentionally
 * not projected into the server runtime by this adapter.
 */
export function adaptPiExtensionSampling(extension: Extension): ServerRuntimeExtension | undefined {
	const registrations = [...(extension.samplingInputs?.values() ?? [])];
	if (registrations.length === 0) return undefined;

	return {
		id: `pi:${extension.path}`,
		scope: "server",
		capabilities: ["sampling-input"],
		contributeSamplingInput: async (context: SamplingInputContext): Promise<AgentMessage[]> => {
			const messages: AgentMessage[] = [];
			for (const registration of registrations) {
				const result = await registration.contribute(context);
				if (result === undefined) continue;
				messages.push(...(Array.isArray(result) ? result : [result]));
			}
			return messages;
		},
	};
}

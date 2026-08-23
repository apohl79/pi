import type { AgentMessage, ExecutionEnv, SamplingInputContext } from "@earendil-works/pi-agent-core";
import type { V2PluginSamplingEntry } from "@earendil-works/pi-server";

const CONDITION_TIMEOUT_SECONDS = 5;
const MAX_TOTAL_ENTRIES = 128;
const MAX_TOTAL_CHARACTERS = 32_000;

export type PluginSamplingSource = Readonly<{
	pluginId: string;
	activationOrder: number;
	entries: readonly V2PluginSamplingEntry[];
}>;

export type PluginSamplingDiagnostic = Readonly<{
	pluginId: string;
	entryId: string;
	reason: "condition_failed" | "condition_error" | "bound_exceeded";
}>;

export type PluginSamplingDiagnosticSink = (diagnostic: PluginSamplingDiagnostic) => void;

export function createPluginSamplingInput(
	env: ExecutionEnv,
	sources: readonly PluginSamplingSource[],
	onDiagnostic?: PluginSamplingDiagnosticSink,
): (context: SamplingInputContext) => Promise<AgentMessage[]> {
	const orderedSources = [...sources].sort((left, right) => left.activationOrder - right.activationOrder);
	return async () => {
		const messages: AgentMessage[] = [];
		let characters = 0;
		for (const source of orderedSources) {
			for (const entry of source.entries) {
				if (entry.conditionShell !== undefined) {
					const condition = await env.exec(entry.conditionShell, { timeout: CONDITION_TIMEOUT_SECONDS });
					if (!condition.ok) {
						onDiagnostic?.({ pluginId: source.pluginId, entryId: entry.id, reason: "condition_error" });
						continue;
					}
					if (condition.value.exitCode !== 0) {
						onDiagnostic?.({ pluginId: source.pluginId, entryId: entry.id, reason: "condition_failed" });
						continue;
					}
				}
				const size = entry.text.length;
				if (messages.length >= MAX_TOTAL_ENTRIES || characters + size > MAX_TOTAL_CHARACTERS) {
					onDiagnostic?.({ pluginId: source.pluginId, entryId: entry.id, reason: "bound_exceeded" });
					continue;
				}
				messages.push({ role: "user", content: entry.text, timestamp: Date.now() });
				characters += size;
			}
		}
		return messages;
	};
}

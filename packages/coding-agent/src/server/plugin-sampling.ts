import { createHash } from "node:crypto";
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
	reason: "included" | "condition_failed" | "condition_error" | "bound_exceeded";
	durationMs?: number;
	characters?: number;
	contentHash?: string;
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
					const startedAt = Date.now();
					const condition = await env.exec(entry.conditionShell, { timeout: CONDITION_TIMEOUT_SECONDS });
					const durationMs = Math.max(0, Date.now() - startedAt);
					if (!condition.ok) {
						onDiagnostic?.({
							pluginId: source.pluginId,
							entryId: entry.id,
							reason: "condition_error",
							durationMs,
						});
						continue;
					}
					if (condition.value.exitCode !== 0) {
						onDiagnostic?.({
							pluginId: source.pluginId,
							entryId: entry.id,
							reason: "condition_failed",
							durationMs,
						});
						continue;
					}
				}
				const size = entry.text.length;
				if (messages.length >= MAX_TOTAL_ENTRIES || characters + size > MAX_TOTAL_CHARACTERS) {
					onDiagnostic?.({
						pluginId: source.pluginId,
						entryId: entry.id,
						reason: "bound_exceeded",
						characters: size,
					});
					continue;
				}
				messages.push({ role: "user", content: entry.text, timestamp: Date.now() });
				characters += size;
				onDiagnostic?.({
					pluginId: source.pluginId,
					entryId: entry.id,
					reason: "included",
					characters: size,
					contentHash: createHash("sha256").update(entry.text).digest("hex"),
				});
			}
		}
		return messages;
	};
}

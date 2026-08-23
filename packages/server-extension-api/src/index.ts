import type { AgentMessage, SamplingInputContext } from "@earendil-works/pi-agent-core";
import type { PiSessionRuntimeEventV2 } from "@earendil-works/pi-server";

export interface ServerRuntimeModel {
	readonly id: string;
	readonly provider?: string;
}

export interface ServerRuntimeOperation {
	readonly id: string;
	readonly type: string;
	readonly model?: ServerRuntimeModel;
}

export type ServerRuntimeExtensionScope = "server" | "client" | "both";

export interface ServerRuntimeExtensionState {
	get<T>(key: string): Promise<T | undefined>;
	set(key: string, value: unknown): Promise<void>;
}

export interface ServerRuntimeExtensionContext {
	readonly operation: ServerRuntimeOperation;
	readonly model: ServerRuntimeModel;
	readonly capabilities: readonly string[];
	readonly state: ServerRuntimeExtensionState;
}

export interface ServerRuntimeExtension {
	readonly id: string;
	readonly scope?: ServerRuntimeExtensionScope;
	readonly capabilities?: readonly string[];
	readonly events?: readonly PiSessionRuntimeEventV2["event"][];
	onOperationAccepted?(context: ServerRuntimeExtensionContext): void | Promise<void>;
	onOperationTerminal?(context: ServerRuntimeExtensionContext & { readonly outcome: string }): void | Promise<void>;
	contributeSamplingInput?(context: SamplingInputContext): AgentMessage[] | Promise<AgentMessage[]>;
	onRuntimeEvent?(event: PiSessionRuntimeEventV2): void | Promise<void>;
}

export interface ServerRuntimeExtensionHookResult {
	readonly extensionId: string;
	readonly status: "fulfilled" | "rejected";
	readonly reason?: unknown;
}

export interface ServerRuntimeExtensionSamplingResult {
	readonly messages: readonly AgentMessage[];
	readonly outcomes: readonly ServerRuntimeExtensionHookResult[];
}

export interface ServerRuntimeExtensionHostOptions {
	readonly resolveModel: () => ServerRuntimeModel;
	readonly loadState?: (extensionId: string, key: string) => unknown | Promise<unknown>;
	readonly persistState?: (extensionId: string, key: string, value: unknown) => void | Promise<void>;
	readonly maxSamplingMessages?: number;
	readonly maxSamplingCharacters?: number;
}

import type { AgentMessage, SamplingInputContext } from "@earendil-works/pi-agent-core";
import type { PiSessionRuntimeEventV2 } from "@earendil-works/pi-server";
import type {
	ServerRuntimeExtension,
	ServerRuntimeExtensionContext,
	ServerRuntimeExtensionHookResult,
	ServerRuntimeExtensionHostOptions,
	ServerRuntimeExtensionSamplingResult,
	ServerRuntimeOperation,
} from "@earendil-works/pi-server-extension-api";

export type {
	ServerRuntimeExtension,
	ServerRuntimeExtensionContext,
	ServerRuntimeExtensionHookResult,
	ServerRuntimeExtensionHostOptions,
	ServerRuntimeExtensionSamplingResult,
	ServerRuntimeExtensionScope,
	ServerRuntimeExtensionState,
	ServerRuntimeModel,
	ServerRuntimeOperation,
} from "@earendil-works/pi-server-extension-api";

const DEFAULT_MAX_SAMPLING_MESSAGES = 128;
const DEFAULT_MAX_SAMPLING_CHARACTERS = 32_000;

export class ServerRuntimeExtensionHost {
	private readonly extensions = new Map<string, ServerRuntimeExtension>();
	private readonly options: ServerRuntimeExtensionHostOptions;

	public constructor(options: ServerRuntimeExtensionHostOptions) {
		this.options = options;
	}

	public async register(extension: ServerRuntimeExtension): Promise<void> {
		if (this.extensions.has(extension.id)) throw new Error(`Extension ${extension.id} is already registered`);
		if (extension.scope === "client") throw new Error("client-only extensions cannot register with the server host");
		this.extensions.set(extension.id, extension);
	}

	public registerClientCommand(_name: string): never {
		throw new Error("server runtime extensions cannot register client commands");
	}

	public async onOperationAccepted(
		operation: ServerRuntimeOperation,
	): Promise<readonly ServerRuntimeExtensionHookResult[]> {
		return this.dispatchHook((extension) => extension.onOperationAccepted?.(this.context(extension.id, operation)));
	}

	public async onOperationTerminal(
		operation: ServerRuntimeOperation,
		outcome: string,
	): Promise<readonly ServerRuntimeExtensionHookResult[]> {
		return this.dispatchHook((extension) =>
			extension.onOperationTerminal?.({ ...this.context(extension.id, operation), outcome }),
		);
	}

	public async collectSamplingInput(context: SamplingInputContext): Promise<ServerRuntimeExtensionSamplingResult> {
		const messages: AgentMessage[] = [];
		let characters = 0;
		const outcomes: ServerRuntimeExtensionHookResult[] = [];
		for (const extension of this.extensions.values()) {
			try {
				const contributed = (await extension.contributeSamplingInput?.(context)) ?? [];
				for (const message of contributed) {
					const size = JSON.stringify(message).length;
					if (
						messages.length >= (this.options.maxSamplingMessages ?? DEFAULT_MAX_SAMPLING_MESSAGES) ||
						characters + size > (this.options.maxSamplingCharacters ?? DEFAULT_MAX_SAMPLING_CHARACTERS)
					)
						break;
					messages.push(message);
					characters += size;
				}
				outcomes.push({ extensionId: extension.id, status: "fulfilled" });
			} catch (reason) {
				outcomes.push({ extensionId: extension.id, status: "rejected", reason });
			}
		}
		return { messages, outcomes };
	}

	public async dispatchRuntimeEvent(
		event: PiSessionRuntimeEventV2,
	): Promise<readonly ServerRuntimeExtensionHookResult[]> {
		return this.dispatchHook((extension) => {
			if (extension.events !== undefined && !extension.events.includes(event.event)) return;
			return extension.onRuntimeEvent?.({ ...event, payload: { ...event.payload } });
		});
	}

	public async getState<T>(extensionId: string, key: string): Promise<T | undefined> {
		return (await this.options.loadState?.(extensionId, key)) as T | undefined;
	}

	private context(extensionId: string, operation: ServerRuntimeOperation): ServerRuntimeExtensionContext {
		return {
			operation: { ...operation },
			model: { ...(operation.model ?? this.options.resolveModel()) },
			capabilities: extensionCapabilities(this.extensions.get(extensionId)),
			state: {
				get: async <T>(key: string) => this.getState<T>(extensionId, key),
				set: async (key: string, value: unknown) => {
					await this.options.persistState?.(extensionId, key, value);
				},
			},
		};
	}

	private async dispatchHook(
		hook: (extension: ServerRuntimeExtension) => void | Promise<void>,
	): Promise<readonly ServerRuntimeExtensionHookResult[]> {
		const extensions = [...this.extensions.values()];
		const settled = await Promise.allSettled(
			extensions.map(async (extension) => {
				await hook(extension);
			}),
		);
		return settled.map((result, index) =>
			result.status === "fulfilled"
				? { extensionId: extensions[index]!.id, status: "fulfilled" as const }
				: { extensionId: extensions[index]!.id, status: "rejected" as const, reason: result.reason },
		);
	}
}

function extensionCapabilities(extension: ServerRuntimeExtension | undefined): readonly string[] {
	if (extension?.capabilities === undefined) return [];
	return extension.capabilities.map((capability) => capability.trim()).filter((capability) => capability.length > 0);
}

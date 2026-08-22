export interface ServerRuntimeModel {
	readonly id: string;
	readonly provider?: string;
}

export interface ServerRuntimeOperation {
	readonly id: string;
	readonly type: string;
}

export interface ServerRuntimeExtensionState {
	get<T>(key: string): Promise<T | undefined>;
	set(key: string, value: unknown): Promise<void>;
}

export interface ServerRuntimeExtensionContext {
	readonly operation: ServerRuntimeOperation;
	readonly model: ServerRuntimeModel;
	readonly state: ServerRuntimeExtensionState;
}

export interface ServerRuntimeExtension {
	readonly id: string;
	onOperationAccepted?(context: ServerRuntimeExtensionContext): void | Promise<void>;
	onOperationTerminal?(context: ServerRuntimeExtensionContext & { readonly outcome: string }): void | Promise<void>;
}

export interface ServerRuntimeExtensionHookResult {
	readonly extensionId: string;
	readonly status: "fulfilled" | "rejected";
	readonly reason?: unknown;
}

export interface ServerRuntimeExtensionHostOptions {
	readonly resolveModel: () => ServerRuntimeModel;
	readonly loadState?: (extensionId: string, key: string) => unknown | Promise<unknown>;
	readonly persistState?: (extensionId: string, key: string, value: unknown) => void | Promise<void>;
}

export class ServerRuntimeExtensionHost {
	private readonly extensions = new Map<string, ServerRuntimeExtension>();
	private readonly options: ServerRuntimeExtensionHostOptions;

	public constructor(options: ServerRuntimeExtensionHostOptions) {
		this.options = options;
	}

	public async register(extension: ServerRuntimeExtension): Promise<void> {
		if (this.extensions.has(extension.id)) throw new Error(`Extension ${extension.id} is already registered`);
		this.extensions.set(extension.id, extension);
	}

	public registerClientCommand(_name: string): never {
		throw new Error("server runtime extensions cannot register client commands");
	}

	public async onOperationAccepted(operation: ServerRuntimeOperation): Promise<readonly ServerRuntimeExtensionHookResult[]> {
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

	public async getState<T>(extensionId: string, key: string): Promise<T | undefined> {
		return (await this.options.loadState?.(extensionId, key)) as T | undefined;
	}

	private context(extensionId: string, operation: ServerRuntimeOperation): ServerRuntimeExtensionContext {
		return {
			// Give each extension independent values so mutable extension code cannot
			// affect another extension or the server's event object.
			operation: { ...operation },
			model: { ...this.options.resolveModel() },
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
				// The async boundary captures synchronous hook throws as rejected
				// results and keeps dispatch isolated across extensions.
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

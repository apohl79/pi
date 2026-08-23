import type {
	V2Marketplace,
	V2Plugin,
	V2PluginAppAuthComplete,
	V2PluginAppAuthStart,
	V2PluginRegistry,
	V2PluginScope,
} from "@earendil-works/pi-server";
import type { CodexPluginActivationOptions, CodexPluginActivationStore } from "../core/codex-plugin-activation.ts";

export { CodexPluginActivationStore } from "../core/codex-plugin-activation.ts";

/** Decorates a registry with staged, atomic Codex package activation. */
export class ActivatingV2PluginRegistry implements V2PluginRegistry {
	private readonly delegate: V2PluginRegistry;
	private readonly activation: CodexPluginActivationStore;

	constructor(delegate: V2PluginRegistry, activation: CodexPluginActivationStore) {
		this.delegate = delegate;
		this.activation = activation;
	}

	listMarketplaces(): Promise<readonly V2Marketplace[]> {
		return this.delegate.listMarketplaces();
	}
	addMarketplace(name: string, source: string): Promise<V2Marketplace> {
		return this.delegate.addMarketplace(name, source);
	}
	removeMarketplace(name: string): Promise<void> {
		return this.delegate.removeMarketplace(name);
	}
	upgradeMarketplace(name: string): Promise<V2Marketplace> {
		return this.delegate.upgradeMarketplace(name);
	}
	listPlugins(installedOnly?: boolean): Promise<readonly V2Plugin[]> {
		return this.delegate.listPlugins(installedOnly);
	}
	readPlugin(id: string): Promise<V2Plugin | undefined> {
		return this.delegate.readPlugin(id);
	}
	uninstallPlugin(id: string): Promise<void> {
		return this.delegate.uninstallPlugin(id);
	}
	setEnabled(id: string, enabled: boolean, scope?: V2PluginScope): Promise<V2Plugin> {
		return this.delegate.setEnabled(id, enabled, scope);
	}
	startAppAuth?(id: string, payload: Record<string, unknown>): Promise<V2PluginAppAuthStart> {
		return (
			this.delegate.startAppAuth?.(id, payload) ?? Promise.reject(new Error("App authentication is unavailable"))
		);
	}
	completeAppAuth?(id: string, payload: Record<string, unknown>): Promise<V2PluginAppAuthComplete> {
		return (
			this.delegate.completeAppAuth?.(id, payload) ?? Promise.reject(new Error("App authentication is unavailable"))
		);
	}

	async installPlugin(input: Parameters<V2PluginRegistry["installPlugin"]>[0]): Promise<V2Plugin> {
		if (input.root === undefined) return this.delegate.installPlugin(input);
		const activation = await this.activate(
			`${input.name}@${input.marketplace}`,
			input.version,
			input.root,
			input.manifest,
		);
		return this.delegate.installPlugin({ ...input, root: activation.root });
	}

	async upgradePlugin(
		id: string,
		version: string,
		manifest?: Record<string, unknown>,
		root?: string,
	): Promise<V2Plugin> {
		if (manifest === undefined || root === undefined) return this.delegate.upgradePlugin(id, version, manifest, root);
		const activation = await this.activate(id, version, root, manifest);
		return this.delegate.upgradePlugin(id, version, manifest, activation.root);
	}

	private activate(name: string, version: string, root: string, manifest: Record<string, unknown>) {
		const options: CodexPluginActivationOptions = {
			id: name,
			version,
			sourceRoot: root,
			manifest: manifest as unknown as CodexPluginActivationOptions["manifest"],
		};
		return this.activation.activate(options);
	}
}

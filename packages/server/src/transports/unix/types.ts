import type { V2AgentRegistry } from "../../agents.ts";
import type { V2AppRegistry } from "../../apps.ts";
import type { V2BlobStore } from "../../blobs.ts";
import type { ForensicRecorder } from "../../diagnostics.ts";
import type { V2FileReferenceService } from "../../files.ts";
import type { V2ImageService } from "../../images.ts";
import type { V2InputRegistry } from "../../inputs.ts";
import type { V2OperationStore } from "../../operation-store.ts";
import type { V2PlanRegistry } from "../../plans.ts";
import type { V2PluginRegistry } from "../../plugins.ts";
import type { V2ProcessRegistry } from "../../processes.ts";
import type { PiServerOptions } from "../../types.ts";
import type { V2UsageLedger } from "../../usage-ledger.ts";
import type { V2WebService } from "../../web.ts";

export interface UnixListenerOptions {
	path: string;
	/** Socket filesystem permissions. Defaults to owner read/write only (0o600). */
	mode?: number;
	/** Maximum framed bytes queued per connection before a slow peer is disconnected. */
	maxPendingBytes?: number;
	gracefulCloseTimeoutMs?: number;
	/** Used to derive and validate maxPendingBytes. Must match the server when customized. */
	maxFrameLength?: number;
	onError?: (error: Error) => void;
}

export interface UnixServerOptions extends Omit<PiServerOptions, "listeners">, UnixListenerOptions {
	diagnostics?: ForensicRecorder;
	operationStore?: V2OperationStore;
	processes?: V2ProcessRegistry;
	blobs?: V2BlobStore;
	agents?: V2AgentRegistry;
	apps?: V2AppRegistry;
	plans?: V2PlanRegistry;
	inputs?: V2InputRegistry;
	files?: V2FileReferenceService;
	web?: V2WebService;
	images?: V2ImageService;
	plugins?: V2PluginRegistry;
	usage?: V2UsageLedger;
}

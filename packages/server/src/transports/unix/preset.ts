import { PiServer } from "../../server.ts";
import type { PiServerService } from "../../types.ts";
import type { PiServerServiceV2 } from "../../v2.ts";
import { PiServerV2 } from "../../v2.ts";
import { createUnixListener } from "./listener.ts";
import type { UnixServerOptions } from "./types.ts";

/** Compose PiServer with one Unix-domain socket listener. */
export function createUnixServer(service: PiServerService, options: UnixServerOptions): PiServer {
	const listener = createUnixListener({
		path: options.path,
		mode: options.mode,
		maxFrameLength: options.maxFrameLength,
		maxPendingBytes: options.maxPendingBytes,
		gracefulCloseTimeoutMs: options.gracefulCloseTimeoutMs,
		onError: options.onError,
	});
	return new PiServer(service, {
		listeners: [listener],
		maxFrameLength: options.maxFrameLength,
		handshakeTimeoutMs: options.handshakeTimeoutMs,
		serverId: options.serverId,
		onError: options.onError,
	});
}

/** Compose the deterministic v2 protocol seam with one Unix-domain socket listener. */
export function createUnixServerV2(service: PiServerServiceV2, options: UnixServerOptions): PiServerV2 {
	const listener = createUnixListener({
		path: options.path,
		mode: options.mode,
		maxFrameLength: options.maxFrameLength,
		maxPendingBytes: options.maxPendingBytes,
		gracefulCloseTimeoutMs: options.gracefulCloseTimeoutMs,
		onError: options.onError,
	});
	return new PiServerV2(service, {
		listeners: [listener],
		maxFrameLength: options.maxFrameLength,
		handshakeTimeoutMs: options.handshakeTimeoutMs,
		serverId: options.serverId,
		onError: options.onError,
		diagnostics: options.diagnostics,
		diagnosticContent: options.diagnosticContent,
		runtimeManifest: options.runtimeManifest,
		operationStore: options.operationStore,
		processes: options.processes,
		blobs: options.blobs,
		agents: options.agents,
		apps: options.apps,
		plans: options.plans,
		inputs: options.inputs,
		files: options.files,
		web: options.web,
		images: options.images,
		plugins: options.plugins,
		usage: options.usage,
	});
}

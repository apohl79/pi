import { describe, expect, test, vi } from "vitest";
import { ServerDaemon, type ServerDaemonServer } from "../src/daemon.ts";
import { InMemoryForensicRecorder } from "../src/diagnostics.ts";
import type { PiServerServiceV2 } from "../src/v2.ts";

function service(): PiServerServiceV2 {
	return {
		listSessions: async () => [],
		listModels: async () => [],
		openSession: async () => {
			throw new Error("not used");
		},
	};
}

function fakeServer(start: () => Promise<void>, close: () => Promise<void>): ServerDaemonServer {
	return { id: "daemon-test", addresses: ["unix:///tmp/daemon-test.sock"], start, close };
}

describe("ServerDaemon", () => {
	test("starts, reports status, and stops the owned server", async () => {
		const start = vi.fn(async () => {});
		const close = vi.fn(async () => {});
		const daemon = new ServerDaemon({
			service: service(),
			socketPath: "/tmp/daemon-test.sock",
			createServer: () => fakeServer(start, close),
		});

		expect(daemon.status()).toEqual({ state: "stopped", addresses: [] });
		expect(await daemon.start()).toEqual({
			state: "running",
			serverId: "daemon-test",
			addresses: ["unix:///tmp/daemon-test.sock"],
		});
		expect(start).toHaveBeenCalledOnce();
		expect(await daemon.start()).toMatchObject({ state: "running" });
		expect(start).toHaveBeenCalledOnce();
		expect(await daemon.stop()).toEqual({ state: "stopped", addresses: [] });
		expect(close).toHaveBeenCalledOnce();
	});

	test("returns to stopped after a failed start and closes the failed server", async () => {
		const close = vi.fn(async () => {});
		const daemon = new ServerDaemon({
			service: service(),
			socketPath: "/tmp/daemon-test.sock",
			createServer: () =>
				fakeServer(async () => {
					throw new Error("bind failed");
				}, close),
		});

		await expect(daemon.start()).rejects.toThrow("bind failed");
		expect(daemon.status()).toEqual({ state: "stopped", addresses: [] });
		expect(close).toHaveBeenCalledOnce();
	});

	test("passes injected diagnostics through to the owned server", async () => {
		const diagnostics = new InMemoryForensicRecorder();
		let received: unknown;
		const daemon = new ServerDaemon({
			service: service(),
			socketPath: "/tmp/daemon-test.sock",
			diagnostics,
			createServer: (_service, options) => {
				received = options.diagnostics;
				return fakeServer(
					async () => {},
					async () => {},
				);
			},
		});
		await daemon.start();
		expect(received).toBe(diagnostics);
		await daemon.stop();
	});

	test("records daemon lifecycle markers", async () => {
		const diagnostics = new InMemoryForensicRecorder();
		const daemon = new ServerDaemon({
			service: service(),
			socketPath: "/tmp/daemon-test.sock",
			diagnostics,
			createServer: () =>
				fakeServer(
					async () => {},
					async () => {},
				),
		});
		await daemon.start();
		await daemon.stop();
		expect((await diagnostics.read()).map((event) => event.kind)).toEqual([
			"daemon_starting",
			"daemon_started",
			"daemon_stopping",
			"daemon_stopped",
		]);
		expect(new Set((await diagnostics.read()).map((event) => event.daemonInstanceId)).size).toBe(1);
	});

	test("assigns a fresh daemon instance identity for each start", async () => {
		const diagnostics = new InMemoryForensicRecorder();
		const daemon = new ServerDaemon({
			service: service(),
			socketPath: "/tmp/daemon-test.sock",
			diagnostics,
			createServer: () =>
				fakeServer(
					async () => {},
					async () => {},
				),
		});
		await daemon.start();
		await daemon.stop();
		await daemon.start();
		await daemon.stop();
		const identities = new Set((await diagnostics.read()).map((event) => event.daemonInstanceId));
		expect(identities).toHaveLength(2);
		expect([...identities].every((identity) => typeof identity === "string" && identity.length > 0)).toBe(true);
	});
});

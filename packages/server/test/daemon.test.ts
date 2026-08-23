import { describe, expect, test, vi } from "vitest";
import { ServerDaemon, type ServerDaemonServer } from "../src/daemon.ts";
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

	test("returns to stopped when server creation fails", async () => {
		const failure = new Error("factory failed");
		const createServer = vi.fn(() => {
			throw failure;
		});
		const daemon = new ServerDaemon({
			service: service(),
			socketPath: "/tmp/daemon-test.sock",
			createServer,
		});

		await expect(daemon.start()).rejects.toBe(failure);
		expect(daemon.status()).toEqual({ state: "stopped", addresses: [] });
		expect(createServer).toHaveBeenCalledOnce();
	});
});

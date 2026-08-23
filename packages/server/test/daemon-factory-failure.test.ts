import { describe, expect, test, vi } from "vitest";
import { ServerDaemon } from "../src/daemon.ts";
import type { PiServerServiceV2 } from "../src/v2.ts";

const service = (): PiServerServiceV2 => ({
	listSessions: async () => [],
	listModels: async () => [],
	openSession: async () => {
		throw new Error("not used");
	},
});

describe("ServerDaemon factory failures", () => {
	test("returns to stopped when server creation fails", async () => {
		const failure = new Error("factory failed");
		const createServer = vi.fn(() => {
			throw failure;
		});
		const daemon = new ServerDaemon({
			service: service(),
			socketPath: "/tmp/daemon-factory-failure.sock",
			createServer,
		});

		await expect(daemon.start()).rejects.toBe(failure);
		expect(daemon.status()).toEqual({ state: "stopped", addresses: [] });
		expect(createServer).toHaveBeenCalledOnce();
	});
});

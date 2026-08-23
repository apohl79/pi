import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { PiClientV2 } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";
import { afterEach, describe, expect, test } from "vitest";
import { createConfiguredCodingAgentDaemonRuntime } from "../../src/server/daemon-runtime.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createRuntime(directory: string) {
	const models = createModels();
	const faux = fauxProvider({
		provider: "coding-agent-daemon-marketplace-upgrade-faux",
		models: [
			{
				id: "coding-agent-daemon-marketplace-upgrade-model",
				reasoning: false,
				contextWindow: 32_000,
				maxTokens: 1_000,
			},
		],
	});
	models.setProvider(faux.provider);
	return createConfiguredCodingAgentDaemonRuntime({
		agentDir: directory,
		cwd: directory,
		models,
		model: faux.getModel(),
		socketPath: join(directory, "server.sock"),
		harness: { tools: [], activeToolNames: [] },
		write: () => {},
	});
}

async function connect(directory: string): Promise<PiClientV2> {
	const client = new PiClientV2({
		transportFactory: createUnixTransportFactory({ path: join(directory, "server.sock") }),
	});
	await client.connect();
	return client;
}

describe("coding-agent daemon marketplace upgrade", () => {
	test("persists the refreshed marketplace record across restart", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-daemon-marketplace-upgrade-"));
		directories.push(directory);
		const first = await createRuntime(directory);
		await first.daemon.start();
		const firstClient = await connect(directory);
		let initialAddedAt: number;
		try {
			const added = await firstClient.request({
				command: "marketplace/add",
				payload: { name: "local", source: "file:///tmp/marketplace" },
			});
			if (!added.ok || !("result" in added)) throw new Error(`Marketplace add failed: ${JSON.stringify(added)}`);
			initialAddedAt = (added.result as { marketplace: { addedAt: number } }).marketplace.addedAt;
			await new Promise((resolve) => setTimeout(resolve, 2));
			const upgraded = await firstClient.request({ command: "marketplace/upgrade", payload: { name: "local" } });
			expect(upgraded).toMatchObject({
				ok: true,
				result: { marketplace: { name: "local", source: "file:///tmp/marketplace", addedAt: expect.any(Number) } },
			});
			if (!upgraded.ok || !("result" in upgraded))
				throw new Error(`Marketplace upgrade failed: ${JSON.stringify(upgraded)}`);
			expect((upgraded.result as { marketplace: { addedAt: number } }).marketplace.addedAt).toBeGreaterThan(
				initialAddedAt,
			);
		} finally {
			firstClient.dispose();
			await first.close();
		}
		const second = await createRuntime(directory);
		const secondClient = await (async () => {
			await second.daemon.start();
			return connect(directory);
		})();
		try {
			const listed = await secondClient.request({ command: "marketplace/list" });
			expect(listed).toMatchObject({
				ok: true,
				result: {
					marketplaces: [{ name: "local", source: "file:///tmp/marketplace", addedAt: expect.any(Number) }],
				},
			});
			if (!listed.ok || !("result" in listed)) throw new Error(`Marketplace list failed: ${JSON.stringify(listed)}`);
			expect((listed.result as { marketplaces: [{ addedAt: number }] }).marketplaces[0].addedAt).toBeGreaterThan(
				initialAddedAt,
			);
		} finally {
			secondClient.dispose();
			await second.close();
		}
	});
});

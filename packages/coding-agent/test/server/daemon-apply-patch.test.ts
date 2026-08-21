import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { PiClientV2 } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";
import { afterEach, describe, expect, test } from "vitest";
import { RemoteV2Session } from "../../src/client/remote-v2-session.ts";
import { createConfiguredCodingAgentDaemonRuntime } from "../../src/server/daemon-runtime.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createPatchRuntime(directory: string) {
	const models = createModels();
	const faux = fauxProvider({
		provider: "coding-agent-daemon-patch-faux",
		models: [{ id: "coding-agent-daemon-patch-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
	});
	models.setProvider(faux.provider);
	faux.setResponses([
		fauxAssistantMessage(
			fauxToolCall("apply_patch", {
				patch: "*** Begin Patch\n*** Add File: patched.txt\n+patched through daemon\n*** End Patch",
			}),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("patch complete"),
	]);
	return createConfiguredCodingAgentDaemonRuntime({
		agentDir: directory,
		cwd: directory,
		models,
		model: faux.getModel(),
		socketPath: join(directory, "server.sock"),
		harness: { activeToolNames: ["apply_patch"] },
		write: () => {},
	});
}

describe("production daemon apply_patch", () => {
	test("applies a Codex patch inside the configured execution root", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-daemon-patch-"));
		directories.push(directory);
		const runtime = await createPatchRuntime(directory);
		const client = new PiClientV2({
			transportFactory: createUnixTransportFactory({ path: join(directory, "server.sock") }),
		});
		try {
			await runtime.daemon.start();
			await client.connect();
			const session = await RemoteV2Session.create(client, { cwd: directory }, { mode: "control" });
			try {
				const operationId = await session.submit("create the patch file");
				const snapshot = await session.waitForOperation(operationId);
				expect(
					snapshot.transcript.some(
						(item) =>
							item.role === "assistant" &&
							item.content.some((part) => part.type === "text" && part.text === "patch complete"),
					),
				).toBe(true);
				expect(await readFile(join(directory, "patched.txt"), "utf8")).toBe("patched through daemon\n");
			} finally {
				await session.dispose();
			}
		} finally {
			client.dispose();
			await runtime.close();
		}
	});
});

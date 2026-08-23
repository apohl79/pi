import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, test } from "vitest";
import { createAgentSession } from "../../src/index.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("package-default SDK", () => {
	test("creates a server-owned session by default", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "pi-default-sdk-"));
		directories.push(agentDir);
		const models = createModels();
		const faux = fauxProvider({
			provider: "default-sdk-faux",
			models: [{ id: "default-sdk-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		models.setProvider(faux.provider);
		faux.setResponses([fauxAssistantMessage("server-default SDK response")]);

		const handle = await createAgentSession({ agentDir, cwd: agentDir, models, model: faux.getModel() });
		try {
			expect(handle.runtime.daemon.status()).toMatchObject({ state: "running" });
			const operationId = await handle.session.submit("use the server default");
			await handle.session.waitForOperation(operationId);
			expect(handle.session.snapshot?.transcript).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						content: expect.arrayContaining([expect.objectContaining({ text: "server-default SDK response" })]),
					}),
				]),
			);
		} finally {
			await handle.close();
		}
	});
});

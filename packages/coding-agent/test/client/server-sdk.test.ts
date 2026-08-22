import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createServerAgentSession } from "../../src/client/server-sdk.ts";

describe("createServerAgentSession", () => {
	it("discovers a configured-directory model without network refresh", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "pi-server-sdk-discovery-"));
		try {
			await writeFile(
				join(agentDir, "models.json"),
				JSON.stringify({ modelRoles: { anthropic: { fast: "haiku" } } }),
			);
			const handle = await createServerAgentSession({ agentDir, cwd: agentDir });
			expect(handle.session.snapshot?.model).toBeDefined();
			expect(handle.runtime.daemon.status()).toMatchObject({ state: "running" });
			await handle.close();
			expect(handle.client.connected).toBe(false);
		} finally {
			await rm(agentDir, { recursive: true, force: true });
		}
	});

	it("creates a remote session owned by the configured daemon", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "pi-server-sdk-"));
		const models = createModels();
		const faux = fauxProvider({
			provider: "server-sdk-faux",
			models: [{ id: "server-sdk-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		models.setProvider(faux.provider);
		try {
			const handle = await createServerAgentSession({ agentDir, cwd: agentDir, models, model: faux.getModel() });
			expect(handle.session.id).toBeDefined();
			expect(handle.client.connected).toBe(true);
			expect(handle.runtime.daemon.status()).toMatchObject({ state: "running" });
			await handle.close();
			expect(handle.client.connected).toBe(false);
		} finally {
			await rm(agentDir, { recursive: true, force: true });
		}
	});
});

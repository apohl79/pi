import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createServerAgentSession, openServerAgentSession } from "../../src/client/server-sdk.ts";

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

	it("runs turns through the server-owned session and exposes durable projections", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "pi-server-sdk-turn-"));
		const models = createModels();
		const faux = fauxProvider({
			provider: "server-sdk-turn-faux",
			models: [{ id: "server-sdk-turn-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		models.setProvider(faux.provider);
		faux.setResponses([fauxAssistantMessage("server-owned reply")]);
		try {
			const handle = await createServerAgentSession({ agentDir, cwd: agentDir, models, model: faux.getModel() });
			try {
				const operationId = await handle.session.submit("persist this through the SDK");
				await handle.session.waitForOperation(operationId);
				expect(handle.session.snapshot?.transcript).toEqual(
					expect.arrayContaining([
						expect.objectContaining({
							content: expect.arrayContaining([expect.objectContaining({ text: "server-owned reply" })]),
						}),
					]),
				);
				expect(handle.session.snapshot?.usage).toBeDefined();
			} finally {
				await handle.close();
			}
		} finally {
			await rm(agentDir, { recursive: true, force: true });
		}
	});

	it("reopens a durable session through the SDK after daemon shutdown", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "pi-server-sdk-reopen-"));
		const models = createModels();
		const faux = fauxProvider({
			provider: "server-sdk-reopen-faux",
			models: [{ id: "server-sdk-reopen-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		models.setProvider(faux.provider);
		faux.setResponses([
			fauxAssistantMessage("reopen this durable session"),
			fauxAssistantMessage("continued after daemon restart"),
		]);
		try {
			const first = await createServerAgentSession({ agentDir, cwd: agentDir, models, model: faux.getModel() });
			const sessionId = first.session.id;
			expect(sessionId).toEqual(expect.any(String));
			try {
				const operationId = await first.session.submit("save this before shutdown");
				await first.session.waitForOperation(operationId);
			} finally {
				await first.close();
			}

			const reopened = await openServerAgentSession(String(sessionId), {
				agentDir,
				cwd: agentDir,
				models,
				model: faux.getModel(),
			});
			try {
				expect(reopened.session.snapshot?.transcript).toEqual(
					expect.arrayContaining([
						expect.objectContaining({
							content: expect.arrayContaining([
								expect.objectContaining({ text: "reopen this durable session" }),
							]),
						}),
					]),
				);
				const operationId = await reopened.session.submit("continue after restart");
				await reopened.session.waitForOperation(operationId);
				expect(reopened.session.snapshot?.transcript).toEqual(
					expect.arrayContaining([
						expect.objectContaining({
							content: expect.arrayContaining([
								expect.objectContaining({ text: "continued after daemon restart" }),
							]),
						}),
					]),
				);
			} finally {
				await reopened.close();
			}
		} finally {
			await rm(agentDir, { recursive: true, force: true });
		}
	});
});

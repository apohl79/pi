import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { createNodeSqliteFactory, SqliteSessionRepository } from "@earendil-works/pi-session-backend-sqlite-node";
import { afterEach, describe, expect, test } from "vitest";
import { createCodingAgentV2SqliteService } from "../../src/server/sqlite-service.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("coding-agent SQLite v2 service", () => {
	test("creates, lists, lazily opens, and deletes a durable session", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-coding-agent-v2-sqlite-"));
		directories.push(directory);
		const env = new NodeExecutionEnv({ cwd: directory });
		const repository = new SqliteSessionRepository({
			env,
			sqlite: createNodeSqliteFactory(),
			databasePath: "sessions.sqlite",
		});
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-v2-sqlite-faux",
			models: [{ id: "coding-agent-v2-sqlite-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		models.setProvider(faux.provider);
		try {
			const service = await createCodingAgentV2SqliteService({
				repository,
				models,
				env,
				model: faux.getModel(),
				harness: { tools: [], activeToolNames: [] },
			});
			const created = await service.createSession!({ id: "sqlite-session", cwd: directory, name: "SQLite session" });
			expect(created.sessionId).toBe("sqlite-session");
			expect(await service.listSessions()).toMatchObject([{ id: "sqlite-session", sessionName: "SQLite session" }]);
			await service.openSession("sqlite-session");
			await service.deleteSession!("sqlite-session");
			expect(await service.listSessions()).toEqual([]);
		} finally {
			await repository.close();
			await env.cleanup();
		}
	});
});

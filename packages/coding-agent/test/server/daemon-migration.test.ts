import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, test } from "vitest";
import { createConfiguredCodingAgentDaemonRuntime } from "../../src/server/daemon-runtime.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("production daemon migration", () => {
	test("moves a legacy root session before opening the runtime", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-coding-agent-daemon-migration-"));
		directories.push(directory);
		const legacyPath = join(directory, "legacy-session.jsonl");
		await writeFile(
			legacyPath,
			`${JSON.stringify({ type: "session", id: "legacy-session", cwd: directory, timestamp: "2025-01-01T00:00:00Z" })}\n`,
		);
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-daemon-migration-faux",
			models: [
				{ id: "coding-agent-daemon-migration-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 },
			],
		});
		models.setProvider(faux.provider);
		const runtime = await createConfiguredCodingAgentDaemonRuntime({
			agentDir: directory,
			cwd: directory,
			models,
			model: faux.getModel(),
			socketPath: join(directory, "pi.sock"),
			harness: { tools: [], activeToolNames: [] },
			write: () => {},
		});
		try {
			const safePath = `--${directory.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
			await access(join(directory, "sessions", safePath, "legacy-session.jsonl"));
			await expect(readFile(legacyPath)).rejects.toMatchObject({ code: "ENOENT" });
			expect(await runtime.service.listSessions()).toEqual([
				expect.objectContaining({ id: "legacy-session", cwd: directory }),
			]);
		} finally {
			await runtime.close();
		}
		const diagnostics = await readFile(join(directory, "diagnostics.jsonl"), "utf8");
		expect(diagnostics).toContain('"kind":"daemon_migration_started"');
		expect(diagnostics).toContain('"kind":"daemon_migration_completed"');
	});
});

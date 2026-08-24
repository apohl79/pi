import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { InMemoryForensicRecorder } from "@earendil-works/pi-server";
import { afterEach, describe, expect, test } from "vitest";
import { createConfiguredCodingAgentDaemonRuntime } from "../../src/server/daemon-runtime.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("production daemon lifecycle diagnostics", () => {
	test("records malformed marker recovery and replaces the marker before serving", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-daemon-marker-diagnostics-"));
		directories.push(directory);
		const markerPath = join(directory, "daemon-state.json");
		await writeFile(markerPath, "not-json");
		const diagnostics = new InMemoryForensicRecorder();
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-daemon-marker-diagnostics-faux",
			models: [{ id: "marker-diagnostics-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		models.setProvider(faux.provider);
		const runtime = await createConfiguredCodingAgentDaemonRuntime({
			agentDir: directory,
			cwd: directory,
			models,
			model: faux.getModel(),
			socketPath: join(directory, "server.sock"),
			diagnostics,
			harness: { tools: [], activeToolNames: [] },
			write: () => {},
		});
		try {
			await runtime.daemon.start();
			expect((await diagnostics.read()).map((event) => event.kind)).toContain("daemon_lifecycle_marker_invalid");
			expect(JSON.parse(await readFile(markerPath, "utf8"))).toMatchObject({ state: "running" });
		} finally {
			await runtime.close();
		}
	});
});

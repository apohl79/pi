import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { JsonlForensicRecorder } from "../src/diagnostics.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("JsonlForensicRecorder shutdown boundary", () => {
	test("flushes accepted events before daemon shutdown", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-diagnostics-flush-"));
		directories.push(directory);
		const path = join(directory, "events.jsonl");
		const recorder = new JsonlForensicRecorder(path);
		const pending = recorder.record({ kind: "shutdown-boundary" });
		await recorder.flush();
		await pending;

		expect(await readFile(path, "utf8")).toContain('"kind":"shutdown-boundary"');
	});
});

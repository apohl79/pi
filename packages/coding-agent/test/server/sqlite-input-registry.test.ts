import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeSqliteFactory } from "@earendil-works/pi-session-backend-sqlite-node";
import { afterEach, describe, expect, test } from "vitest";
import { SqliteV2InputRegistry } from "../../src/server/sqlite-input-registry.ts";

const directories: string[] = [];
afterEach(async () =>
	Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))),
);

const questions = [{ id: "choice", prompt: "Choose", options: [{ label: "yes" }] }];

describe("SqliteV2InputRegistry", () => {
	test("restores responses and keeps consumption exactly once across restart", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-sqlite-inputs-"));
		directories.push(directory);
		const path = join(directory, "inputs.sqlite");
		const first = new SqliteV2InputRegistry(createNodeSqliteFactory(), path);
		const request = await first.create("session-1", questions);
		await first.respond(request.id, { choice: "yes" });
		await first.close();

		const restored = new SqliteV2InputRegistry(createNodeSqliteFactory(), path);
		expect(await restored.read(request.id)).toMatchObject({ status: "responded", answers: { choice: "yes" } });
		expect(await restored.takeRespondedForSession("session-1")).toEqual({ choice: "yes" });
		await restored.close();

		const reopened = new SqliteV2InputRegistry(createNodeSqliteFactory(), path);
		expect(await reopened.takeRespondedForSession("session-1")).toBeUndefined();
		await reopened.close();
	});
});

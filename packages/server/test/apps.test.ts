import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { InMemoryV2AppCredentialStore, JsonV2AppCredentialStore } from "../src/apps.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("V2 app credential stores", () => {
	test("keeps credentials separate from app/plugin state and clones values", async () => {
		const store = new InMemoryV2AppCredentialStore();
		const credentials = { accessToken: "secret", nested: { refreshToken: "refresh" } };
		await store.save("plugin@app", credentials);
		credentials.nested.refreshToken = "changed";
		expect(await store.read("plugin@app")).toEqual({
			accessToken: "secret",
			nested: { refreshToken: "refresh" },
		});
	});

	test("persists credentials in an owner-only separate file", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-app-credentials-"));
		directories.push(directory);
		const path = join(directory, "agent", "app-credentials.json");
		const first = new JsonV2AppCredentialStore(path);
		await first.save("plugin@app", { accessToken: "secret" });
		const reopened = new JsonV2AppCredentialStore(path);
		expect(await reopened.read("plugin@app")).toEqual({ accessToken: "secret" });
		expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ "plugin@app": { accessToken: "secret" } });
	});
});

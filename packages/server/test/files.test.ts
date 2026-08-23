import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { LocalV2FileReferenceService } from "../src/files.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
	directories.length = 0;
});

describe("LocalV2FileReferenceService", () => {
	test("completes and reads project, home, and relative references", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-files-"));
		directories.push(root);
		await writeFile(join(root, "README.md"), "hello");
		await writeFile(join(root, "notes.ts"), "export const answer = 42;");
		const service = new LocalV2FileReferenceService({ projectRoot: root, homeDirectory: root });

		expect(await service.complete("session-1", "@project:n")).toEqual([
			{ reference: "project:notes.ts", path: join(root, "notes.ts"), kind: "file" },
		]);
		expect(await service.resolve("session-1", "@README.md")).toMatchObject({
			reference: "README.md",
			path: await realpath(join(root, "README.md")),
			kind: "file",
			size: 5,
		});
		expect(new TextDecoder().decode((await service.read("session-1", "~/notes.ts")).data)).toBe(
			"export const answer = 42;",
		);
	});

	test("rejects traversal and symlink escapes", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-files-"));
		const outside = await mkdtemp(join(tmpdir(), "pi-files-outside-"));
		directories.push(root, outside);
		await writeFile(join(outside, "secret.txt"), "secret");
		await symlink(join(outside, "secret.txt"), join(root, "link.txt"));
		const service = new LocalV2FileReferenceService({ projectRoot: root, homeDirectory: root });

		await expect(service.resolve("session-1", "../secret.txt")).rejects.toThrow("escapes");
		await expect(service.resolve("session-1", "link.txt")).rejects.toThrow("escapes");
	});
});

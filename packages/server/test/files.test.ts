import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
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
		expect(await service.resolve("session-1", "@server:README.md")).toMatchObject({
			reference: "server:README.md",
			path: await realpath(join(root, "README.md")),
			kind: "file",
		});
		expect(await service.complete("session-1", "@server:R")).toEqual([
			{
				reference: "server:README.md",
				display: "server:README.md",
				hostScope: "server",
				path: join(root, "README.md"),
				canonicalPath: await realpath(join(root, "README.md")),
				kind: "file",
				size: 5,
				mimeType: "text/markdown",
			},
		]);

		expect(await service.complete("session-1", "@project:n")).toEqual([
			{
				reference: "project:notes.ts",
				display: "project:notes.ts",
				hostScope: "server",
				path: join(root, "notes.ts"),
				canonicalPath: await realpath(join(root, "notes.ts")),
				kind: "file",
				size: 25,
				mimeType: "text/typescript",
			},
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
		await mkdir(join(outside, "private"));
		await writeFile(join(outside, "private", "nested-secret.txt"), "secret");
		await symlink(join(outside, "secret.txt"), join(root, "link.txt"));
		await symlink(join(outside, "private"), join(root, "linkdir"));
		const service = new LocalV2FileReferenceService({ projectRoot: root, homeDirectory: root });

		await expect(service.resolve("session-1", "../secret.txt")).rejects.toThrow("escapes");
		await expect(service.resolve("session-1", "link.txt")).rejects.toThrow("escapes");
		expect(await service.complete("session-1", "linkdir/")).toEqual([]);
		await expect(service.resolve("session-1", "@local:secret.txt")).rejects.toThrow("uploaded as blobs");
		await expect(service.complete("session-1", "@local:")).rejects.toThrow("uploaded as blobs");
	});

	test("allows explicit absolute references across the execution host when enabled", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-files-"));
		const outside = await mkdtemp(join(tmpdir(), "pi-files-outside-"));
		directories.push(root, outside);
		await mkdir(join(outside, "nested"));
		await writeFile(join(outside, "secret.txt"), "secret");
		const service = new LocalV2FileReferenceService({ projectRoot: root, homeDirectory: root, allowAbsolute: true });

		expect(await service.resolve("session-1", join(outside, "secret.txt"))).toMatchObject({
			path: await realpath(join(outside, "secret.txt")),
			kind: "file",
		});
		expect(await service.complete("session-1", join(outside, ""))).toEqual([
			{
				reference: join(outside, "nested"),
				display: join(outside, "nested"),
				hostScope: "server",
				path: join(outside, "nested"),
				canonicalPath: await realpath(join(outside, "nested")),
				kind: "directory",
			},
			{
				reference: join(outside, "secret.txt"),
				display: join(outside, "secret.txt"),
				hostScope: "server",
				path: join(outside, "secret.txt"),
				canonicalPath: await realpath(join(outside, "secret.txt")),
				kind: "file",
				size: 6,
			},
		]);
	});

	test("bounds completion results after directory-first ordering", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-files-"));
		directories.push(root);
		await mkdir(join(root, "a-directory"));
		await mkdir(join(root, "b-directory"));
		await writeFile(join(root, "c-file.txt"), "c");
		const service = new LocalV2FileReferenceService({ projectRoot: root, homeDirectory: root, maxCompletions: 2 });

		expect(await service.complete("session-1", "@server:")).toEqual([
			{
				reference: "server:a-directory",
				display: "server:a-directory",
				hostScope: "server",
				path: join(root, "a-directory"),
				canonicalPath: await realpath(join(root, "a-directory")),
				kind: "directory",
			},
			{
				reference: "server:b-directory",
				display: "server:b-directory",
				hostScope: "server",
				path: join(root, "b-directory"),
				canonicalPath: await realpath(join(root, "b-directory")),
				kind: "directory",
			},
		]);
		expect(() => new LocalV2FileReferenceService({ projectRoot: root, maxCompletions: 0 })).toThrow("maxCompletions");
	});

	test("fuzzy-searches bare queries through nested accessible paths", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-files-fuzzy-"));
		directories.push(root);
		await mkdir(join(root, "src", "nested"), { recursive: true });
		await writeFile(join(root, "src", "nested", "target-file.ts"), "target");
		await mkdir(join(root, "docs"));
		const service = new LocalV2FileReferenceService({ projectRoot: root, cwd: root });

		expect(await service.complete("session-1", "@tft")).toMatchObject([
			{
				reference: join("src", "nested", "target-file.ts"),
				kind: "file",
				canonicalPath: await realpath(join(root, "src", "nested", "target-file.ts")),
			},
		]);
		expect(await service.complete("session-1", "@d")).toEqual(
			expect.arrayContaining([expect.objectContaining({ reference: "docs", kind: "directory" })]),
		);
	});

	test("validates and enforces the read byte limit", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-files-read-limit-"));
		directories.push(root);
		await writeFile(join(root, "large.txt"), "12345");
		expect(() => new LocalV2FileReferenceService({ projectRoot: root, maxReadBytes: -1 })).toThrow("maxReadBytes");
		const service = new LocalV2FileReferenceService({ projectRoot: root, maxReadBytes: 3 });
		await expect(service.read("session-1", "large.txt")).rejects.toThrow("maximum size of 3 bytes");
	});

	test("cancels completion through its signal and validates the time bound", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-files-completion-cancel-"));
		directories.push(root);
		const controller = new AbortController();
		controller.abort();
		const service = new LocalV2FileReferenceService({ projectRoot: root, maxCompletionMs: 25 });
		await expect(service.complete("session-1", "@server:", { signal: controller.signal })).rejects.toThrow(
			"completion cancelled",
		);
		expect(() => new LocalV2FileReferenceService({ projectRoot: root, maxCompletionMs: 0 })).toThrow(
			"maxCompletionMs",
		);
	});
});

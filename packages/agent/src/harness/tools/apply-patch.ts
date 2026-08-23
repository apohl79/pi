import { dirname, relative, sep } from "node:path";
import { type Static, Type } from "typebox";
import type { AgentHarnessTool } from "../types.ts";
import { getOrThrow } from "../types.ts";
import { detectLineEnding, normalizeToLF, restoreLineEndings, stripBom } from "./edit-diff.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import { resolveToolPath } from "./path-utils.ts";
import type { ExecutionToolContext } from "./tool-context.ts";

const applyPatchSchema = Type.Object({
	patch: Type.String({ description: "Codex apply_patch envelope." }),
});

export type ApplyPatchToolInput = Static<typeof applyPatchSchema>;

type PatchOperation = { kind: "update" | "add" | "delete"; path: string; lines: string[] };

function parsePatchEnvelope(patch: string): PatchOperation[] {
	const lines = patch.replace(/\r\n/g, "\n").split("\n");
	if (lines.shift() !== "*** Begin Patch") throw new Error("apply_patch must start with *** Begin Patch");
	const operations: PatchOperation[] = [];
	let index = 0;
	for (; index < lines.length; ) {
		if (lines[index] === "*** End Patch") break;
		const header = lines[index++] ?? "";
		const match = /^\*\*\* (Update|Add|Delete) File: (.+)$/.exec(header);
		if (!match) throw new Error(`Invalid apply_patch file header: ${header}`);
		const kind = match[1]!.toLowerCase() as PatchOperation["kind"];
		const path = match[2]!.trim();
		const body: string[] = [];
		while (index < lines.length && !lines[index]!.startsWith("*** ")) body.push(lines[index++]!);
		operations.push({ kind, path, lines: body });
	}
	if (lines[index] !== "*** End Patch") throw new Error("apply_patch must end with *** End Patch");
	if (operations.length === 0) throw new Error("apply_patch contains no file operations");
	return operations;
}

function isWithin(root: string, target: string): boolean {
	const distance = relative(root, target);
	return distance === "" || (distance !== ".." && !distance.startsWith(`..${sep}`) && !distance.startsWith(sep));
}

function validatePath(root: string, target: string): void {
	if (!isWithin(root, target))
		throw new Error(`apply_patch path escapes execution root: ${target}`);
	if (target === root) throw new Error(`apply_patch refuses to mutate execution root: ${target}`);
}

/**
 * Validate the addressed path and every existing ancestor immediately before mutation.
 * canonicalPath resolves symlinks for the nearest existing ancestor, which also catches
 * symlinked parents of an as-yet non-existent add target.
 */
async function validateMutationPath(
	env: ExecutionToolContext["env"],
	rootPath: string,
	targetPath: string,
	signal?: AbortSignal,
): Promise<void> {
	const rootAbsolute = getOrThrow(await env.absolutePath(rootPath, signal));
	validatePath(rootAbsolute, targetPath);
	const canonicalRoot = getOrThrow(await env.canonicalPath(rootAbsolute, signal));
	let candidate = targetPath;
	while (true) {
		const info = await env.fileInfo(candidate, signal);
		if (info.ok) {
			if (candidate !== rootAbsolute && info.value.kind === "symlink") {
				throw new Error(`apply_patch refuses symlinked path: ${candidate}`);
			}
			const canonical = getOrThrow(await env.canonicalPath(candidate, signal));
			if (!isWithin(canonicalRoot, canonical)) {
				throw new Error(`apply_patch path escapes execution root through symlink: ${targetPath}`);
			}
			if (candidate === rootAbsolute) return;
			const parent = dirname(candidate);
			if (parent === candidate) throw new Error(`apply_patch path is not rooted: ${targetPath}`);
			candidate = parent;
			continue;
		}
		if (info.error.code !== "not_found") throw info.error;
		const parent = dirname(candidate);
		if (parent === candidate) throw new Error(`apply_patch path is not rooted: ${targetPath}`);
		candidate = parent;
	}
}

function applyUpdate(original: string, path: string, lines: readonly string[]): string {
	const hunkStarts = lines.flatMap((line, index) => (line.startsWith("@@") ? [index] : []));
	if (hunkStarts.length === 0) throw new Error(`Missing hunk header for ${path}`);
	const content = original.split("\n");
	const replacements = hunkStarts.map((start, hunkIndex) => {
		const end = hunkStarts[hunkIndex + 1] ?? lines.length;
		const header = lines[start]!;
		const match = header === "@@" ? [] : /^@@(?: -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? )?@@/.exec(header);
		if (!match) throw new Error(`Invalid hunk header in ${path}: ${header}`);
		const hunkLines = lines.slice(start + 1, end).filter((line) => line !== "\\ No newline at end of file");
		const oldLines = hunkLines
			.filter((line) => line.startsWith(" ") || line.startsWith("-"))
			.map((line) => line.slice(1));
		const newLines = hunkLines
			.filter((line) => line.startsWith(" ") || line.startsWith("+"))
			.map((line) => line.slice(1));
		if (hunkLines.some((line) => !/^[ +-]/.test(line))) throw new Error(`Invalid hunk line in ${path}`);
		// Unified diff line numbers are one-based, except the valid `-0,0` header
		// used for insertion into an empty file (or at the beginning of a file).
		const explicitStart =
			match[1] === undefined ? undefined : Number(match[1]) === 0 ? 0 : Number(match[1]) - 1;
		const offset = explicitStart ?? findSequence(content, oldLines);
		if (offset < 0 || content.slice(offset, offset + oldLines.length).join("\n") !== oldLines.join("\n"))
			throw new Error(`Patch hunk did not apply cleanly to ${path}`);
		return { offset, count: oldLines.length, newLines };
	});
	for (const replacement of replacements.sort((left, right) => right.offset - left.offset))
		content.splice(replacement.offset, replacement.count, ...replacement.newLines);
	return content.join("\n");
}

function findSequence(content: readonly string[], expected: readonly string[]): number {
	for (let index = 0; index <= content.length - expected.length; index++) {
		if (content.slice(index, index + expected.length).every((line, offset) => line === expected[offset]))
			return index;
	}
	return -1;
}

export function createApplyPatchTool<TContext extends ExecutionToolContext = ExecutionToolContext>(): AgentHarnessTool<
	TContext,
	typeof applyPatchSchema,
	undefined
> {
	return {
		name: "apply_patch",
		label: "apply_patch",
		description: "Apply a Codex patch envelope with root-constrained, per-file atomic mutations.",
		parameters: applyPatchSchema,
		async execute(_toolCallId, input, signal, _onUpdate, { env }) {
			const operations = parsePatchEnvelope(input.patch);
			const root = getOrThrow(await env.absolutePath(env.cwd, signal));
			for (const operation of operations) {
				const absolutePath = await resolveToolPath(env, operation.path, signal);
				validatePath(root, absolutePath);
				await withFileMutationQueue(env, absolutePath, async () => {
					if (signal?.aborted) throw new Error("Operation aborted");
					await validateMutationPath(env, root, absolutePath, signal);
					if (operation.kind === "add") {
						if (operation.lines.some((line) => !line.startsWith("+")))
							throw new Error(`Added file ${operation.path} contains a non-addition line`);
						getOrThrow(
							await env.atomicReplaceFileWithinRoot(
								root,
								absolutePath,
								`${operation.lines.map((line) => line.slice(1)).join("\n")}\n`,
								signal,
							),
						);
					} else if (operation.kind === "delete") {
						getOrThrow(await env.removeFileWithinRoot(root, absolutePath, signal));
					} else {
						const original = getOrThrow(await env.readTextFileWithinRoot(root, absolutePath, signal));
						const { bom, text } = stripBom(original);
						const ending = detectLineEnding(text);
						getOrThrow(
							await env.atomicReplaceFileWithinRoot(
								root,
								absolutePath,
								bom + restoreLineEndings(applyUpdate(normalizeToLF(text), operation.path, operation.lines), ending),
								signal,
							),
						);
					}
				});
			}
			return {
				content: [{ type: "text", text: `Applied patch to ${operations.length} file(s).` }],
				details: undefined,
			};
		},
	};
}

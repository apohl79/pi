import { type Static, Type } from "typebox";
import type { AgentHarnessTool } from "../types.ts";
import { getOrThrow } from "../types.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import { resolveToolPath } from "./path-utils.ts";
import type { ExecutionToolContext } from "./tool-context.ts";

const applyPatchSchema = Type.Object({
	patch: Type.String({ description: "Codex apply_patch envelope." }),
});

export type ApplyPatchToolInput = Static<typeof applyPatchSchema>;

type PatchOperation = { kind: "update" | "add" | "delete"; path: string; lines: string[] };
export interface ApplyPatchToolDetails {
	modifiedFiles: readonly string[];
}

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

function validatePath(root: string, target: string): void {
	const normalizedRoot = root.replaceAll("\\", "/").replace(/\/$/, "");
	const normalizedTarget = target.replaceAll("\\", "/");
	if (normalizedTarget !== normalizedRoot && !normalizedTarget.startsWith(`${normalizedRoot}/`))
		throw new Error(`apply_patch path escapes execution root: ${target}`);
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
		const explicitStart = match[1] === undefined ? undefined : Number(match[1]) - 1;
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
	ApplyPatchToolDetails
> {
	return {
		name: "apply_patch",
		label: "apply_patch",
		description: "Apply a Codex patch envelope with root-constrained, per-file atomic mutations.",
		parameters: applyPatchSchema,
		async execute(_toolCallId, input, signal, _onUpdate, { env }) {
			const operations = parsePatchEnvelope(input.patch);
			const root = env.cwd;
			const modifiedFiles: string[] = [];
			for (const operation of operations) {
				const absolutePath = await resolveToolPath(env, operation.path, signal);
				validatePath(root, absolutePath);
				await withFileMutationQueue(env, absolutePath, async () => {
					if (signal?.aborted) throw new Error("Operation aborted");
					if (operation.kind === "add") {
						if (operation.lines.some((line) => !line.startsWith("+")))
							throw new Error(`Added file ${operation.path} contains a non-addition line`);
						getOrThrow(
							await env.writeFile(
								absolutePath,
								`${operation.lines.map((line) => line.slice(1)).join("\n")}\n`,
								signal,
							),
						);
					} else if (operation.kind === "delete") {
						getOrThrow(await env.remove(absolutePath, { force: false, abortSignal: signal }));
					} else {
						const original = getOrThrow(await env.readTextFile(absolutePath, signal));
						getOrThrow(
							await env.writeFile(absolutePath, applyUpdate(original, operation.path, operation.lines), signal),
						);
					}
					modifiedFiles.push(absolutePath);
				});
			}
			return {
				content: [{ type: "text", text: `Applied patch to ${operations.length} file(s).` }],
				details: { modifiedFiles },
			};
		},
	};
}

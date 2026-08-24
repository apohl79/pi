import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { copyFile } from "node:fs/promises";
import {
	type Entry,
	type JsonlSessionMetadata,
	JsonlSessionRepo,
	type JsonlSessionRepoFileSystem,
	type ProvisionedEntry,
} from "@earendil-works/pi-agent-core";
import type { SqliteSessionRepository } from "@earendil-works/pi-session-backend-sqlite-node";
import { loadEntriesFromFile, type SessionHeader } from "../core/session-manager.ts";

const LEGACY_IMPORT_VERSION = 1;
const BACKUP_SUFFIX = ".legacy-backup";

export interface LegacySessionImportOptions {
	repository: SqliteSessionRepository;
	fs: JsonlSessionRepoFileSystem;
	sessionsRoot: string;
}

export interface LegacySessionImportResult {
	imported: number;
	skipped: number;
	failed: number;
}

function digest(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

function backupPath(path: string, sourceDigest: string): string {
	return `${path}${BACKUP_SUFFIX}-${sourceDigest.slice(0, 16)}`;
}

async function backupSource(path: string, sourceDigest: string): Promise<string> {
	const destination = backupPath(path, sourceDigest);
	try {
		await copyFile(path, destination, constants.COPYFILE_EXCL);
	} catch (error) {
		if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
	}
	return destination;
}

async function importSession(
	repository: SqliteSessionRepository,
	metadata: JsonlSessionMetadata,
	entries: readonly Entry[],
	content: string,
	backup: string,
): Promise<void> {
	const session = await repository.create({
		id: metadata.id,
		cwd: metadata.cwd,
		...(metadata.parentSessionId === undefined ? {} : { parentSessionId: metadata.parentSessionId }),
		metadata: {
			...(metadata.metadata ?? {}),
			legacyImport: {
				version: LEGACY_IMPORT_VERSION,
				sourcePath: metadata.path,
				sourceDigest: digest(content),
				backupPath: backup,
			},
		},
	});
	for (const entry of entries) {
		const { parentId: _parentId, seq: _seq, timestamp: _timestamp, ...provisioned } = entry;
		await session.appendEntry(provisioned, "main");
	}
}

function legacyEntries(filePath: string): { header: SessionHeader; entries: Entry[] } | undefined {
	const fileEntries = loadEntriesFromFile(filePath);
	const header = fileEntries.find((entry): entry is SessionHeader => entry.type === "session");
	if (!header) return undefined;
	const entries = fileEntries.flatMap((entry): Entry[] => {
		if (entry.type !== "message") return [];
		const message = entry.message;
		const provisioned: Extract<ProvisionedEntry, { type: "message" }> = {
			id: entry.id,
			type: "message",
			message,
		};
		return [provisioned as Entry];
	});
	return { header, entries };
}

export async function importLegacySessions(options: LegacySessionImportOptions): Promise<LegacySessionImportResult> {
	const rootResult = await options.fs.absolutePath(options.sessionsRoot);
	if (!rootResult.ok) throw new Error(rootResult.error.message);
	const root = rootResult.value;
	const existsResult = await options.fs.exists(root);
	if (!existsResult.ok) throw new Error(existsResult.error.message);
	if (!existsResult.value) return { imported: 0, skipped: 0, failed: 0 };

	const existingIds = new Set((await options.repository.list()).map((item) => item.id));
	const imported: LegacySessionImportResult = { imported: 0, skipped: 0, failed: 0 };
	const legacyRepository = new JsonlSessionRepo({ fs: options.fs, sessionsRoot: root });
	const metadataByPath = new Map((await legacyRepository.list()).map((metadata) => [metadata.path, metadata]));
	const directoriesResult = await options.fs.listDir(root);
	if (!directoriesResult.ok) throw new Error(directoriesResult.error.message);
	for (const directory of directoriesResult.value.filter((item) => item.kind === "directory")) {
		const filesResult = await options.fs.listDir(directory.path);
		if (!filesResult.ok) throw new Error(filesResult.error.message);
		for (const file of filesResult.value.filter(
			(item) => item.kind !== "directory" && item.name.endsWith(".jsonl"),
		)) {
			const contentResult = await options.fs.readTextFile(file.path);
			if (!contentResult.ok) {
				imported.failed++;
				continue;
			}
			const currentMetadata = metadataByPath.get(file.path);
			const legacy = currentMetadata === undefined ? legacyEntries(file.path) : undefined;
			if (!currentMetadata && !legacy) {
				imported.failed++;
				continue;
			}
			const metadata: JsonlSessionMetadata = currentMetadata ?? {
				id: legacy!.header.id,
				createdAt: Date.parse(legacy!.header.timestamp),
				cwd: legacy!.header.cwd,
				path: file.path,
				modifiedAt: file.mtimeMs,
				sourceFormat: 3,
			};
			if (existingIds.has(metadata.id)) {
				imported.skipped++;
				continue;
			}
			const sourceDigest = digest(contentResult.value);
			const backup = await backupSource(file.path, sourceDigest);
			try {
				const entries =
					legacy?.entries ?? (await legacyRepository.open(metadata)).findEntries({ order: "oldestFirst" });
				await importSession(options.repository, metadata, await entries, contentResult.value, backup);
				const importedMetadata = (await options.repository.list()).find((item) => item.id === metadata.id);
				if (!importedMetadata) throw new Error(`Imported session is missing: ${metadata.id}`);
				await options.repository.verifyReopen();
				existingIds.add(metadata.id);
				imported.imported++;
			} catch {
				const partial = (await options.repository.list()).find((item) => item.id === metadata.id);
				if (partial) await options.repository.delete(partial).catch(() => undefined);
				imported.failed++;
			}
		}
	}
	return imported;
}

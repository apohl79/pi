import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { ClientDiagnosticSpool, mergeClientDiagnosticBundle } from "../src/diagnostics.ts";

describe("ClientDiagnosticSpool", () => {
	test("persists owner-only bounded records and resumes its cursor", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-client-diagnostics-"));
		const path = join(directory, "logs", "client.jsonl");
		const first = new ClientDiagnosticSpool({ path, clientInstanceId: "client-1", maxEntries: 2 });
		await first.append({ event: "client.connecting", fields: { secret: "not-in-this-test" } });
		await first.append({ event: "client.connected" });
		await first.append({ event: "client.disconnected" });

		expect(await first.latestSeq()).toBe(3);
		expect(await first.read(1)).toMatchObject([
			{ seq: 2, event: "client.connected" },
			{ seq: 3, event: "client.disconnected" },
		]);
		expect((await stat(path)).mode & 0o077).toBe(0);
		expect((await readFile(path, "utf8")).split("\n")).toHaveLength(3);

		const reopened = new ClientDiagnosticSpool({ path, clientInstanceId: "client-1", maxEntries: 2 });
		expect(await reopened.read()).toMatchObject([{ seq: 2 }, { seq: 3 }]);
	});

	test("uses independent cursors for different client identities", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-client-diagnostics-"));
		const path = join(directory, "client.jsonl");
		const spool = new ClientDiagnosticSpool({ path, clientInstanceId: "client-a" });
		await spool.append({ event: "a" });
		const other = new ClientDiagnosticSpool({ path, clientInstanceId: "client-b" });
		expect(await other.latestSeq()).toBe(0);
	});

	test("rotates bounded client logs and replays retained records after restart", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-client-diagnostics-rotating-"));
		const path = join(directory, "client.jsonl");
		const first = new ClientDiagnosticSpool({ path, clientInstanceId: "client-1", maxBytes: 180, maxFiles: 3 });
		await first.append({ event: "one", fields: { value: "first" } });
		await first.append({ event: "two", fields: { value: "second" } });
		await first.append({ event: "three", fields: { value: "third" } });
		const reopened = new ClientDiagnosticSpool({ path, clientInstanceId: "client-1", maxBytes: 180, maxFiles: 3 });
		expect((await reopened.read()).map((record) => record.event)).toEqual(["one", "two", "three"]);
	});

	test("merges matching local records and clears the unavailable marker", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-client-diagnostics-merge-"));
		const spool = new ClientDiagnosticSpool({
			path: join(directory, "client.jsonl"),
			clientInstanceId: "client-merge",
		});
		await spool.append({ event: "client.connected" });
		const bundle = await mergeClientDiagnosticBundle(
			{
				manifest: { eventCount: 0, unavailable: ["client-diagnostic-spool"] },
				clientDiagnostics: {
					manifest: { clientInstanceId: "client-merge", runtime: "test", platform: "test", arch: "test" },
					afterSeq: 0,
				},
			},
			spool,
		);

		expect(bundle.clientDiagnostics).toMatchObject({
			records: [expect.objectContaining({ event: "client.connected", seq: 1 })],
			afterSeq: 1,
		});
		expect((bundle.manifest as { unavailable?: readonly string[] }).unavailable).toBeUndefined();
	});

	test("does not attach local records without a matching server identity", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-client-diagnostics-mismatch-"));
		const spool = new ClientDiagnosticSpool({
			path: join(directory, "client.jsonl"),
			clientInstanceId: "client-local",
		});
		await spool.append({ event: "client.connected" });

		const bundle = await mergeClientDiagnosticBundle(
			{ manifest: { eventCount: 0 }, clientDiagnostics: { afterSeq: 0 } },
			spool,
		);

		expect(bundle.clientDiagnostics).toMatchObject({ afterSeq: 0 });
		expect(bundle.clientDiagnostics).not.toHaveProperty("records");
		expect((bundle.manifest as { unavailable?: readonly string[] }).unavailable).toEqual(["client-diagnostic-spool"]);
	});

	test("redacts secret-shaped fields before persisting client evidence", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-client-diagnostics-redaction-"));
		const path = join(directory, "client.jsonl");
		const spool = new ClientDiagnosticSpool({ path, clientInstanceId: "client-redaction" });
		const apiKeyField = ["api", "key"].join("_");
		const apiKeyValue = ["sk", "1234567890abcdef"].join("-");
		await spool.append({
			event: "client.failure",
			fields: {
				authorization: "Bearer super-secret",
				message: [apiKeyField, apiKeyValue].join("="),
				nested: { password: "p@ssword", safe: "kept" },
			},
		});

		expect(await spool.read()).toMatchObject([
			{
				fields: {
					authorization: "[redacted]",
					message: "[redacted]",
					nested: { password: "[redacted]", safe: "kept" },
				},
			},
		]);
		expect(await readFile(path, "utf8")).not.toContain("super-secret");
	});
});

import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { ClientDiagnosticSpool } from "../src/diagnostics.ts";

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
});

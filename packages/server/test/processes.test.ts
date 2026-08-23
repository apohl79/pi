import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { InMemoryV2ProcessRegistry, JsonlV2ProcessRegistry, NodeV2ProcessRegistry } from "../src/processes.ts";

describe("InMemoryV2ProcessRegistry", () => {
	test("keeps bounded cursor-based output and explicit terminal state", async () => {
		const registry = new InMemoryV2ProcessRegistry({ maxOutputBytes: 5 });
		const started = await registry.start({ sessionId: "session-1", command: "demo" });
		await registry.write(started.processId, "abcdef");

		expect(await registry.read(started.processId, 0)).toMatchObject({ output: "bcdef", cursor: 6, truncated: true });
		await registry.terminate(started.processId);
		expect(await registry.wait(started.processId)).toMatchObject({ state: "terminated" });
	});

	test("resolves in-memory waiters only after a terminal transition", async () => {
		const registry = new InMemoryV2ProcessRegistry();
		const started = await registry.start({ sessionId: "session-wait", command: "demo" });
		let settled = false;
		const waiting = registry.wait(started.processId).then((snapshot) => {
			settled = true;
			return snapshot;
		});

		await Promise.resolve();
		expect(settled).toBe(false);
		await registry.terminate(started.processId);
		expect(await waiting).toMatchObject({ state: "terminated", exitCode: 143 });
	});

	test("closes in-memory stdin when EOF is requested", async () => {
		const registry = new InMemoryV2ProcessRegistry();
		const started = await registry.start({ sessionId: "session-eof", command: "demo" });

		await registry.write(started.processId, "input", { eof: true });
		await expect(registry.write(started.processId, "later")).rejects.toThrow("input is closed");
	});

	test("marks running in-memory processes lost after an unclean daemon generation", async () => {
		const registry = new InMemoryV2ProcessRegistry();
		const started = await registry.start({ sessionId: "session-recovery", command: "demo" });

		expect(await registry.markLost()).toBe(1);
		expect(await registry.wait(started.processId)).toMatchObject({ state: "lost" });
		expect(await registry.markLost()).toBe(0);
	});

	test("keeps UTF-8 byte cursors aligned across multibyte output", async () => {
		const registry = new InMemoryV2ProcessRegistry({ maxOutputBytes: 5 });
		const started = await registry.start({ sessionId: "session-unicode", command: "demo" });
		await registry.write(started.processId, "α🙂z");

		expect(await registry.getSnapshot(started.processId)).toMatchObject({
			output: "🙂z",
			cursor: 7,
			truncated: true,
		});
		expect(await registry.read(started.processId, 2)).toMatchObject({ output: "🙂z", cursor: 7 });
		expect(await registry.read(started.processId, 3)).toMatchObject({ output: "z", cursor: 7 });
	});

	test("runs a node-backed process without tying it to a client connection", async () => {
		const registry = new NodeV2ProcessRegistry();
		const started = await registry.start({
			sessionId: "session-1",
			command: `${JSON.stringify(process.execPath)} -e "process.stdout.write('hello')"`,
		});
		const completed = await registry.wait(started.processId);

		expect(completed).toMatchObject({ state: "exited", exitCode: 0, output: "hello", cursor: 5 });
	});

	test("reports Node output cursors in UTF-8 bytes", async () => {
		const registry = new NodeV2ProcessRegistry();
		const started = await registry.start({
			sessionId: "session-node-unicode",
			command: `${JSON.stringify(process.execPath)} -e "process.stdout.write('🙂z')"`,
		});
		const completed = await registry.wait(started.processId);

		expect(completed).toMatchObject({ output: "🙂z", cursor: 5, exitCode: 0 });
		expect(await registry.read(started.processId, 0)).toMatchObject({ output: "🙂z", cursor: 5 });
		expect(await registry.read(started.processId, 1)).toMatchObject({ output: "z", cursor: 5 });
	});

	test("sends EOF to a node-backed process", async () => {
		const registry = new NodeV2ProcessRegistry();
		const started = await registry.start({
			sessionId: "session-node-eof",
			command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("process.stdin.on('data', d => process.stdout.write(d));")}`,
		});

		await registry.write(started.processId, "hello", { eof: true });
		expect(await registry.wait(started.processId)).toMatchObject({ state: "exited", output: "hello" });
		await expect(registry.write(started.processId, "later")).rejects.toThrow("input is closed");
	});

	test("terminates a detached Node process through its process group", async () => {
		const registry = new NodeV2ProcessRegistry();
		const started = await registry.start({
			sessionId: "session-terminate",
			command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("setInterval(() => {}, 1000)")}`,
		});

		expect((await registry.terminate(started.processId)).state).toBe("terminated");
		expect(await registry.wait(started.processId)).toMatchObject({ state: "terminated", exitCode: 143 });
	});

	test("marks a running Node process lost and resolves waiters", async () => {
		const registry = new NodeV2ProcessRegistry();
		const started = await registry.start({
			sessionId: "session-recovery",
			command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("setInterval(() => {}, 1000)")}`,
		});

		const waiting = registry.wait(started.processId);
		expect(await registry.markLost()).toBe(1);
		expect(await waiting).toMatchObject({ state: "lost" });
		expect(await registry.getSnapshot(started.processId)).toMatchObject({ state: "lost" });
	});

	test("reloads running process metadata and marks it lost in a new registry", async () => {
		const directory = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "pi-process-journal-"));
		try {
			const path = join(directory, "processes.jsonl");
			const first = new JsonlV2ProcessRegistry(path, new InMemoryV2ProcessRegistry());
			const started = await first.start({ sessionId: "session-persistent", command: "demo" });

			const second = new JsonlV2ProcessRegistry(path, new InMemoryV2ProcessRegistry());
			expect(await second.markLost()).toBe(1);
			expect(await second.getSnapshot(started.processId)).toMatchObject({ state: "lost", command: "demo" });
			expect(await second.wait(started.processId)).toMatchObject({ state: "lost" });
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("parses quoted argv without shell expansion and rejects shell syntax", async () => {
		const registry = new NodeV2ProcessRegistry();
		const started = await registry.start({
			sessionId: "session-argv",
			command: `${JSON.stringify(process.execPath)} -e "process.stdout.write(process.argv[1])" "quoted value"`,
		});
		expect(await registry.wait(started.processId)).toMatchObject({ output: "quoted value", exitCode: 0 });
		await expect(
			registry.start({ sessionId: "session-argv", command: "printf safe; touch should-not-exist" }),
		).rejects.toThrow("shell metacharacters");
	});

	test("routes PTY-mode commands through the injected host terminal adapter", async () => {
		let launches = 0;
		const registry = new NodeV2ProcessRegistry({
			ptyLauncher: {
				spawn: (request) => {
					launches += 1;
					return spawn(request.command, { shell: true, stdio: ["pipe", "pipe", "pipe"] });
				},
			},
		});
		const started = await registry.start({
			sessionId: "session-pty",
			command: `${JSON.stringify(process.execPath)} -e "process.stdout.write('pty-output')"`,
			pty: true,
		});
		const completed = await registry.wait(started.processId);

		expect(started.pty).toBe(true);
		expect(completed.state).toBe("exited");
		expect(completed.output).toContain("pty-output");
		expect(launches).toBe(1);
	});
});

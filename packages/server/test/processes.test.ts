import { spawn } from "node:child_process";
import { describe, expect, test } from "vitest";
import { InMemoryV2ProcessRegistry, NodeV2ProcessRegistry } from "../src/processes.ts";

describe("InMemoryV2ProcessRegistry", () => {
	test("keeps bounded cursor-based output and explicit terminal state", async () => {
		const registry = new InMemoryV2ProcessRegistry({ maxOutputBytes: 5 });
		const started = await registry.start({ sessionId: "session-1", command: "demo" });
		await registry.write(started.processId, "abcdef");

		expect(await registry.read(started.processId, 0)).toMatchObject({ output: "bcdef", cursor: 6, truncated: true });
		await registry.terminate(started.processId);
		expect(await registry.wait(started.processId)).toMatchObject({ state: "terminated" });
	});

	test("wait remains pending until termination and preserves UTF-8 byte cursors", async () => {
		const registry = new InMemoryV2ProcessRegistry({ maxOutputBytes: 4 });
		const started = await registry.start({ sessionId: "session-1", command: "demo" });
		let settled = false;
		const pending = registry.wait(started.processId).then(() => { settled = true; });
		await Promise.resolve();
		expect(settled).toBe(false);
		await registry.write(started.processId, "a🙂");
		expect(await registry.read(started.processId, 0)).toMatchObject({ output: "🙂", cursor: 5, truncated: true });
		await registry.terminate(started.processId);
		await pending;
		expect(settled).toBe(true);
	});

	test("does not split retained UTF-8 output when reading from an interior cursor", async () => {
		const registry = new InMemoryV2ProcessRegistry({ maxOutputBytes: 8 });
		const started = await registry.start({ sessionId: "session-1", command: "demo" });
		await registry.write(started.processId, "🙂a");

		expect(await registry.read(started.processId, 1)).toMatchObject({ output: "a", cursor: 5, truncated: false });
	});

	test("rejects unsupported PTY and shell command requests", async () => {
		const registry = new NodeV2ProcessRegistry();
		const invalidCommand = registry.start({ sessionId: "session-1", command: "echo ok; touch /tmp/unsafe" });
		expect(invalidCommand).toBeInstanceOf(Promise);
		await expect(invalidCommand).rejects.toThrow("Unsupported process command");
		await expect(registry.start({ sessionId: "session-1", command: "echo ok", pty: true })).rejects.toThrow("PTY");
	});

	test("validates active-process and write limits", async () => {
		expect(() => new NodeV2ProcessRegistry({ maxActiveProcesses: 0 })).toThrow("maxActiveProcesses");
		expect(() => new NodeV2ProcessRegistry({ maxWriteBytes: 0 })).toThrow("maxWriteBytes");
		expect(() => new NodeV2ProcessRegistry({ maxQueuedWriteBytes: 0 })).toThrow("maxQueuedWriteBytes");
		const registry = new NodeV2ProcessRegistry({ maxWriteBytes: 3 });
		const started = await registry.start({ sessionId: "session-1", command: `${JSON.stringify(process.execPath)} -e "setTimeout(function(){},1000000)"` });
		await expect(registry.write(started.processId, "🙂")).rejects.toThrow("maxWriteBytes");
		await registry.terminate(started.processId);
	});

	test("rejects writes that would exceed the queued byte budget", async () => {
		const registry = new NodeV2ProcessRegistry({ maxWriteBytes: 1024, maxQueuedWriteBytes: 2048 });
		const started = await registry.start({ sessionId: "session-1", command: `${JSON.stringify(process.execPath)} -e "process.stdin.pause(); setTimeout(function(){},1000000)"` });
		const input = "x".repeat(1024);
		const first = registry.write(started.processId, input);
		const second = registry.write(started.processId, input);
		await expect(registry.write(started.processId, input)).rejects.toThrow("maxQueuedWriteBytes");
		await registry.terminate(started.processId);
		await Promise.allSettled([first, second]);
	});

	test("enforces active-process limit and releases capacity after completion", async () => {
		const registry = new NodeV2ProcessRegistry({ maxActiveProcesses: 1 });
		const first = await registry.start({ sessionId: "session-1", command: `${JSON.stringify(process.execPath)} -e "setTimeout(function(){},1000000)"` });
		await expect(registry.start({ sessionId: "session-1", command: `${JSON.stringify(process.execPath)} -e "setTimeout(function(){},1000000)"` })).rejects.toThrow("Maximum active process limit");
		await registry.terminate(first.processId);
		await registry.wait(first.processId);
		const second = await registry.start({ sessionId: "session-1", command: `${JSON.stringify(process.execPath)} -e "process.stdout.write('ok')"` });
		await expect(registry.wait(second.processId)).resolves.toMatchObject({ state: "exited", output: "ok" });
	});

	test("releases active capacity when a child fails to start", async () => {
		const registry = new NodeV2ProcessRegistry({ maxActiveProcesses: 1 });
		const failed = await registry.start({ sessionId: "session-1", command: `${JSON.stringify(process.execPath)} -e "process.stdout.write('no')", cwd: "/path/that/does/not/exist"` });
		await expect(registry.wait(failed.processId)).resolves.toMatchObject({ state: "exited" });
		const recovered = await registry.start({ sessionId: "session-1", command: `${JSON.stringify(process.execPath)} -e "process.stdout.write('ok')"` });
		await expect(registry.wait(recovered.processId)).resolves.toMatchObject({ state: "exited", output: "ok" });
	});

	test("retains UTF-8 output when a code point spans stdout chunks", async () => {
		const registry = new NodeV2ProcessRegistry({ maxOutputBytes: 4 });
		const started = await registry.start({
			sessionId: "session-1",
			command: `${JSON.stringify(process.execPath)} -e 'process.stdout.write(Buffer.from([240,159])),setTimeout(function(){return process.stdout.write(Buffer.from([153,130]))},10)'`,
		});
		const completed = await registry.wait(started.processId);

		expect(completed).toMatchObject({ state: "exited", output: "🙂", cursor: 4, truncated: false });
	});

	test("flushes an incomplete UTF-8 sequence when the child closes", async () => {
		const registry = new NodeV2ProcessRegistry();
		const started = await registry.start({
			sessionId: "session-1",
			command: `${JSON.stringify(process.execPath)} -e 'process.stdout.write(Buffer.from([240,159]))'`,
		});
		const completed = await registry.wait(started.processId);

		expect(completed).toMatchObject({ state: "exited", output: "�", cursor: 3, truncated: false });
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

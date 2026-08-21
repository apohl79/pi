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

	test("resolves an existing wait when termination needs escalation", async () => {
		const registry = new NodeV2ProcessRegistry({ terminateGraceMs: 10, terminateTimeoutMs: 10 });
		const started = await registry.start({ sessionId: "session-1", command: `${JSON.stringify(process.execPath)} -e "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"` });
		const pending = registry.wait(started.processId);
		await registry.terminate(started.processId);
		await expect(pending).resolves.toMatchObject({ state: "terminated", exitCode: 143 });
	});

	test("retains only the configured number of completed process entries", async () => {
		const registry = new NodeV2ProcessRegistry({ maxCompletedProcesses: 1 });
		const first = await registry.start({ sessionId: "session-1", command: `${JSON.stringify(process.execPath)} -e "process.stdout.write('a')"` });
		await registry.wait(first.processId);
		const second = await registry.start({ sessionId: "session-1", command: `${JSON.stringify(process.execPath)} -e "process.stdout.write('b')"` });
		await registry.wait(second.processId);
		expect(await registry.read(second.processId, 0)).toMatchObject({ output: "b" });
		await expect(registry.read(first.processId, 0)).rejects.toThrow("Unknown process");
	});
});

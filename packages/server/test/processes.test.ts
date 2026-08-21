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

	test("rejects unsupported PTY and shell command requests", async () => {
		const registry = new NodeV2ProcessRegistry();
		await expect(registry.start({ sessionId: "session-1", command: "echo ok; touch /tmp/unsafe" })).rejects.toThrow("Unsupported process command");
		await expect(registry.start({ sessionId: "session-1", command: "echo ok", pty: true })).rejects.toThrow("PTY");
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
});

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

import { describe, expect, test } from "vitest";
import { StatuslineRunner } from "../src/server/statusline.ts";

describe("StatuslineRunner", () => {
	test("coalesces unchanged payloads and bounds successful output", async () => {
		let calls = 0;
		const runner = new StatuslineRunner({
			command: "statusline.sh",
			maxOutputBytes: 5,
			execute: async (_command, payload) => {
				calls += 1;
				return { stdout: `${payload}abcdef`, stderr: "", exitCode: 0 };
			},
		});
		const first = await runner.update({ session: "one" });
		const same = await runner.update({ session: "one" });
		expect(calls).toBe(1);
		expect(first.output).toHaveLength(5);
		expect(same).toEqual(first);
		const changed = await runner.update({ session: "two" });
		expect(calls).toBe(2);
		expect(changed.payloadHash).not.toBe(first.payloadHash);
	});

	test("reports bounded command failures and clears stale output on command changes", async () => {
		const runner = new StatuslineRunner({
			command: "first.sh",
			maxErrorBytes: 4,
			execute: async () => ({ stdout: "old", stderr: "failure details", exitCode: 2 }),
		});
		await runner.update({ value: 1 });
		expect(runner.snapshot).toMatchObject({ pending: false, error: "fail" });
		const changed = await runner.update({ value: 1 }, "second.sh");
		expect(changed).toMatchObject({ pending: false, error: "fail", command: "second.sh" });
		expect(changed.output).toBeUndefined();
	});

	test("times out and aborts a hanging command", async () => {
		let aborted = false;
		const runner = new StatuslineRunner({
			command: "hang.sh",
			timeoutMs: 5,
			execute: async (_command, _payload, signal) => {
				await new Promise<void>((resolve) =>
					signal.addEventListener("abort", () => {
						aborted = true;
						resolve();
					}),
				);
				return { stdout: "", stderr: "", exitCode: 0 };
			},
		});
		const result = await runner.update({ value: 1 });
		expect(result.error).toBe("statusline timeout");
		expect(aborted).toBe(true);
	});

	test("uses the first non-empty output line and supports argv commands", async () => {
		let received: string | readonly string[] | undefined;
		const runner = new StatuslineRunner({
			command: ["statusline", "--json"],
			execute: async (command) => {
				received = command;
				return { stdout: "\nfirst line\nsecond line", stderr: "", exitCode: 0 };
			},
		});
		const result = await runner.update({ session: "one" });
		expect(received).toEqual(["statusline", "--json"]);
		expect(result.output).toBe("first line");
	});
});

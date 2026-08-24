import { describe, expect, test } from "vitest";
import { StatuslineRunner } from "../src/server/statusline.ts";

describe("StatuslineRunner", () => {
	test("rejects invalid timeout and output bounds", () => {
		expect(() => new StatuslineRunner({ timeoutMs: 0 })).toThrow("timeoutMs");
		expect(() => new StatuslineRunner({ maxOutputBytes: 0 })).toThrow("maxOutputBytes");
		expect(() => new StatuslineRunner({ maxErrorBytes: Number.POSITIVE_INFINITY })).toThrow("maxErrorBytes");
	});

	test("coalesces identical requests and bounds output", async () => {
		let calls = 0;
		const runner = new StatuslineRunner({
			command: ["statusline"],
			maxOutputBytes: 4,
			execute: async () => {
				calls += 1;
				return { stdout: "abcdef\nsecond", stderr: "", exitCode: 0 };
			},
		});

		expect(await runner.update({ session: "one" })).toMatchObject({ output: "abcd", pending: false });
		expect(await runner.update({ session: "one" })).toMatchObject({ output: "abcd", pending: false });
		expect(calls).toBe(1);
	});

	test("does not publish a stale result after a newer request", async () => {
		let releaseFirst!: () => void;
		const first = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		let calls = 0;
		const runner = new StatuslineRunner({
			command: ["statusline"],
			execute: async (_command, payload) => {
				calls += 1;
				if (calls === 1) await first;
				return { stdout: payload.includes("two") ? "two" : "one", stderr: "", exitCode: 0 };
			},
		});

		const oldResult = runner.update({ value: "one" });
		const newResult = runner.update({ value: "two" });
		releaseFirst();
		expect(await newResult).toMatchObject({ output: "two", pending: false });
		expect((await oldResult).output).not.toBe("one");
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

	test("does not restore output when a disposed command resolves late", async () => {
		let resolvePending: ((result: { stdout: string; stderr: string; exitCode: number }) => void) | undefined;
		const runner = new StatuslineRunner({
			command: "statusline.sh",
			execute: async () =>
				new Promise((resolve) => {
					resolvePending = resolve;
				}),
		});
		const update = runner.update({ session: "dispose" });
		const dispose = runner.dispose();
		resolvePending?.({ stdout: "late", stderr: "", exitCode: 0 });
		await dispose;
		await update;
		expect(runner.snapshot).toEqual({ pending: false });
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

	test("bounds default child stdout and stderr collection by bytes", async () => {
		const runner = new StatuslineRunner({
			command: [
				process.execPath,
				"-e",
				"process.stdout.write('x'.repeat(100000)); process.stderr.write('e'.repeat(10000)); process.exit(2)",
			],
			maxOutputBytes: 32,
			maxErrorBytes: 16,
		});
		const result = await runner.update({ session: "bounded" });

		expect(result.output).toBeUndefined();
		expect(result.error).toHaveLength(16);
	});
});

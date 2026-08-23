import { describe, expect, test } from "vitest";
import { StatuslineRunner } from "../src/core/statusline-runner.ts";

describe("StatuslineRunner", () => {
	test("passes JSON on stdin, returns the first non-empty line, and caches unchanged inputs", async () => {
		const runner = new StatuslineRunner();
		const command = [
			process.execPath,
			"-e",
			"process.stdin.on('data', d => { const p=JSON.parse(d); console.log(''); console.log(p.session_id); })",
		] as const;
		expect(await runner.run(command, { session_id: "session-1" })).toEqual({
			status: "success",
			output: "session-1",
			cached: false,
		});
		expect(await runner.run(command, { session_id: "session-1" })).toEqual({
			status: "success",
			output: "session-1",
			cached: true,
		});
		runner.dispose();
	});

	test("bounds timeout and non-zero exit diagnostics", async () => {
		const runner = new StatuslineRunner({ timeoutMs: 100 });
		await expect(runner.run([process.execPath, "-e", "setTimeout(() => {}, 1000)"], {})).resolves.toMatchObject({
			status: "error",
			reason: "timeout",
		});
		await expect(
			runner.run([process.execPath, "-e", "console.error('failure'); process.exit(3)"], {}),
		).resolves.toEqual({
			status: "error",
			reason: "exit",
			message: "statusline command exited with code 3",
			stderr: "failure",
			cached: false,
		});
		runner.dispose();
	});

	test("rejects empty output and clears active commands on dispose", async () => {
		const runner = new StatuslineRunner();
		await expect(runner.run([process.execPath, "-e", "process.stdout.write('\\n')"], {})).resolves.toMatchObject({
			status: "error",
			reason: "output",
		});
		runner.dispose();
		await expect(runner.run("echo ignored", {})).rejects.toThrow("disposed");
	});
});

import { describe, expect, test, vi } from "vitest";
import type { ExperimentalCliContext } from "../src/cli/experimental/cli.ts";
import { dispatchExperimentalCommand, isExperimentalCommand } from "../src/cli/experimental/dispatch.ts";

function context(): ExperimentalCliContext {
	return {
		runPi: vi.fn(),
		runServer: vi.fn(),
		runClient: vi.fn(),
		runDiagnostics: vi.fn(),
		runAttach: vi.fn(),
		runSessions: vi.fn(),
	};
}

describe("experimental CLI dispatch", () => {
	test.each([
		["server", true],
		["client", true],
		["attach", true],
		["sessions", true],
		["--model", false],
		[undefined, false],
	] as const)("recognizes %s as %s", (command, expected) => {
		expect(isExperimentalCommand(command === undefined ? [] : [command])).toBe(expected);
	});

	test("dispatches recognized commands without entering legacy parsing", async () => {
		const handlers = context();
		expect(await dispatchExperimentalCommand(["server", "status"], handlers)).toBe(true);
		expect(handlers.runServer).toHaveBeenCalledWith({ command: "server", action: "status" });
	});

	test("reports command errors and does not execute a handler", async () => {
		const handlers = context();
		const errors: string[] = [];
		expect(
			await dispatchExperimentalCommand(["sessions", "unexpected"], handlers, (message) => errors.push(message)),
		).toBe(true);
		expect(errors).toEqual(["sessions does not accept positional arguments"]);
		expect(handlers.runSessions).not.toHaveBeenCalled();
	});

	test("leaves legacy arguments unhandled", async () => {
		const handlers = context();
		expect(await dispatchExperimentalCommand(["--model", "gpt-5"], handlers)).toBe(false);
		expect(handlers.runPi).not.toHaveBeenCalled();
	});
});

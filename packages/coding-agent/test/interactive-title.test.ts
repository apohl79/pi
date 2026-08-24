import { describe, expect, test } from "vitest";
import { APP_TITLE } from "../src/config.ts";
import { formatInteractiveTerminalTitle } from "../src/modes/interactive/components/interactive-title.ts";

describe("formatInteractiveTerminalTitle", () => {
	test("keeps direct and server session names in the terminal title", () => {
		expect(formatInteractiveTerminalTitle("/workspace/pi", "Generated task")).toBe(
			`${APP_TITLE} - Generated task - pi`,
		);
	});

	test("uses the working-directory title before a session receives a name", () => {
		expect(formatInteractiveTerminalTitle("/workspace/pi", undefined)).toBe(`${APP_TITLE} - pi`);
	});
});

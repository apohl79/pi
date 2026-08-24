import { beforeAll, describe, expect, test } from "vitest";
import { createInteractiveStartupHeader } from "../src/modes/interactive/components/startup-header.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

beforeAll(() => initTheme(undefined, false));

describe("interactive startup header", () => {
	test("uses the same compact and expanded card in every interactive transport", () => {
		const header = createInteractiveStartupHeader({ version: "test", expanded: false });
		expect(stripAnsi(header.render(120).join("\n"))).toContain("Pi can explain its own features");
		expect(stripAnsi(header.render(120).join("\n"))).not.toContain("drop files");

		header.setExpanded(true);
		expect(stripAnsi(header.render(120).join("\n"))).toContain("drop files");
	});
});

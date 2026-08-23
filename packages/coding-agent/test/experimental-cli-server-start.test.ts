import { describe, expect, test } from "vitest";
import { experimentalCli } from "../src/cli/experimental/cli.ts";

describe("experimental server start command", () => {
	test("preserves explicit listener addresses", () => {
		expect(experimentalCli.parse(["server", "start", "--listen", "unix:///tmp/pi.sock"])).toEqual({
			ok: true,
			command: { command: "server", action: "start", listen: [{ transport: "unix", path: "/tmp/pi.sock" }] },
		});
	});
});

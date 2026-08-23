import { describe, expect, it } from "vitest";
import * as client from "../../src/client/index.ts";

describe("public coding-agent client entry", () => {
	it("exports the server-owned v2 session surface", () => {
		expect(client.PiClientV2).toBeDefined();
		expect(client.createUnixTransportFactory).toBeDefined();
		expect(client.RemoteV2Session).toBeDefined();
		expect(client.RemoteV2SessionSelector).toBeDefined();
		expect(client.RemoteV2InteractiveAttachment).toBeDefined();
		expect(client.RemoteV2SessionView).toBeDefined();
	});
});

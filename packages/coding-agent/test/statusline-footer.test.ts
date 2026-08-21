import { beforeAll, describe, expect, test } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { ReadonlyFooterDataProvider } from "../src/core/footer-data-provider.ts";
import { FooterComponent } from "../src/modes/interactive/components/footer.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { StatuslineRunner } from "../src/server/statusline.ts";

function createSession(): AgentSession {
	return {
		state: {
			model: { id: "test-model", name: "Test Model", provider: "test", contextWindow: 200_000, reasoning: false },
			thinkingLevel: "off",
		},
		sessionId: "session-1",
		isStreaming: false,
		sessionManager: {
			getEntries: () => [],
			getSessionName: () => "test",
			getSessionFile: () => undefined,
			getCwd: () => "/tmp/project",
		},
		getContextUsage: () => ({ contextWindow: 200_000, percent: 12.3 }),
		modelRuntime: { isUsingSubscription: () => false },
	} as unknown as AgentSession;
}

const footerData: ReadonlyFooterDataProvider = {
	getGitBranch: () => null,
	getExtensionStatuses: () => new Map(),
	getAvailableProviderCount: () => 1,
	onBranchChange: () => () => {},
};

describe("local statusline footer", () => {
	beforeAll(() => initTheme(undefined, false));

	test("renders bounded local statusline output after the runner resolves", async () => {
		let payload: unknown;
		let updated!: () => void;
		const settled = new Promise<void>((resolve) => {
			updated = resolve;
		});
		const runner = new StatuslineRunner({
			command: "statusline.sh",
			execute: async (_command, receivedPayload) => {
				payload = JSON.parse(receivedPayload);
				return { stdout: "custom status", stderr: "", exitCode: 0 };
			},
		});
		const footer = new FooterComponent(createSession(), footerData, {
			runner,
			command: "statusline.sh",
			onUpdated: updated,
		});

		footer.render(120);
		await settled;
		expect(footer.render(120)).toContain("custom status");
		expect(payload).toMatchObject({ harness: "pi", session_id: "session-1", cwd: "/tmp/project" });
		footer.dispose();
	});
});

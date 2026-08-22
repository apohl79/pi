import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, type FauxResponseFactory, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { PiClientV2 } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";
import { afterEach, describe, expect, test } from "vitest";
import { RemoteV2Session } from "../../src/client/remote-v2-session.ts";
import { createConfiguredCodingAgentDaemonRuntime } from "../../src/server/daemon-runtime.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("production daemon three-provider routing", () => {
	test("keeps root, child, and role models independently resolved", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-daemon-three-provider-routing-"));
		directories.push(directory);
		const models = createModels();
		const observed: string[] = [];
		const reviewerTools: string[][] = [];
		const rootPrompts: string[] = [];
		const root = fauxProvider({
			provider: "coding-agent-daemon-three-root-faux",
			models: [
				{ id: "root-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 },
				{ id: "root-follow-up-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 },
			],
		});
		const child = fauxProvider({
			provider: "coding-agent-daemon-three-child-faux",
			models: [{ id: "child-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		const reviewer = fauxProvider({
			provider: "coding-agent-daemon-three-reviewer-faux",
			models: [{ id: "reviewer-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		for (const provider of [root, child, reviewer]) models.setProvider(provider.provider);
		const record =
			(label: string, message: string): FauxResponseFactory =>
			(context, _options, _state, model) => {
				if (label === "root") rootPrompts.push(JSON.stringify(context.messages));
				observed.push(`${label}:${model.provider}/${model.id}`);
				return fauxAssistantMessage(message);
			};
		root.setResponses([
			record("root", "root response"),
			record("root", "root follow-up"),
			record("root", "root final response"),
		]);
		child.setResponses([record("child", "child response")]);
		reviewer.setResponses([
			(context, _options, _state, model) => {
				reviewerTools.push((context.tools ?? []).map((tool) => tool.name));
				observed.push(`reviewer:${model.provider}/${model.id}`);
				return fauxAssistantMessage("review response");
			},
		]);
		const socketPath = join(directory, "server.sock");
		const runtime = await createConfiguredCodingAgentDaemonRuntime({
			agentDir: directory,
			cwd: directory,
			models,
			model: root.getModel("root-model")!,
			socketPath,
			agentRoles: {
				reviewer: {
					instructions: "Review the change.",
					toolNames: ["read"],
					model: { provider: reviewer.provider.id, id: "reviewer-model" },
				},
			},
			harness: { activeToolNames: ["read", "write"] },
			write: () => {},
		});
		const client = new PiClientV2({ transportFactory: createUnixTransportFactory({ path: socketPath }) });
		try {
			await runtime.daemon.start();
			await client.connect();
			const session = await RemoteV2Session.create(client, { cwd: directory }, { mode: "control" });
			try {
				await session.setAutoName(false);
				const first = await session.submit("root request");
				await session.waitForOperation(first);
				const transcriptBeforeSwitch = session.snapshot?.transcript;
				expect({ provider: child.provider.id, id: "child-model" }).toEqual({
					provider: "coding-agent-daemon-three-child-faux",
					id: "child-model",
				});
				const childAgent = await session.spawnAgent("child", "child request", {
					model: { provider: child.provider.id, id: "child-model" },
				});
				await session.waitAgent(childAgent.id);
				const reviewerAgent = await session.spawnAgent("reviewer", "review request", { role: "reviewer" });
				await session.waitAgent(reviewerAgent.id);
				const switchOperation = await session.setModel({ provider: root.provider.id, id: "root-follow-up-model" });
				await session.waitForOperation(switchOperation);
				expect(session.snapshot?.transcript).toEqual(transcriptBeforeSwitch);
				const second = await session.submit("follow-up request");
				await session.waitForOperation(second);
				const third = await session.submit("final request");
				await session.waitForOperation(third);
				expect(observed).toEqual([
					`root:${root.provider.id}/root-model`,
					`child:${child.provider.id}/child-model`,
					`reviewer:${reviewer.provider.id}/reviewer-model`,
					`root:${root.provider.id}/root-follow-up-model`,
					`root:${root.provider.id}/root-follow-up-model`,
				]);
				expect(reviewerTools).toEqual([["read"]]);
				expect(rootPrompts[1]).toContain("[child agent completions]");
				expect(rootPrompts[1]).toContain("/root/child (complete)");
				expect(rootPrompts[1]).toContain("/root/reviewer (complete)");
				expect(rootPrompts[1].match(/\[child agent completions\]/g)).toHaveLength(1);
				expect(rootPrompts[2].match(/\[child agent completions\]/g)).toHaveLength(1);
			} finally {
				await session.dispose();
			}
		} finally {
			client.dispose();
			await runtime.close();
		}
	});
});

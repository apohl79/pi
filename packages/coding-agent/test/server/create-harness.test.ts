import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AgentHarness,
	type AgentHarnessOptions,
	type ExecutionError,
	type HarnessTool,
	InMemorySessionStorage,
	type Result,
	Session,
	type ShellExecOptions,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { InMemoryV2ProcessRegistry } from "@earendil-works/pi-server";
import { Type } from "typebox";
import { describe, expect, test, vi } from "vitest";
import {
	buildCodingAgentHarnessSystemPrompt,
	type CodingAgentHarnessTool,
	createCodingAgentHarness,
} from "../../src/server/create-harness.ts";
import { ModelInstructionResolver } from "../../src/server/model-instructions.ts";

class CapturingExecutionEnv extends NodeExecutionEnv {
	executionOverrides: Record<string, string> | undefined;

	override async exec(
		command: string,
		options?: ShellExecOptions,
	): Promise<Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>> {
		this.executionOverrides = options?.env;
		return super.exec(command, options);
	}
}

async function resolveSystemPrompt(systemPrompt: AgentHarnessOptions["systemPrompt"]): Promise<string> {
	if (typeof systemPrompt === "string") return systemPrompt;
	if (systemPrompt === undefined) throw new Error("Expected a system prompt callback");
	return systemPrompt();
}

function createPromptTool(name: string, promptSnippet?: string, promptGuidelines?: string[]): CodingAgentHarnessTool {
	return {
		name,
		label: name,
		description: `${name} description`,
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: "ok" }], details: undefined }),
		promptSnippet,
		promptGuidelines,
	};
}

const defaultPromptTools = [
	createPromptTool("read", "Read file contents", ["Use read to examine files instead of cat or sed."]),
	createPromptTool("bash", "Execute bash commands (ls, grep, find, etc.)", [
		"You can inspect PI_* environment variables for current model and session details.",
	]),
	createPromptTool("edit", "Edit files", ["Edit carefully."]),
	createPromptTool("write", "Create or overwrite files", ["Use write only for new files or complete rewrites."]),
];

describe("coding-agent Harness construction", () => {
	test("resolves exact model instruction profiles with bounded provenance", async () => {
		const resolver = new ModelInstructionResolver(
			[{ id: "luna", provider: "google", model: "gemini-2.5-flash", mode: "append", text: "Use Luna style." }],
			{ cwd: "/workspace" },
		);
		const resolved = await resolver.resolve({ provider: "google", id: "gemini-2.5-flash" });
		expect(resolved).toMatchObject({ id: "luna", source: "text", mode: "append", text: "Use Luna style." });
		expect(resolved?.contentHash).toMatch(/^[a-f0-9]{64}$/);
		expect(await resolver.resolve({ provider: "openai", id: "gpt-5" })).toBeUndefined();
	});

	test("resolves model instruction profiles independently by agent scope", async () => {
		const resolver = new ModelInstructionResolver(
			[
				{
					id: "root-profile",
					provider: "openai",
					model: "gpt-5",
					mode: "append",
					text: "Root instructions.",
					applyTo: ["root"],
				},
				{
					id: "child-profile",
					provider: "openai",
					model: "gpt-5",
					mode: "append",
					text: "Child instructions.",
					applyTo: ["subagent"],
				},
			],
			{ cwd: "/workspace" },
		);
		expect(await resolver.resolve({ provider: "openai", id: "gpt-5" }, "root")).toMatchObject({
			id: "root-profile",
		});
		expect(await resolver.resolve({ provider: "openai", id: "gpt-5" }, "subagent")).toMatchObject({
			id: "child-profile",
		});
	});

	test("resolves file-backed profiles through canonical trusted roots", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-model-profile-success-"));
		try {
			await writeFile(join(directory, "profile.md"), "Use deterministic edits.");
			const resolver = new ModelInstructionResolver(
				[{ id: "file-profile", provider: "openai", model: "gpt-5", mode: "append", file: "profile.md" }],
				{ cwd: directory },
			);
			expect(await resolver.resolve({ provider: "openai", id: "gpt-5" })).toMatchObject({
				id: "file-profile",
				source: "file",
				text: "Use deterministic edits.",
			});
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("reports model profile identity when a file cannot be read", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-model-profile-file-"));
		try {
			const resolver = new ModelInstructionResolver(
				[{ id: "missing-profile", provider: "openai", model: "gpt-5", mode: "append", file: "missing.md" }],
				{ cwd: directory },
			);
			await expect(resolver.resolve({ provider: "openai", id: "gpt-5" })).rejects.toThrow(
				"Model profile missing-profile file cannot be read",
			);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("rejects model profile files outside trusted roots", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-model-profile-trust-"));
		const outside = await mkdtemp(join(tmpdir(), "pi-model-profile-outside-"));
		try {
			await writeFile(join(outside, "profile.md"), "Do not cross the trust boundary.");
			const resolver = new ModelInstructionResolver(
				[
					{
						id: "untrusted-profile",
						provider: "openai",
						model: "gpt-5",
						mode: "append",
						file: join(outside, "profile.md"),
					},
				],
				{ cwd: directory },
			);
			await expect(resolver.resolve({ provider: "openai", id: "gpt-5" })).rejects.toThrow(
				"Model profile untrusted-profile file is outside trusted roots",
			);
		} finally {
			await rm(directory, { recursive: true, force: true });
			await rm(outside, { recursive: true, force: true });
		}
	});

	test("rejects oversized model profile files before loading them", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-model-profile-size-"));
		try {
			await writeFile(join(directory, "profile.md"), "0123456789");
			const canonicalDirectory = await realpath(directory);
			const resolver = new ModelInstructionResolver(
				[{ id: "large-profile", provider: "openai", model: "gpt-5", mode: "append", file: "profile.md" }],
				{ cwd: canonicalDirectory, maxBytes: 5 },
			);
			await expect(resolver.resolve({ provider: "openai", id: "gpt-5" })).rejects.toThrow(
				"Model profile large-profile exceeds 5-byte limit",
			);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("adds a model profile without changing the selected tool contract", () => {
		const prompt = buildCodingAgentHarnessSystemPrompt({
			cwd: "/workspace",
			tools: defaultPromptTools,
			activeToolNames: ["read", "bash"],
			modelInstruction: {
				id: "profile",
				source: "text",
				mode: "append",
				text: "Prefer deterministic edits.",
				contentHash: "hash",
				byteLength: 25,
			},
		});
		expect(prompt).toContain("Prefer deterministic edits.");
		expect(prompt).toContain("- read: Read file contents");
		expect(prompt).not.toContain("- edit: Edit files");
	});

	test("exposes and executes Pi's filesystem search tools in the server-owned defaults", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-harness-filesystem-tools-"));
		await writeFile(join(directory, "fixture.txt"), "server-owned tools\n");
		const session = new Session(new InMemorySessionStorage({ id: "filesystem-tools-session", createdAt: 1 }));
		const env = new NodeExecutionEnv({ cwd: directory });
		const created = await createCodingAgentHarness({
			session,
			models: createModels(),
			model: getModel("google", "gemini-2.5-flash"),
			env,
		});
		try {
			const tools = await created.harness.getTools();
			expect(tools.map((tool) => tool.name)).toEqual([
				"apply_patch",
				"read",
				"bash",
				"edit",
				"write",
				"grep",
				"find",
				"ls",
			]);
			const ls = tools.find((tool) => tool.name === "ls");
			if (!ls) throw new Error("Expected ls tool");
			const result = await ls.execute("ls-call", {});
			expect(result.content).toEqual([{ type: "text", text: "fixture.txt" }]);
		} finally {
			await created.harness.close();
			await env.cleanup();
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("replaceDefault preserves tool, project-context, and role layers", () => {
		const prompt = buildCodingAgentHarnessSystemPrompt({
			cwd: "/workspace",
			tools: defaultPromptTools,
			activeToolNames: ["read"],
			systemPromptOptions: {
				contextFiles: [{ path: "AGENTS.md", content: "Keep changes focused." }],
				appendSystemPrompt: "Role: reviewer.",
			},
			modelInstruction: {
				id: "profile",
				source: "text",
				mode: "replaceDefault",
				text: "You are a concise reviewer.",
				contentHash: "hash",
				byteLength: 28,
			},
		});

		expect(prompt).toContain("You are a concise reviewer.");
		expect(prompt).not.toContain("You are an expert coding assistant operating inside pi");
		expect(prompt).toContain("- read: Read file contents");
		expect(prompt).toContain('<project_instructions path="AGENTS.md">');
		expect(prompt).toContain("Role: reviewer.");
	});

	test("adds coding-agent policy to explicit Harness options", async () => {
		const session = new Session(new InMemorySessionStorage({ id: "harness-session", createdAt: 1 }));
		const env = new NodeExecutionEnv({ cwd: "/workspace" });
		const created = await createCodingAgentHarness({
			session,
			models: createModels(),
			model: getModel("google", "gemini-2.5-flash"),
			thinkingLevel: "high",
			env,
			streamOptions: { maxTokens: 123 },
			retry: { enabled: true, maxRetries: 2, baseDelayMs: 10 },
			steeringMode: "all",
			followUpMode: "all",
		});
		try {
			expect(created.suspended).toEqual([]);
			expect(await created.harness.getActiveTools()).toEqual([
				"apply_patch",
				"read",
				"bash",
				"edit",
				"write",
				"grep",
				"find",
				"ls",
			]);
			expect((await created.harness.getTools()).map((tool) => tool.name)).toEqual([
				"apply_patch",
				"read",
				"bash",
				"edit",
				"write",
				"grep",
				"find",
				"ls",
			]);
			expect(await created.harness.getStreamOptions()).toEqual({ maxTokens: 123 });
			expect(await created.harness.getRetryPolicy()).toEqual({ enabled: true, maxRetries: 2, baseDelayMs: 10 });
			expect(await created.harness.getSteeringMode()).toBe("all");
			expect(await created.harness.getFollowUpMode()).toBe("all");
		} finally {
			await created.harness.close();
			await env.cleanup();
		}
	});

	test("exposes server-owned exec_command and write_stdin tools when a process registry is configured", async () => {
		const session = new Session(new InMemorySessionStorage({ id: "process-tool-session", createdAt: 1 }));
		const env = new NodeExecutionEnv({ cwd: "/workspace" });
		const processes = new InMemoryV2ProcessRegistry();
		const created = await createCodingAgentHarness({
			session,
			models: createModels(),
			model: getModel("google", "gemini-2.5-flash"),
			env,
			processes,
		});
		try {
			const tools = await created.harness.getTools();
			const execCommand = tools.find((tool) => tool.name === "exec_command");
			const writeStdin = tools.find((tool) => tool.name === "write_stdin");
			if (!execCommand || !writeStdin) throw new Error("Expected process compatibility tools");
			const started = await execCommand.execute("exec-call", { command: "long-running" });
			expect(started.details).toMatchObject({ session_id: expect.any(String), state: "running", cursor: 0 });
			const sessionId = (started.details as { session_id: string }).session_id;
			const written = await writeStdin.execute("stdin-call", { session_id: sessionId, chars: "input" });
			expect(written.content).toEqual([{ type: "text", text: "input" }]);
			expect(written.details).toMatchObject({ session_id: sessionId, state: "running", cursor: 5 });
			const bounded = await writeStdin.execute("poll-call", {
				session_id: sessionId,
				cursor: 0,
				max_output_tokens: 1,
			});
			expect(bounded.content).toEqual([{ type: "text", text: "inpu" }]);
			expect(bounded.details).toMatchObject({ session_id: sessionId, truncated: true });
		} finally {
			await created.harness.close();
			await env.cleanup();
		}
	});

	test("exposes request_user_input only when the server provides its boundary", async () => {
		const session = new Session(new InMemorySessionStorage({ id: "input-tool-session", createdAt: 1 }));
		const env = new NodeExecutionEnv({ cwd: "/workspace" });
		const requests: unknown[] = [];
		const created = await createCodingAgentHarness({
			session,
			models: createModels(),
			model: getModel("google", "gemini-2.5-flash"),
			env,
			requestUserInput: async (request) => {
				requests.push(request);
				return { mode: "safe" };
			},
		});
		try {
			const tool = (await created.harness.getTools()).find((candidate) => candidate.name === "request_user_input");
			if (!tool) throw new Error("Expected request_user_input tool");
			const result = await tool.execute("input-call", {
				questions: [{ id: "mode", prompt: "Mode?", options: [{ label: "Safe", value: "safe" }] }],
			});
			expect(requests).toHaveLength(1);
			expect(result.content).toEqual([{ type: "text", text: JSON.stringify({ mode: "safe" }) }]);
		} finally {
			await created.harness.close();
			await env.cleanup();
		}
	});

	test("exposes the provider-neutral web tool only when configured", async () => {
		const session = new Session(new InMemorySessionStorage({ id: "web-tool-session", createdAt: 1 }));
		const env = new NodeExecutionEnv({ cwd: "/workspace" });
		const created = await createCodingAgentHarness({
			session,
			models: createModels(),
			model: getModel("google", "gemini-2.5-flash"),
			env,
			web: async (request) => [{ id: "result-1", title: request.operation, source: "fixture", retrievedAt: 1 }],
		});
		try {
			const tool = (await created.harness.getTools()).find((candidate) => candidate.name === "web");
			if (!tool) throw new Error("Expected web tool");
			const result = await tool.execute("web-call", { operation: "search_query", query: "pi" });
			expect(result.content).toEqual([
				{
					type: "text",
					text: JSON.stringify([{ id: "result-1", title: "search_query", source: "fixture", retrievedAt: 1 }]),
				},
			]);
		} finally {
			await created.harness.close();
			await env.cleanup();
		}
	});

	test("exposes view_image through the configured image boundary", async () => {
		const session = new Session(new InMemorySessionStorage({ id: "image-tool-session", createdAt: 1 }));
		const env = new NodeExecutionEnv({ cwd: "/workspace" });
		const created = await createCodingAgentHarness({
			session,
			models: createModels(),
			model: getModel("google", "gemini-2.5-flash"),
			env,
			viewImage: async (reference) => ({ digest: "sha256:image", mimeType: "image/png", size: 3, reference }),
		});
		try {
			const tool = (await created.harness.getTools()).find((candidate) => candidate.name === "view_image");
			if (!tool) throw new Error("Expected view_image tool");
			const result = await tool.execute("image-call", { reference: "project:image.png" });
			expect(result.content).toEqual([
				{
					type: "text",
					text: JSON.stringify({
						digest: "sha256:image",
						mimeType: "image/png",
						size: 3,
						reference: "project:image.png",
					}),
				},
			]);
		} finally {
			await created.harness.close();
			await env.cleanup();
		}
	});

	test("exposes the Codex-compatible child-agent tool set behind an injected registry", async () => {
		const session = new Session(new InMemorySessionStorage({ id: "agent-tool-session", createdAt: 1 }));
		const env = new NodeExecutionEnv({ cwd: "/workspace" });
		const created = await createCodingAgentHarness({
			session,
			models: createModels(),
			model: getModel("google", "gemini-2.5-flash"),
			env,
			agents: {
				spawn: async (request) => ({ id: "agent-1", ...request }),
				list: async () => [{ id: "agent-1", state: "running" }],
				wait: async (agentId) => ({ id: agentId, state: "complete" }),
				message: async () => {},
				followUp: async (agentId) => ({ id: agentId, state: "running" }),
				interrupt: async (agentId) => ({ id: agentId, state: "interrupted" }),
			},
		});
		try {
			expect((await created.harness.getTools()).map((tool) => tool.name).slice(-6)).toEqual([
				"spawn_agent",
				"list_agents",
				"wait_agent",
				"send_message",
				"followup_task",
				"interrupt_agent",
			]);
			const spawn = (await created.harness.getTools()).find((tool) => tool.name === "spawn_agent");
			if (!spawn) throw new Error("Expected spawn_agent tool");
			expect(
				await spawn.execute("spawn-call", {
					taskName: "child",
					taskMessage: "Inspect the bug",
					role: "reviewer",
					forkTurns: 1,
				}),
			).toMatchObject({
				content: [{ type: "text", text: expect.stringContaining('"role":"reviewer"') }],
			});
		} finally {
			await created.harness.close();
			await env.cleanup();
		}
	});

	test("keeps the child-agent tool contract available for three configured providers", async () => {
		const models = createModels();
		const providers = [
			fauxProvider({
				provider: "coding-agent-harness-agent-tools-openai-faux",
				models: [{ id: "openai-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
			}),
			fauxProvider({
				provider: "coding-agent-harness-agent-tools-anthropic-faux",
				models: [{ id: "anthropic-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
			}),
			fauxProvider({
				provider: "coding-agent-harness-agent-tools-google-faux",
				models: [{ id: "google-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
			}),
		];
		for (const provider of providers) models.setProvider(provider.provider);
		const expected = ["spawn_agent", "list_agents", "wait_agent", "send_message", "followup_task", "interrupt_agent"];

		for (const [index, provider] of providers.entries()) {
			const session = new Session(new InMemorySessionStorage({ id: `agent-tools-${index}`, createdAt: 1 }));
			const env = new NodeExecutionEnv({ cwd: "/workspace" });
			const created = await createCodingAgentHarness({
				session,
				models,
				model: provider.getModel()!,
				env,
				agents: {
					spawn: async (request) => ({ id: "agent-1", ...request }),
					list: async () => [],
					wait: async (agentId) => ({ id: agentId, state: "complete" }),
					message: async () => {},
					followUp: async (agentId) => ({ id: agentId, state: "running" }),
					interrupt: async (agentId) => ({ id: agentId, state: "interrupted" }),
				},
			});
			try {
				expect((await created.harness.getTools()).map((tool) => tool.name).slice(-6)).toEqual(expected);
			} finally {
				await created.harness.close();
				await env.cleanup();
			}
		}
	});

	test("exposes update_plan through the injected server-owned plan boundary", async () => {
		const session = new Session(new InMemorySessionStorage({ id: "plan-tool-session", createdAt: 1 }));
		const env = new NodeExecutionEnv({ cwd: "/workspace" });
		const updates: unknown[] = [];
		const created = await createCodingAgentHarness({
			session,
			models: createModels(),
			model: getModel("google", "gemini-2.5-flash"),
			env,
			plans: {
				read: async () => undefined,
				update: async (input) => {
					updates.push(input);
					return { version: 1, items: input.items };
				},
			},
		});
		try {
			const tool = (await created.harness.getTools()).find((candidate) => candidate.name === "update_plan");
			if (!tool) throw new Error("Expected update_plan tool");
			const result = await tool.execute("plan-call", {
				items: [{ step: "implement", status: "in_progress" }],
				version: 1,
			});
			expect(updates).toEqual([{ items: [{ step: "implement", status: "in_progress" }], version: 1 }]);
			expect(result.content).toEqual([
				{
					type: "text",
					text: JSON.stringify({ version: 1, items: [{ step: "implement", status: "in_progress" }] }),
				},
			]);
		} finally {
			await created.harness.close();
			await env.cleanup();
		}
	});

	test("preserves coding-agent prompt snippets and guideline order", () => {
		const prompt = buildCodingAgentHarnessSystemPrompt({
			cwd: "/workspace",
			tools: defaultPromptTools,
			activeToolNames: ["read", "bash", "edit", "write"],
		});
		expect(prompt).toContain("- read: Read file contents");
		expect(prompt).toContain("- bash: Execute bash commands (ls, grep, find, etc.)");
		expect(prompt).toContain("Use read to examine files instead of cat or sed.");
		expect(prompt).toContain("You can inspect PI_* environment variables for current model and session details.");
		expect(prompt.indexOf("Use read to examine files")).toBeLessThan(
			prompt.indexOf("You can inspect PI_* environment variables"),
		);
	});

	test("appends role instructions after model instructions", () => {
		const prompt = buildCodingAgentHarnessSystemPrompt({
			cwd: "/workspace",
			tools: [],
			activeToolNames: [],
			modelInstruction: {
				id: "model-profile",
				source: "text",
				mode: "append",
				text: "Model profile",
				contentHash: "hash",
				byteLength: "Model profile".length,
			},
			roleInstructions: "Reviewer role",
		});
		expect(prompt.indexOf("Model profile")).toBeLessThan(prompt.indexOf("Reviewer role"));
	});

	test("preserves caller-supplied tools and activation", async () => {
		const session = new Session(new InMemorySessionStorage({ id: "custom-harness-session", createdAt: 1 }));
		const env = new NodeExecutionEnv({ cwd: "/workspace" });
		const customTool: HarnessTool = {
			name: "inspect",
			label: "inspect",
			description: "Inspect the configured service",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "ok" }], details: undefined }),
		};
		const created = await createCodingAgentHarness({
			session,
			models: createModels(),
			model: getModel("google", "gemini-2.5-flash"),
			env,
			tools: [customTool],
			activeToolNames: [],
			systemPrompt: "Server-owned prompt",
		});
		try {
			expect((await created.harness.getTools()).map((tool) => tool.name)).toEqual(["inspect"]);
			expect(await created.harness.getActiveTools()).toEqual([]);
		} finally {
			await created.harness.close();
			await env.cleanup();
		}
	});

	test("filters server-owned active tools after assembly", async () => {
		const session = new Session(new InMemorySessionStorage({ id: "filtered-tools-session", createdAt: 1 }));
		const env = new NodeExecutionEnv({ cwd: "/workspace" });
		const created = await createCodingAgentHarness({
			session,
			models: createModels(),
			model: getModel("google", "gemini-2.5-flash"),
			env,
			excludedToolNames: ["read"],
		});
		try {
			expect(await created.harness.getActiveTools()).toEqual([
				"apply_patch",
				"bash",
				"edit",
				"write",
				"grep",
				"find",
				"ls",
			]);
		} finally {
			await created.harness.close();
			await env.cleanup();
		}
	});

	test("sets the optional session file in the default bash tool environment", async () => {
		const session = new Session(new InMemorySessionStorage({ id: "session-file-harness", createdAt: 1 }));
		const env = new CapturingExecutionEnv({
			cwd: process.cwd(),
			shellEnv: { PI_SESSION_FILE: "/stale/parent.jsonl", PI_CODING_AGENT: "true" },
		});
		const created = await createCodingAgentHarness({
			session,
			models: createModels(),
			model: getModel("google", "gemini-2.5-flash"),
			thinkingLevel: "high",
			env,
			sessionFile: "/sessions/current.jsonl",
		});
		try {
			const bash = (await created.harness.getTools()).find((tool) => tool.name === "bash");
			if (!bash) throw new Error("Expected the default bash tool");

			const result = await bash.execute("bash-call", {
				command: `printf '%s' "$PI_SESSION_ID|$PI_SESSION_FILE|$PI_PROVIDER|$PI_MODEL|$PI_REASONING_LEVEL|$PI_CODING_AGENT"`,
			});

			expect(env.executionOverrides).toEqual({
				PI_SESSION_ID: "session-file-harness",
				PI_SESSION_FILE: "/sessions/current.jsonl",
				PI_PROVIDER: "google",
				PI_MODEL: "gemini-2.5-flash",
				PI_REASONING_LEVEL: "high",
			});
			expect(result.content).toEqual([
				{
					type: "text",
					text: "session-file-harness|/sessions/current.jsonl|google|gemini-2.5-flash|high|true",
				},
			]);
		} finally {
			await created.harness.close();
			await env.cleanup();
		}
	});

	test("keeps bash PI model variables synchronized with Harness state", async () => {
		const session = new Session(new InMemorySessionStorage({ id: "dynamic-bash-session", createdAt: 1 }));
		const env = new CapturingExecutionEnv({
			cwd: process.cwd(),
			shellEnv: { PI_SESSION_FILE: "/stale/parent.jsonl", PI_CODING_AGENT: "true" },
		});
		const created = await createCodingAgentHarness({
			session,
			models: createModels(),
			model: getModel("google", "gemini-2.5-flash"),
			thinkingLevel: "high",
			env,
		});
		try {
			await created.harness.setModel(getModel("anthropic", "claude-sonnet-4-5"));
			await created.harness.setThinkingLevel("low");
			const bash = (await created.harness.getTools()).find((tool) => tool.name === "bash");
			if (!bash) throw new Error("Expected the default bash tool");

			const result = await bash.execute("bash-call", {
				command: `printf '%s:%s' "\${PI_SESSION_FILE+x}" "$PI_SESSION_ID|$PI_PROVIDER|$PI_MODEL|$PI_REASONING_LEVEL|$PI_CODING_AGENT"`,
			});

			expect(env.executionOverrides).toEqual({
				PI_SESSION_ID: "dynamic-bash-session",
				PI_SESSION_FILE: "",
				PI_PROVIDER: "anthropic",
				PI_MODEL: "claude-sonnet-4-5",
				PI_REASONING_LEVEL: "low",
			});
			expect(Object.hasOwn(env.executionOverrides ?? {}, "PI_SESSION_FILE")).toBe(true);
			expect(env.executionOverrides?.PI_SESSION_FILE).toBe("");
			expect(result.content).toEqual([
				{
					type: "text",
					text: "x:dynamic-bash-session|anthropic|claude-sonnet-4-5|low|true",
				},
			]);
		} finally {
			await created.harness.close();
			await env.cleanup();
		}
	});

	test("builds each default system prompt from current Harness tool metadata", async () => {
		const originalCreate = AgentHarness.create.bind(AgentHarness);
		let configuredSystemPrompt: AgentHarnessOptions["systemPrompt"];
		const createSpy = vi.spyOn(AgentHarness, "create").mockImplementation(async (options) => {
			configuredSystemPrompt = options.systemPrompt;
			return originalCreate(options);
		});
		const session = new Session(new InMemorySessionStorage({ id: "dynamic-prompt-session", createdAt: 1 }));
		const env = new NodeExecutionEnv({ cwd: "/workspace" });
		try {
			const created = await createCodingAgentHarness({
				session,
				models: createModels(),
				model: getModel("google", "gemini-2.5-flash"),
				env,
			});
			createSpy.mockRestore();
			try {
				const initialPrompt = await resolveSystemPrompt(configuredSystemPrompt);
				expect(initialPrompt).toContain("- read: Read file contents");
				expect(initialPrompt).toContain("- bash: Execute bash commands (ls, grep, find, etc.)");
				expect(initialPrompt).toContain("- edit: Make precise file edits with exact text replacement");
				expect(initialPrompt).toContain("- write: Create or overwrite files");

				await created.harness.setActiveTools(["write"]);
				const writePrompt = await resolveSystemPrompt(configuredSystemPrompt);
				expect(writePrompt).toContain("- write: Create or overwrite files");
				expect(writePrompt).not.toContain("- read:");
				expect(writePrompt).not.toContain("- bash:");

				const read = (await created.harness.getTools()).find((tool) => tool.name === "read");
				if (!read) throw new Error("Expected the default read tool");
				await created.harness.setTools([read]);
				const readPrompt = await resolveSystemPrompt(configuredSystemPrompt);
				expect(readPrompt).toContain("- read: Read file contents");
				expect(readPrompt).not.toContain("- write:");

				const inspectTool: CodingAgentHarnessTool = {
					name: "inspect",
					label: "inspect",
					description: "Inspect the configured service",
					parameters: Type.Object({}),
					execute: async () => ({ content: [{ type: "text", text: "ok" }], details: undefined }),
					promptSnippet: "  Inspect\nthe   configured service  ",
					promptGuidelines: ["Use inspect for service diagnostics."],
				};
				await created.harness.setTools([inspectTool]);
				const inspectPrompt = await resolveSystemPrompt(configuredSystemPrompt);
				expect(inspectPrompt).toContain("- inspect: Inspect the configured service");
				expect(inspectPrompt).toContain("Use inspect for service diagnostics.");
			} finally {
				await created.harness.close();
				await env.cleanup();
			}
		} finally {
			createSpy.mockRestore();
		}
	});

	test("omits active custom tools without prompt metadata from the textual tools section", () => {
		const prompt = buildCodingAgentHarnessSystemPrompt({
			cwd: "/workspace",
			tools: [createPromptTool("hidden")],
			activeToolNames: ["hidden"],
		});

		expect(prompt).toContain("Available tools:\n(none)");
		expect(prompt).not.toContain("- hidden:");
		expect(prompt).not.toContain("hidden description");
	});

	test.each([
		[
			"bash",
			"Execute bash commands (ls, grep, find, etc.)",
			"You can inspect PI_* environment variables for current model and session details.",
		],
		["read", "Read file contents", "Use read to examine files instead of cat or sed."],
		[
			"edit",
			"Make precise file edits with exact text replacement, including multiple disjoint edits in one call",
			"Use edit for precise changes (edits[].oldText must match exactly)",
		],
		["write", "Create or overwrite files", "Use write only for new files or complete rewrites."],
	] as const)(
		"does not infer prompt metadata for a caller-supplied %s replacement",
		(name, builtInSnippet, builtInGuideline) => {
			const prompt = buildCodingAgentHarnessSystemPrompt({
				cwd: "/workspace",
				tools: [createPromptTool(name)],
				activeToolNames: [name],
			});

			expect(prompt).toContain("Available tools:\n(none)");
			expect(prompt).not.toContain(builtInSnippet);
			expect(prompt).not.toContain(builtInGuideline);
		},
	);

	test("builds the default prompt from active tools and resolved prompt resources", () => {
		const prompt = buildCodingAgentHarnessSystemPrompt({
			cwd: "/workspace",
			tools: defaultPromptTools,
			activeToolNames: ["write", "read"],
			systemPromptOptions: {
				contextFiles: [{ path: "/workspace/AGENTS.md", content: "Follow project policy." }],
				skills: [
					{
						name: "review",
						description: "Review server changes",
						filePath: "/skills/review/SKILL.md",
						baseDir: "/skills/review",
						sourceInfo: {
							path: "/skills/review/SKILL.md",
							source: "test",
							scope: "temporary",
							origin: "top-level",
						},
						disableModelInvocation: false,
					},
				],
			},
		});

		expect(prompt).toContain("- write: Create or overwrite files");
		expect(prompt).toContain("- read: Read file contents");
		expect(prompt).not.toContain("- bash:");
		expect(prompt).not.toContain("You can inspect PI_* environment variables");
		expect(prompt).toContain('<project_instructions path="/workspace/AGENTS.md">');
		expect(prompt).toContain("<name>review</name>");
		expect(prompt.indexOf("Use write only for new files or complete rewrites.")).toBeLessThan(
			prompt.indexOf("Use read to examine files instead of cat or sed."),
		);
	});
});

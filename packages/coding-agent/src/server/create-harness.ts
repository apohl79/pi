import {
	AgentHarness,
	type AgentHarnessOptions,
	type AgentHarnessTool,
	createApplyPatchTool,
	createBashTool,
	createEditTool,
	createGoalTools,
	createReadTool,
	createWriteTool,
	type ExecutionEnv,
	type ExecutionToolContext,
	executeShellWithCapture,
	type GoalManager,
	type HarnessTool,
} from "@earendil-works/pi-agent-core";
import type { V2ProcessRegistry } from "@earendil-works/pi-server";
import { type Static, type TSchema, Type } from "typebox";
import { getExperimentalToolSampling } from "../core/experimental.ts";
import { type BuildSystemPromptOptions, buildSystemPrompt } from "../core/system-prompt.ts";
import { bashToolSystemPromptContribution } from "../core/tools/bash.ts";
import { editToolSystemPromptContribution } from "../core/tools/edit.ts";
import { readToolSystemPromptContribution } from "../core/tools/read.ts";
import { writeToolSystemPromptContribution } from "../core/tools/write.ts";
import type { ModelInstructionResolver, ResolvedModelInstructionProfile } from "./model-instructions.ts";
import { createProcessTools } from "./process-tools.ts";

export interface CodingAgentInputQuestion {
	id: string;
	prompt: string;
	options?: readonly { label: string; value?: string }[];
	allowFreeform?: boolean;
}

export interface CodingAgentInputRequest {
	questions: readonly CodingAgentInputQuestion[];
	autoResolutionMs?: number;
}

export type CodingAgentInputResponse = Readonly<Record<string, string>>;

export type CodingAgentWebOperation = "search_query" | "open" | "click" | "find" | "screenshot" | "image_query";

export interface CodingAgentWebRequest {
	operation: CodingAgentWebOperation;
	query?: string;
	url?: string;
	refId?: string;
	pattern?: string;
}

export interface CodingAgentWebResult {
	id: string;
	url?: string;
	title: string;
	source: string;
	retrievedAt: number;
	extract?: string;
	mimeType?: string;
	blobDigest?: string;
}

export interface CodingAgentImageView {
	digest: string;
	mimeType: string;
	size: number;
	reference: string;
}

export interface CodingAgentImageGenerationRequest {
	prompt: string;
	sourceDigest?: string;
}

export interface CodingAgentImageGenerationResult {
	digest: string;
	mimeType: string;
	size: number;
	provider: string;
	model: string;
	dimensions?: Readonly<{ width: number; height: number }>;
	promptHash: string;
	costUsd?: number;
}

export interface CodingAgentLifecycleHook {
	id: string;
	event: "turn/accepted" | "turn/completed";
	command: string;
}

export type CodingAgentLifecycleHookOutcome = Readonly<{
	id: string;
	event: CodingAgentLifecycleHook["event"];
	outcome: "ok" | "error";
	durationMs: number;
	outputBytes: number;
	truncated: boolean;
	exitCode?: number;
}>;

export interface CodingAgentAgentTools {
	spawn(request: {
		taskName: string;
		taskMessage: string;
		model?: { provider: string; id: string };
		role?: string;
		forkTurns?: "none" | "all" | number;
	}): Promise<unknown>;
	list(): Promise<unknown>;
	wait(agentId: string, timeoutMs?: number): Promise<unknown>;
	message(agentId: string, message: string): Promise<void>;
	followUp(agentId: string, message: string): Promise<unknown>;
	interrupt(agentId: string): Promise<unknown>;
}

export interface CodingAgentPlanTools {
	update(input: {
		items: readonly { step: string; status: "pending" | "in_progress" | "completed" }[];
		version?: number;
	}): Promise<unknown>;
}

const requestUserInputSchema = Type.Object({
	questions: Type.Array(
		Type.Object({
			id: Type.String({ minLength: 1 }),
			prompt: Type.String({ minLength: 1 }),
			options: Type.Optional(
				Type.Array(Type.Object({ label: Type.String({ minLength: 1 }), value: Type.Optional(Type.String()) })),
			),
			allowFreeform: Type.Optional(Type.Boolean()),
		}),
		{ minItems: 1, maxItems: 3 },
	),
	autoResolutionMs: Type.Optional(Type.Integer({ minimum: 0 })),
});

const webSchema = Type.Object({
	operation: Type.Union([
		Type.Literal("search_query"),
		Type.Literal("open"),
		Type.Literal("click"),
		Type.Literal("find"),
		Type.Literal("screenshot"),
		Type.Literal("image_query"),
	]),
	query: Type.Optional(Type.String()),
	url: Type.Optional(Type.String()),
	refId: Type.Optional(Type.String()),
	pattern: Type.Optional(Type.String()),
});

const viewImageSchema = Type.Object({ reference: Type.String({ minLength: 1 }) });
const generateImageSchema = Type.Object({
	prompt: Type.String({ minLength: 1 }),
	sourceDigest: Type.Optional(Type.String({ minLength: 1 })),
});
const spawnAgentSchema = Type.Object({
	taskName: Type.String({ minLength: 1 }),
	taskMessage: Type.String({ minLength: 1 }),
	model: Type.Optional(Type.Object({ provider: Type.String({ minLength: 1 }), id: Type.String({ minLength: 1 }) })),
	role: Type.Optional(Type.String({ minLength: 1 })),
	forkTurns: Type.Optional(
		Type.Union([Type.Literal("none"), Type.Literal("all"), Type.Integer({ minimum: 1, maximum: 32 })]),
	),
});
const listAgentsSchema = Type.Object({});
const waitAgentSchema = Type.Object({
	agentId: Type.String({ minLength: 1 }),
	timeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
});
const messageAgentSchema = Type.Object({
	agentId: Type.String({ minLength: 1 }),
	message: Type.String({ minLength: 1 }),
});
const followUpAgentSchema = messageAgentSchema;
const interruptAgentSchema = Type.Object({ agentId: Type.String({ minLength: 1 }) });
const updatePlanSchema = Type.Object({
	items: Type.Array(
		Type.Object({
			step: Type.String({ minLength: 1 }),
			status: Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed")]),
		}),
		{ minItems: 1, maxItems: 64 },
	),
	version: Type.Optional(Type.Integer({ minimum: 1 })),
});

export interface CodingAgentHarnessTool extends HarnessTool {
	promptSnippet?: string;
	promptGuidelines?: readonly string[];
}

function createCodingAgentHarnessTool<TParameters extends TSchema, TDetails>(
	tool: AgentHarnessTool<ExecutionToolContext, TParameters, TDetails>,
	context: ExecutionToolContext,
	prompt: Required<Pick<CodingAgentHarnessTool, "promptSnippet" | "promptGuidelines">>,
): CodingAgentHarnessTool {
	return {
		...tool,
		...prompt,
		constrainedSampling: getExperimentalToolSampling(),
		execute: (toolCallId, params, signal, onUpdate) =>
			tool.execute(toolCallId, params as Static<TParameters>, signal, onUpdate, context),
	};
}

export interface CreateCodingAgentHarnessOptions extends Omit<AgentHarnessOptions, "toolContext" | "tools"> {
	env: ExecutionEnv;
	goals?: GoalManager;
	processes?: V2ProcessRegistry;
	bashCommandPrefix?: string;
	/** Path to the JSONL session file exposed to default bash commands as PI_SESSION_FILE. */
	sessionFile?: string;
	tools?: CodingAgentHarnessTool[];
	systemPromptOptions?: Omit<BuildSystemPromptOptions, "cwd" | "promptGuidelines" | "selectedTools" | "toolSnippets">;
	modelInstructions?: { resolver: ModelInstructionResolver; scope?: "root" | "subagent" };
	requestUserInput?: (
		request: CodingAgentInputRequest,
		signal: AbortSignal | undefined,
	) => Promise<CodingAgentInputResponse>;
	web?: (request: CodingAgentWebRequest) => Promise<readonly CodingAgentWebResult[]>;
	viewImage?: (reference: string) => Promise<CodingAgentImageView>;
	generateImage?: (request: CodingAgentImageGenerationRequest) => Promise<CodingAgentImageGenerationResult>;
	lifecycleHooks?: readonly CodingAgentLifecycleHook[];
	lifecycleHookOutcome?: (outcome: CodingAgentLifecycleHookOutcome) => Promise<void>;
	agents?: CodingAgentAgentTools;
	plans?: CodingAgentPlanTools;
}

export interface BuildCodingAgentHarnessSystemPromptOptions {
	cwd: string;
	tools: readonly CodingAgentHarnessTool[];
	activeToolNames: readonly string[];
	systemPromptOptions?: CreateCodingAgentHarnessOptions["systemPromptOptions"];
	modelInstruction?: ResolvedModelInstructionProfile;
}

export function buildCodingAgentHarnessSystemPrompt(options: BuildCodingAgentHarnessSystemPromptOptions): string {
	const activeTools = options.activeToolNames.flatMap((name) => {
		const tool = options.tools.find((candidate) => candidate.name === name);
		return tool ? [tool] : [];
	});
	const toolSnippets = Object.fromEntries(
		activeTools.flatMap((tool) => {
			const promptSnippet = tool.promptSnippet
				?.replace(/[\r\n]+/g, " ")
				.replace(/\s+/g, " ")
				.trim();
			return promptSnippet ? [[tool.name, promptSnippet]] : [];
		}),
	);
	const promptGuidelines = activeTools.flatMap((tool) => tool.promptGuidelines ?? []);
	const basePrompt = buildSystemPrompt({
		...options.systemPromptOptions,
		cwd: options.cwd,
		selectedTools: activeTools.map((tool) => tool.name),
		toolSnippets,
		promptGuidelines,
	});
	const instruction = options.modelInstruction;
	if (!instruction) return basePrompt;
	if (instruction.mode === "append") return `${basePrompt}\n\n${instruction.text}`;
	const defaultPersona =
		"You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.";
	return basePrompt.startsWith(defaultPersona)
		? `${instruction.text}${basePrompt.slice(defaultPersona.length)}`
		: `${instruction.text}\n\n${basePrompt}`;
}

export async function createCodingAgentHarness(options: CreateCodingAgentHarnessOptions) {
	const {
		env,
		bashCommandPrefix,
		sessionFile,
		systemPromptOptions,
		tools: providedTools,
		activeToolNames: providedActiveToolNames,
		systemPrompt: providedSystemPrompt,
		...harnessOptions
	} = options;
	let harness: AgentHarness | undefined;
	const getHarness = (): AgentHarness => {
		if (!harness) throw new Error("Coding-agent Harness callback ran before Harness initialization");
		return harness;
	};
	let tools = providedTools;
	if (tools === undefined) {
		const metadata = await options.session.getMetadata();
		const toolContext = { env } satisfies ExecutionToolContext;
		tools = [
			createCodingAgentHarnessTool(createApplyPatchTool<ExecutionToolContext>(), toolContext, {
				promptSnippet: "Apply a Codex patch envelope atomically to repository files.",
				promptGuidelines: [],
			}),
			createCodingAgentHarnessTool(createReadTool<ExecutionToolContext>(), toolContext, {
				promptSnippet: readToolSystemPromptContribution.snippet,
				promptGuidelines: readToolSystemPromptContribution.guidelines,
			}),
			createCodingAgentHarnessTool(
				createBashTool<ExecutionToolContext>({
					commandPrefix: bashCommandPrefix,
					prepare: async (execution) => {
						const currentHarness = getHarness();
						const [model, thinkingLevel] = await Promise.all([
							currentHarness.getModel(),
							currentHarness.getThinkingLevel(),
						]);
						execution.env.PI_SESSION_ID = metadata.id;
						execution.env.PI_SESSION_FILE = sessionFile ?? "";
						execution.env.PI_PROVIDER = model.provider;
						execution.env.PI_MODEL = model.id;
						execution.env.PI_REASONING_LEVEL = thinkingLevel;
					},
				}),
				toolContext,
				{
					promptSnippet: bashToolSystemPromptContribution.snippet,
					promptGuidelines: bashToolSystemPromptContribution.guidelines,
				},
			),
			createCodingAgentHarnessTool(createEditTool<ExecutionToolContext>(), toolContext, {
				promptSnippet: editToolSystemPromptContribution.snippet,
				promptGuidelines: editToolSystemPromptContribution.guidelines,
			}),
			createCodingAgentHarnessTool(createWriteTool<ExecutionToolContext>(), toolContext, {
				promptSnippet: writeToolSystemPromptContribution.snippet,
				promptGuidelines: writeToolSystemPromptContribution.guidelines,
			}),
		];
		if (options.processes) {
			tools.push(
				...createProcessTools(options.processes, metadata.id).map((tool) =>
					createCodingAgentHarnessTool(tool, toolContext, {
						promptSnippet: tool.description,
						promptGuidelines: [],
					}),
				),
			);
		}
		if (options.goals) {
			tools.push(
				...createGoalTools(options.goals).map((tool) => ({
					...tool,
					promptSnippet: tool.description,
					promptGuidelines: [],
				})),
			);
		}
		if (options.requestUserInput) {
			const requestUserInput = options.requestUserInput;
			tools.push({
				name: "request_user_input",
				label: "request_user_input",
				description: "Ask the user one to three structured questions and wait for their response.",
				parameters: requestUserInputSchema,
				execute: async (_toolCallId, input, signal) => {
					const response = await requestUserInput(input as Static<typeof requestUserInputSchema>, signal);
					return { content: [{ type: "text", text: JSON.stringify(response) }], details: { response } };
				},
			});
		}
		if (options.web) {
			const web = options.web;
			tools.push({
				name: "web",
				label: "web",
				description: "Search or inspect the web through the configured server web adapter.",
				parameters: webSchema,
				execute: async (_toolCallId, input) => {
					const results = await web(input as Static<typeof webSchema>);
					return { content: [{ type: "text", text: JSON.stringify(results) }], details: { results } };
				},
			});
		}
		if (options.viewImage) {
			const viewImage = options.viewImage;
			tools.push({
				name: "view_image",
				label: "view_image",
				description: "Inspect a local image through the configured server image service.",
				parameters: viewImageSchema,
				execute: async (_toolCallId, input) => {
					const image = await viewImage((input as Static<typeof viewImageSchema>).reference);
					return { content: [{ type: "text", text: JSON.stringify(image) }], details: { image } };
				},
			});
		}
		if (options.generateImage) {
			const generateImage = options.generateImage;
			tools.push({
				name: "generate_image",
				label: "generate_image",
				description: "Generate or edit an image through the configured server image service.",
				parameters: generateImageSchema,
				execute: async (_toolCallId, input) => {
					const image = await generateImage(input as Static<typeof generateImageSchema>);
					return { content: [{ type: "text", text: JSON.stringify(image) }], details: { image } };
				},
			});
		}
		if (options.agents) {
			const agents = options.agents;
			tools.push(
				{
					name: "spawn_agent",
					label: "spawn_agent",
					description: "Start a child coding agent with an explicit task.",
					parameters: spawnAgentSchema,
					execute: async (_id, input) => ({
						content: [
							{
								type: "text",
								text: JSON.stringify(await agents.spawn(input as Static<typeof spawnAgentSchema>)),
							},
						],
						details: {},
					}),
				},
				{
					name: "list_agents",
					label: "list_agents",
					description: "List child agents owned by this session.",
					parameters: listAgentsSchema,
					execute: async () => ({
						content: [{ type: "text", text: JSON.stringify(await agents.list()) }],
						details: {},
					}),
				},
				{
					name: "wait_agent",
					label: "wait_agent",
					description: "Wait for a child agent and return its current state.",
					parameters: waitAgentSchema,
					execute: async (_id, input) => {
						const params = input as Static<typeof waitAgentSchema>;
						return {
							content: [
								{ type: "text", text: JSON.stringify(await agents.wait(params.agentId, params.timeoutMs)) },
							],
							details: {},
						};
					},
				},
				{
					name: "send_message",
					label: "send_message",
					description: "Send a message to a child agent.",
					parameters: messageAgentSchema,
					execute: async (_id, input) => {
						const params = input as Static<typeof messageAgentSchema>;
						await agents.message(params.agentId, params.message);
						return { content: [{ type: "text", text: "Message sent." }], details: {} };
					},
				},
				{
					name: "followup_task",
					label: "followup_task",
					description: "Send a follow-up task to a child agent.",
					parameters: followUpAgentSchema,
					execute: async (_id, input) => {
						const params = input as Static<typeof followUpAgentSchema>;
						return {
							content: [
								{ type: "text", text: JSON.stringify(await agents.followUp(params.agentId, params.message)) },
							],
							details: {},
						};
					},
				},
				{
					name: "interrupt_agent",
					label: "interrupt_agent",
					description: "Interrupt a running child agent.",
					parameters: interruptAgentSchema,
					execute: async (_id, input) => ({
						content: [
							{
								type: "text",
								text: JSON.stringify(
									await agents.interrupt((input as Static<typeof interruptAgentSchema>).agentId),
								),
							},
						],
						details: {},
					}),
				},
			);
		}
		if (options.plans) {
			const plans = options.plans;
			tools.push({
				name: "update_plan",
				label: "update_plan",
				description: "Replace the server-owned ordered plan for the current task.",
				parameters: updatePlanSchema,
				execute: async (_id, input) => ({
					content: [
						{ type: "text", text: JSON.stringify(await plans.update(input as Static<typeof updatePlanSchema>)) },
					],
					details: {},
				}),
			});
		}
	}
	const activeToolNames = [...(providedActiveToolNames ?? tools.map((tool) => tool.name))];
	const systemPrompt =
		providedSystemPrompt ??
		(async () => {
			const currentHarness = getHarness();
			const [currentTools, currentActiveToolNames] = await Promise.all([
				currentHarness.getTools(),
				currentHarness.getActiveTools(),
			]);
			const modelInstruction = options.modelInstructions
				? await options.modelInstructions.resolver.resolve(
						await currentHarness.getModel(),
						options.modelInstructions.scope,
					)
				: undefined;
			return buildCodingAgentHarnessSystemPrompt({
				cwd: env.cwd,
				tools: currentTools,
				activeToolNames: currentActiveToolNames,
				systemPromptOptions,
				modelInstruction,
			});
		});
	const created = await AgentHarness.create({
		...harnessOptions,
		tools,
		activeToolNames,
		systemPrompt,
	});
	harness = created.harness;
	for (const hook of options.lifecycleHooks ?? []) {
		const lifecycleName = hook.event === "turn/accepted" ? "before_run" : "before_run_end";
		harness.hooks.on(
			lifecycleName,
			async () => {
				const startedAt = Date.now();
				const result = await executeShellWithCapture(env, hook.command, {
					timeout: 5,
					returnExecutionErrors: true,
				});
				const details = result.ok ? result.value : undefined;
				if (details?.fullOutputPath !== undefined)
					await env.remove(details.fullOutputPath, { force: true }).catch(() => {});
				await options
					.lifecycleHookOutcome?.({
						id: hook.id,
						event: hook.event,
						outcome:
							result.ok &&
							details !== undefined &&
							details.executionError === undefined &&
							details.exitCode === 0
								? "ok"
								: "error",
						durationMs: Math.max(0, Date.now() - startedAt),
						outputBytes: details?.truncation.totalBytes ?? 0,
						truncated: details?.truncated ?? false,
						...(details?.exitCode === undefined ? {} : { exitCode: details.exitCode }),
					})
					.catch(() => {});
			},
			{ id: hook.id },
		);
	}
	return created;
}

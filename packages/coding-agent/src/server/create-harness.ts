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
	type GoalManager,
	type HarnessTool,
} from "@earendil-works/pi-agent-core";
import { type Static, type TSchema, Type } from "typebox";
import { getExperimentalToolSampling } from "../core/experimental.ts";
import { type BuildSystemPromptOptions, buildSystemPrompt } from "../core/system-prompt.ts";
import { bashToolSystemPromptContribution } from "../core/tools/bash.ts";
import { editToolSystemPromptContribution } from "../core/tools/edit.ts";
import { readToolSystemPromptContribution } from "../core/tools/read.ts";
import { writeToolSystemPromptContribution } from "../core/tools/write.ts";
import type { ModelInstructionResolver, ResolvedModelInstructionProfile } from "./model-instructions.ts";

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
	return created;
}

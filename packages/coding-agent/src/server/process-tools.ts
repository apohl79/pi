import type { AgentHarnessTool, ExecutionToolContext } from "@earendil-works/pi-agent-core";
import type { V2ProcessRegistry } from "@earendil-works/pi-server";
import { type Static, Type } from "typebox";

const MAX_INITIAL_YIELD_MS = 30_000;
const DEFAULT_OUTPUT_TOKENS = 4_000;

const execCommandSchema = Type.Object({
	command: Type.String({ minLength: 1 }),
	cwd: Type.Optional(Type.String({ minLength: 1 })),
	env: Type.Optional(Type.Record(Type.String(), Type.String())),
	pty: Type.Optional(Type.Boolean()),
	yield_time_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_INITIAL_YIELD_MS })),
	max_output_tokens: Type.Optional(Type.Integer({ minimum: 1, maximum: DEFAULT_OUTPUT_TOKENS })),
});

const writeStdinSchema = Type.Object({
	session_id: Type.String({ minLength: 1 }),
	chars: Type.Optional(Type.String()),
	cursor: Type.Optional(Type.Integer({ minimum: 0 })),
	yield_time_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_INITIAL_YIELD_MS })),
	max_output_tokens: Type.Optional(Type.Integer({ minimum: 1, maximum: DEFAULT_OUTPUT_TOKENS })),
});

type ProcessDetails = Readonly<{
	session_id: string;
	cursor: number;
	state: string;
	truncated: boolean;
}>;

function outputResult(output: string, details: ProcessDetails) {
	return {
		content: [{ type: "text" as const, text: output }],
		details,
	};
}

function formatOutput(output: string, state: string): string {
	return output.length === 0 ? `[process ${state}]` : output;
}

async function waitForYield(
	processes: V2ProcessRegistry,
	processId: string,
	yieldTimeMs: number | undefined,
): Promise<void> {
	if (yieldTimeMs === undefined || yieldTimeMs === 0) return;
	await Promise.race([
		processes.wait(processId).then(() => undefined),
		new Promise<void>((resolve) => setTimeout(resolve, yieldTimeMs)),
	]);
}

function capOutput(output: string, maxOutputTokens: number | undefined): { output: string; truncated: boolean } {
	const maxCharacters = (maxOutputTokens ?? DEFAULT_OUTPUT_TOKENS) * 4;
	return output.length <= maxCharacters
		? { output, truncated: false }
		: { output: output.slice(0, maxCharacters), truncated: true };
}

export function createProcessTools(
	processes: V2ProcessRegistry,
	sessionId: string,
): AgentHarnessTool<ExecutionToolContext>[] {
	const execCommand: AgentHarnessTool<ExecutionToolContext, typeof execCommandSchema, ProcessDetails> = {
		name: "exec_command",
		label: "exec_command",
		description: "Run a server-owned command and return bounded output with a stable session_id.",
		parameters: execCommandSchema,
		execute: async (_toolCallId, input, _signal, _onUpdate, context) => {
			const process = await processes.start({
				sessionId,
				command: input.command,
				cwd: input.cwd ?? context.env.cwd,
				...(input.env === undefined ? {} : { env: input.env }),
				pty: input.pty === true,
			});
			await waitForYield(processes, process.processId, input.yield_time_ms);
			const current = await processes.getSnapshot(process.processId);
			const capped = capOutput(current.output, input.max_output_tokens);
			return outputResult(formatOutput(capped.output, current.state), {
				session_id: process.processId,
				cursor: current.cursor,
				state: current.state,
				truncated: current.truncated || capped.truncated,
			});
		},
	};
	const writeStdin: AgentHarnessTool<ExecutionToolContext, typeof writeStdinSchema, ProcessDetails> = {
		name: "write_stdin",
		label: "write_stdin",
		description: "Write input to a server-owned process or poll output after a cursor.",
		parameters: writeStdinSchema,
		execute: async (_toolCallId, input) => {
			const output =
				input.chars === undefined
					? await processes.read(input.session_id, input.cursor ?? 0)
					: await processes.write(input.session_id, input.chars);
			await waitForYield(processes, input.session_id, input.yield_time_ms);
			const process = await processes.getSnapshot(input.session_id);
			const capped = capOutput(output.output, input.max_output_tokens);
			return outputResult(formatOutput(capped.output, process.state), {
				session_id: process.processId,
				cursor: output.cursor,
				state: process.state,
				truncated: output.truncated || capped.truncated,
			});
		},
	};
	return [execCommand, writeStdin];
}

export type ExecCommandInput = Static<typeof execCommandSchema>;

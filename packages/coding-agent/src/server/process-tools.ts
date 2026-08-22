import type { AgentHarnessTool, ExecutionToolContext } from "@earendil-works/pi-agent-core";
import type { V2ProcessRegistry } from "@earendil-works/pi-server";
import { type Static, Type } from "typebox";

const execCommandSchema = Type.Object({
	command: Type.String({ minLength: 1 }),
	cwd: Type.Optional(Type.String({ minLength: 1 })),
	env: Type.Optional(Type.Record(Type.String(), Type.String())),
	pty: Type.Optional(Type.Boolean()),
});

const writeStdinSchema = Type.Object({
	session_id: Type.String({ minLength: 1 }),
	chars: Type.Optional(Type.String()),
	cursor: Type.Optional(Type.Integer({ minimum: 0 })),
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
			return outputResult(formatOutput(process.output, process.state), {
				session_id: process.processId,
				cursor: process.cursor,
				state: process.state,
				truncated: process.truncated,
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
			const process = await processes.getSnapshot(input.session_id);
			return outputResult(formatOutput(output.output, process.state), {
				session_id: process.processId,
				cursor: output.cursor,
				state: process.state,
				truncated: output.truncated,
			});
		},
	};
	return [execCommand, writeStdin];
}

export type ExecCommandInput = Static<typeof execCommandSchema>;

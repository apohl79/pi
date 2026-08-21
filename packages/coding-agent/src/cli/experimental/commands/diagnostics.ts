import type { AuthInput } from "../auth.ts";
import { Command } from "../command.ts";
import { authTokenFileOption, authTokenOption, parseAuth, stringOption, transportOption } from "../command-options.ts";
import type { TransportAddress } from "../transport-address.ts";

export type DiagnosticsAction = "status" | "tail" | "timeline" | "export" | "verify" | "doctor";

export interface DiagnosticsCommand {
	readonly command: "diagnostics";
	readonly action: DiagnosticsAction;
	readonly auth?: AuthInput;
	readonly connect?: TransportAddress;
	readonly sessionId?: string;
	readonly operationId?: string;
	readonly afterSeq?: number;
	readonly output?: string;
	readonly bundle?: string;
}

export interface DiagnosticsCommandContext {
	runDiagnostics(command: DiagnosticsCommand): void | Promise<void>;
}

const connectOption = transportOption("--connect");
const sessionOption = stringOption("--session");
const operationOption = stringOption("--operation");
const outputOption = stringOption("--output");
const bundleOption = stringOption("--bundle");
const afterSeqOption = stringOption("--after-seq");

function parseSequence(value: string | undefined): { value?: number; error?: string } {
	if (value === undefined) return {};
	const sequence = Number(value);
	return Number.isSafeInteger(sequence) && sequence >= 0
		? { value: sequence }
		: { error: "--after-seq requires a non-negative integer" };
}

export const diagnosticsCommand = new Command<DiagnosticsCommand, DiagnosticsCommandContext>("diagnostics")
	.option(connectOption)
	.option(authTokenOption)
	.option(authTokenFileOption)
	.option(sessionOption)
	.option(operationOption)
	.option(outputOption)
	.option(bundleOption)
	.option(afterSeqOption)
	.build((input) => {
		const { auth, errors: authErrors } = parseAuth(input);
		const action = input.remainingArgs[0] as DiagnosticsAction | undefined;
		const actions: readonly DiagnosticsAction[] = ["status", "tail", "timeline", "export", "verify", "doctor"];
		const errors = [...authErrors];
		if (action === undefined || !actions.includes(action))
			errors.push("diagnostics requires status, tail, timeline, export, verify, or doctor");
		if (input.remainingArgs.length > (action === "timeline" || action === "verify" ? 2 : 1))
			errors.push(`diagnostics ${action ?? ""} accepts no extra positional arguments`);
		const positional = input.remainingArgs[1];
		const sessionId = input.value(sessionOption) ?? (action === "timeline" ? positional : undefined);
		const bundle = input.value(bundleOption) ?? (action === "verify" ? positional : undefined);
		const sequence = parseSequence(input.value(afterSeqOption));
		if (sequence.error) errors.push(sequence.error);
		if (action === "timeline" && sessionId === undefined) errors.push("diagnostics timeline requires a session id");
		if (action === "verify" && bundle === undefined)
			errors.push("diagnostics verify requires --bundle PATH or a bundle path");
		if (errors.length > 0) return { ok: false, errors };
		return {
			ok: true,
			command: {
				command: "diagnostics",
				action: action!,
				...(auth === undefined ? {} : { auth }),
				...(input.value(connectOption) === undefined ? {} : { connect: input.value(connectOption) }),
				...(sessionId === undefined ? {} : { sessionId }),
				...(input.value(operationOption) === undefined ? {} : { operationId: input.value(operationOption) }),
				...(sequence.value === undefined ? {} : { afterSeq: sequence.value }),
				...(input.value(outputOption) === undefined ? {} : { output: input.value(outputOption) }),
				...(bundle === undefined ? {} : { bundle }),
			},
		};
	})
	.action((command, context) => context.runDiagnostics(command));

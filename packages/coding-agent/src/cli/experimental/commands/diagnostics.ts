import type { AuthInput } from "../auth.ts";
import { Command, type CommandOption } from "../command.ts";
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
	readonly follow?: boolean;
	readonly decryptContent?: boolean;
	readonly repairSafe?: boolean;
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
const followOption: CommandOption<boolean> = {
	name: "--follow",
	takesValue: false,
	parse: () => ({ ok: true, value: true }),
};
const decryptContentOption: CommandOption<boolean> = {
	name: "--decrypt-content",
	takesValue: false,
	parse: () => ({ ok: true, value: true }),
};
const repairSafeOption: CommandOption<boolean> = {
	name: "--repair-safe",
	takesValue: false,
	parse: () => ({ ok: true, value: true }),
};

function parseSequence(value: string | undefined): { value?: number; error?: string } {
	if (value === undefined) return {};
	const sequence = Number(value);
	return Number.isSafeInteger(sequence) && sequence >= 0
		? { value: sequence }
		: { error: "--after-seq requires a non-negative integer" };
}

function optionsFor(action: DiagnosticsAction): readonly CommandOption<unknown>[] {
	return [
		connectOption,
		authTokenOption,
		authTokenFileOption,
		...(action === "timeline" || action === "tail" ? [sessionOption, operationOption, afterSeqOption] : []),
		...(action === "tail" ? [followOption] : []),
		...(action === "status" ? [sessionOption] : []),
		...(action === "export" ? [sessionOption, operationOption, outputOption, decryptContentOption] : []),
		...(action === "verify" ? [bundleOption] : []),
		...(action === "doctor" ? [repairSafeOption] : []),
	];
}

function actionCommand(action: DiagnosticsAction): Command<DiagnosticsCommand, DiagnosticsCommandContext> {
	let command = new Command<DiagnosticsCommand, DiagnosticsCommandContext>(action);
	for (const option of optionsFor(action)) command = command.option(option);
	return command
		.build((input) => {
			const { auth, errors: authErrors } = parseAuth(input);
			const errors = [...authErrors];
			const sequence = parseSequence(input.value(afterSeqOption));
			if (sequence.error) errors.push(sequence.error);
			const positional = input.remainingArgs[0];
			if (input.remainingArgs.length > (action === "timeline" || action === "tail" || action === "verify" ? 1 : 0))
				errors.push(`diagnostics ${action} accepts no extra positional arguments`);
			const sessionId =
				input.value(sessionOption) ?? (action === "timeline" || action === "tail" ? positional : undefined);
			const bundle = input.value(bundleOption) ?? (action === "verify" ? positional : undefined);
			if ((action === "timeline" || action === "tail") && sessionId === undefined)
				errors.push(`diagnostics ${action} requires a session id`);
			if (action === "verify" && bundle === undefined)
				errors.push("diagnostics verify requires --bundle PATH or a bundle path");
			if (
				action === "export" &&
				input.value(decryptContentOption) === true &&
				input.value(outputOption) === undefined
			)
				errors.push("diagnostics export --decrypt-content requires --output PATH");
			if (errors.length > 0) return { ok: false, errors };
			return {
				ok: true,
				command: {
					command: "diagnostics",
					action,
					...(auth === undefined ? {} : { auth }),
					...(input.value(connectOption) === undefined ? {} : { connect: input.value(connectOption) }),
					...(sessionId === undefined ? {} : { sessionId }),
					...(input.value(operationOption) === undefined ? {} : { operationId: input.value(operationOption) }),
					...(sequence.value === undefined ? {} : { afterSeq: sequence.value }),
					...(input.value(followOption) === undefined ? {} : { follow: input.value(followOption) }),
					...(input.value(decryptContentOption) === undefined
						? {}
						: { decryptContent: input.value(decryptContentOption) }),
					...(input.value(repairSafeOption) === undefined ? {} : { repairSafe: input.value(repairSafeOption) }),
					...(input.value(outputOption) === undefined ? {} : { output: input.value(outputOption) }),
					...(bundle === undefined ? {} : { bundle }),
				},
			};
		})
		.action((commandValue, context) => context.runDiagnostics(commandValue));
}

export const diagnosticsCommand = new Command<DiagnosticsCommand, DiagnosticsCommandContext>("diagnostics")
	.command(actionCommand("status"))
	.command(actionCommand("tail"))
	.command(actionCommand("timeline"))
	.command(actionCommand("export"))
	.command(actionCommand("verify"))
	.command(actionCommand("doctor"));

import type { AuthInput } from "../auth.ts";
import { Command } from "../command.ts";
import { authTokenFileOption, authTokenOption, parseAuth, transportOption } from "../command-options.ts";
import type { TransportAddress } from "../transport-address.ts";

export interface AttachCommand {
	readonly command: "attach";
	readonly sessionId?: string;
	readonly auth?: AuthInput;
	readonly connect?: TransportAddress;
}

export interface AttachCommandContext {
	runAttach(command: AttachCommand): void | Promise<void>;
}

const connectOption = transportOption("--connect");

export const attachCommand = new Command<AttachCommand, AttachCommandContext>("attach")
	.option(connectOption)
	.option(authTokenOption)
	.option(authTokenFileOption)
	.build((input) => {
		const { auth, errors: authErrors } = parseAuth(input);
		const errors = [...authErrors];
		if (input.remainingArgs.length > 1) errors.push("attach accepts at most one session id");
		if (input.remainingArgs.some((argument) => argument.startsWith("-")))
			errors.push("The experimental attach command does not support existing CLI options yet");
		if (errors.length > 0) return { ok: false, errors };
		return {
			ok: true,
			command: {
				command: "attach",
				...(input.remainingArgs[0] === undefined ? {} : { sessionId: input.remainingArgs[0] }),
				...(auth === undefined ? {} : { auth }),
				...(input.value(connectOption) === undefined ? {} : { connect: input.value(connectOption) }),
			},
		};
	})
	.action((command, context) => context.runAttach(command));

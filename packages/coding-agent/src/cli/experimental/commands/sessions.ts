import type { AuthInput } from "../auth.ts";
import { Command } from "../command.ts";
import { authTokenFileOption, authTokenOption, parseAuth, transportOption } from "../command-options.ts";
import type { TransportAddress } from "../transport-address.ts";

export interface SessionsCommand {
	readonly command: "sessions";
	readonly auth?: AuthInput;
	readonly connect?: TransportAddress;
}

export interface SessionsCommandContext {
	runSessions(command: SessionsCommand): void | Promise<void>;
}

const connectOption = transportOption("--connect");

export const sessionsCommand = new Command<SessionsCommand, SessionsCommandContext>("sessions")
	.option(connectOption)
	.option(authTokenOption)
	.option(authTokenFileOption)
	.build((input) => {
		const { auth, errors: authErrors } = parseAuth(input);
		const errors = [...authErrors];
		if (input.remainingArgs.length > 0) errors.push("sessions does not accept positional arguments");
		if (errors.length > 0) return { ok: false, errors };
		return {
			ok: true,
			command: {
				command: "sessions",
				...(auth === undefined ? {} : { auth }),
				...(input.value(connectOption) === undefined ? {} : { connect: input.value(connectOption) }),
			},
		};
	})
	.action((command, context) => context.runSessions(command));

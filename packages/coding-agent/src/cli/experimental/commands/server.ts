import type { AuthInput } from "../auth.ts";
import { Command } from "../command.ts";
import {
	authTokenFileOption,
	authTokenOption,
	parseAuth,
	parseLegacyOptions,
	transportOption,
	unsupportedLegacyOptions,
} from "../command-options.ts";
import type { TransportAddress } from "../transport-address.ts";

export interface ServerCommand {
	readonly command: "server";
	readonly action?: "start" | "status" | "stop";
	readonly auth?: AuthInput;
	readonly listen?: readonly TransportAddress[];
	readonly foreground?: boolean;
	readonly socket?: string;
}

export interface ServerCommandContext {
	runServer(command: ServerCommand): void | Promise<void>;
}

const listenOption = transportOption("--listen");
const foregroundOption = {
	name: "--foreground" as const,
	takesValue: false as const,
	parse: () => ({ ok: true as const, value: true }),
};
const socketOption = { name: "--socket" as const, parse: (value: string) => ({ ok: true as const, value }) };

const serverAction = (action: "status" | "stop") =>
	new Command<ServerCommand, ServerCommandContext>(action)
		.option(authTokenOption)
		.option(authTokenFileOption)
		.build((input) => {
			const { auth, errors: authErrors } = parseAuth(input);
			const { errors: optionErrors } = parseLegacyOptions(input);
			const errors = [...authErrors, ...optionErrors, ...unsupportedLegacyOptions("server", input)];
			if (errors.length > 0) return { ok: false, errors };
			return {
				ok: true,
				command: {
					command: "server",
					action,
					...(auth === undefined ? {} : { auth }),
				},
			};
		})
		.action((command, context) => context.runServer(command));

const serverStartCommand = new Command<ServerCommand, ServerCommandContext>("start")
	.option(foregroundOption)
	.option(socketOption)
	.option(authTokenOption)
	.option(authTokenFileOption)
	.build((input) => {
		const { auth, errors: authErrors } = parseAuth(input);
		const { errors: optionErrors } = parseLegacyOptions(input);
		const errors = [...authErrors, ...optionErrors, ...unsupportedLegacyOptions("server", input)];
		if (errors.length > 0) return { ok: false, errors };
		return {
			ok: true,
			command: {
				command: "server",
				action: "start",
				...(auth === undefined ? {} : { auth }),
				...(input.value(foregroundOption) === true ? { foreground: true } : {}),
				...(input.value(socketOption) === undefined ? {} : { socket: input.value(socketOption) }),
			},
		};
	})
	.action((command, context) => context.runServer(command));

export const serverCommand = new Command<ServerCommand, ServerCommandContext>("server")
	.option(listenOption)
	.option(authTokenOption)
	.option(authTokenFileOption)
	.build((input) => {
		const { auth, errors: authErrors } = parseAuth(input);
		const listen = input.values(listenOption);
		const { errors: optionErrors } = parseLegacyOptions(input);
		const errors = [...authErrors, ...optionErrors, ...unsupportedLegacyOptions("server", input)];
		if (errors.length > 0) return { ok: false, errors };
		return {
			ok: true,
			command: {
				command: "server",
				...(auth === undefined ? {} : { auth }),
				...(listen.length === 0 ? {} : { listen }),
			},
		};
	})
	.action((command, context) => context.runServer({ ...command, action: "start" }));

serverCommand.command(serverStartCommand).command(serverAction("status")).command(serverAction("stop"));

import { type AttachCommandContext, attachCommand } from "./commands/attach.ts";
import { type ClientCommandContext, clientCommand } from "./commands/client.ts";
import { type DiagnosticsCommandContext, diagnosticsCommand } from "./commands/diagnostics.ts";
import { type PiCommandContext, piCommand } from "./commands/pi.ts";
import { type ServerCommandContext, serverCommand } from "./commands/server.ts";
import { type SessionsCommandContext, sessionsCommand } from "./commands/sessions.ts";

export type ExperimentalCliContext = PiCommandContext &
	ServerCommandContext &
	ClientCommandContext &
	AttachCommandContext &
	SessionsCommandContext &
	DiagnosticsCommandContext;

export const experimentalCli = piCommand
	.command(serverCommand)
	.command(clientCommand)
	.command(attachCommand)
	.command(sessionsCommand)
	.command(diagnosticsCommand);

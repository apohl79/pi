import { type ExperimentalCliContext, experimentalCli } from "./cli.ts";

const EXPERIMENTAL_COMMANDS = new Set(["server", "client", "attach", "sessions"]);

export function isExperimentalCommand(args: readonly string[]): boolean {
	return args.length > 0 && EXPERIMENTAL_COMMANDS.has(args[0]!);
}

export async function dispatchExperimentalCommand(
	args: readonly string[],
	context: ExperimentalCliContext,
	writeError: (message: string) => void = (message) => console.error(message),
): Promise<boolean> {
	if (!isExperimentalCommand(args)) return false;
	const parsed = experimentalCli.parse(args);
	if (!parsed.ok) {
		for (const error of parsed.errors) writeError(error);
		return true;
	}
	await experimentalCli.execute(args, context);
	return true;
}

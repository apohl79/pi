import { type ChildProcess, spawn } from "node:child_process";
import type { V2ProcessStartRequest, V2PtyLauncher } from "@earendil-works/pi-server";

const FORBIDDEN_SHELL_CHARACTERS = new Set([";", "|", "&", ">", "<", "`", "$", "(", ")"]);

function parseArgv(command: string): string[] {
	if (command.length === 0 || command.length > 8_192) throw new Error("Process command must be 1-8192 characters");
	const argv: string[] = [];
	let token = "";
	let tokenStarted = false;
	let quote: "single" | "double" | undefined;
	for (let index = 0; index < command.length; index += 1) {
		const character = command[index]!;
		if (quote === "single") {
			if (character === "'") quote = undefined;
			else token += character;
			tokenStarted = true;
			continue;
		}
		if (quote === "double") {
			if (character === '"') quote = undefined;
			else if (character === "\\") {
				const next = command[++index];
				if (next === undefined) throw new Error("Process command has a trailing escape");
				token += next;
			} else token += character;
			tokenStarted = true;
			continue;
		}
		if (FORBIDDEN_SHELL_CHARACTERS.has(character)) throw new Error("Process command contains shell metacharacters");
		if (character === "'" || character === '"') {
			quote = character === "'" ? "single" : "double";
			tokenStarted = true;
		} else if (character === "\\") {
			const next = command[++index];
			if (next === undefined) throw new Error("Process command has a trailing escape");
			token += next;
			tokenStarted = true;
		} else if (/\s/.test(character)) {
			if (tokenStarted) {
				argv.push(token);
				token = "";
				tokenStarted = false;
			}
		} else {
			token += character;
			tokenStarted = true;
		}
	}
	if (quote !== undefined) throw new Error("Process command has an unterminated quote");
	if (tokenStarted) argv.push(token);
	if (argv.length === 0) throw new Error("Process command cannot be empty");
	return argv;
}

/** Host PTY launcher owned by the coding-agent daemon runtime. */
export function createCodingAgentNativePtyLauncher(): V2PtyLauncher {
	return {
		spawn(request: V2ProcessStartRequest): ChildProcess {
			if (process.platform === "win32") throw new Error("Native PTY execution requires a Windows host PTY launcher");
			const argv = parseArgv(request.command);
			const relay = [
				"import errno, os, pty, select, sys",
				"pid, fd = pty.fork()",
				"if pid == 0:",
				"    os.chdir(sys.argv[1])",
				"    os.execvpe(sys.argv[2], sys.argv[2:], os.environ)",
				"status = None",
				"while True:",
				"    readable, _, _ = select.select([fd, sys.stdin.buffer], [], [], 0.1)",
				"    if fd in readable:",
				"        try: os.write(1, os.read(fd, 4096))",
				"        except OSError as error:",
				"            if error.errno in (errno.EIO, errno.EBADF): break",
				"    if sys.stdin.buffer in readable:",
				"        data = os.read(0, 4096)",
				"        if not data: os.close(fd); break",
				"        os.write(fd, data)",
				"    waited, status = os.waitpid(pid, os.WNOHANG)",
				"    if waited == pid: break",
				"if status is None: _, status = os.waitpid(pid, 0)",
				"sys.exit(os.waitstatus_to_exitcode(status))",
			].join("\n");
			return spawn("python3", ["-c", relay, request.cwd ?? process.cwd(), ...argv], {
				cwd: request.cwd,
				env: { ...process.env, ...request.env },
				stdio: ["pipe", "pipe", "pipe"],
				detached: true,
			});
		},
	};
}

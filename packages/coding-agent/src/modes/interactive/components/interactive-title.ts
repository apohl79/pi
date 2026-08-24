import path from "node:path";
import { APP_TITLE } from "../../../config.ts";

export function formatInteractiveTerminalTitle(cwd: string, sessionName: string | undefined): string {
	const cwdBasename = path.basename(cwd);
	return sessionName ? `${APP_TITLE} - ${sessionName} - ${cwdBasename}` : `${APP_TITLE} - ${cwdBasename}`;
}

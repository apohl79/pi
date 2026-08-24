import { Text } from "@earendil-works/pi-tui";
import { APP_NAME } from "../../../config.ts";
import type { AppKeybinding } from "../../../core/keybindings.ts";
import { theme } from "../theme/theme.ts";
import { keyHint, keyText, rawKeyHint } from "./keybinding-hints.ts";

export interface Expandable {
	setExpanded(expanded: boolean): void;
}

export function isExpandable(component: unknown): component is Expandable {
	return (
		typeof component === "object" &&
		component !== null &&
		"setExpanded" in component &&
		typeof component.setExpanded === "function"
	);
}

export class ExpandableText extends Text implements Expandable {
	readonly #getCollapsedText: () => string;
	readonly #getExpandedText: () => string;

	constructor(
		getCollapsedText: () => string,
		getExpandedText: () => string,
		expanded = false,
		paddingX = 0,
		paddingY = 0,
	) {
		super(expanded ? getExpandedText() : getCollapsedText(), paddingX, paddingY);
		this.#getCollapsedText = getCollapsedText;
		this.#getExpandedText = getExpandedText;
	}

	setExpanded(expanded: boolean): void {
		this.setText(expanded ? this.#getExpandedText() : this.#getCollapsedText());
	}
}

/** Shared direct/server welcome card and interactive shortcut hints. */
export function createInteractiveStartupHeader(options: {
	readonly version: string;
	readonly expanded: boolean;
}): ExpandableText {
	const hint = (keybinding: AppKeybinding, description: string) => keyHint(keybinding, description);
	const expandedInstructions = [
		hint("app.interrupt", "to interrupt"),
		hint("app.clear", "to clear"),
		rawKeyHint(`${keyText("app.clear")} twice`, "to exit"),
		hint("app.exit", "to exit (empty)"),
		hint("app.suspend", "to suspend"),
		keyHint("tui.editor.deleteToLineEnd", "to delete to end"),
		hint("app.thinking.cycle", "to cycle thinking level"),
		rawKeyHint(`${keyText("app.model.cycleForward")}/${keyText("app.model.cycleBackward")}`, "to cycle models"),
		hint("app.model.select", "to select model"),
		hint("app.tools.expand", "to expand tools"),
		hint("app.thinking.toggle", "to expand thinking"),
		hint("app.editor.external", "for external editor"),
		rawKeyHint("/", "for commands"),
		rawKeyHint("!", "to run bash"),
		rawKeyHint("!!", "to run bash (no context)"),
		hint("app.message.followUp", "to queue follow-up"),
		hint("app.message.dequeue", "to edit all queued messages"),
		hint("app.clipboard.pasteImage", "to paste image (with text fallback)"),
		rawKeyHint("drop files", "to attach"),
	].join("\n");
	const compactInstructions = [
		hint("app.interrupt", "interrupt"),
		rawKeyHint(`${keyText("app.clear")}/${keyText("app.exit")}`, "clear/exit"),
		rawKeyHint("/", "commands"),
		rawKeyHint("!", "bash"),
		hint("app.tools.expand", "more"),
	].join(theme.fg("muted", " · "));
	const logo = theme.bold(theme.fg("accent", APP_NAME)) + theme.fg("dim", ` v${options.version}`);
	const compactOnboarding = theme.fg(
		"dim",
		`Press ${keyText("app.tools.expand")} to show full startup help and loaded resources.`,
	);
	const onboarding = theme.fg(
		"dim",
		"Pi can explain its own features and look up its docs. Ask it how to use or extend Pi.",
	);
	return new ExpandableText(
		() => `${logo}\n${compactInstructions}\n${compactOnboarding}\n\n${onboarding}`,
		() => `${logo}\n${expandedInstructions}\n\n${onboarding}`,
		options.expanded,
		1,
		0,
	);
}

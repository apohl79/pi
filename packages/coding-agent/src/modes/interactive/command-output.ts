import type { Keybinding, MarkdownTheme } from "@earendil-works/pi-tui";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import type { AppKeybinding, KeybindingsManager } from "../../core/keybindings.ts";
import { getChangelogPath, normalizeChangelogLinks, parseChangelog } from "../../utils/changelog.ts";
import { DynamicBorder } from "./components/dynamic-border.ts";
import { keyDisplayText } from "./components/keybinding-hints.ts";
import { theme } from "./theme/theme.ts";

export function createChangelogCommandOutput(markdownTheme: MarkdownTheme): Container {
	const entries = parseChangelog(getChangelogPath());
	const markdown =
		entries.length === 0
			? "No changelog entries found."
			: entries
					.reverse()
					.map((entry) => normalizeChangelogLinks(entry.content, entry))
					.join("\n\n");
	return createCommandOutput("What's New", markdown, markdownTheme);
}

export function createHotkeysCommandOutput(_keybindings: KeybindingsManager, markdownTheme: MarkdownTheme): Container {
	const editor = (action: Keybinding) => keyDisplayText(action);
	const app = (action: AppKeybinding) => keyDisplayText(action);
	const markdown = `
**Navigation**
| Key | Action |
|-----|--------|
| \`${editor("tui.editor.cursorUp")}\` / \`${editor("tui.editor.cursorDown")}\` / \`${editor("tui.editor.cursorLeft")}\` / \`${editor("tui.editor.cursorRight")}\` | Move cursor / browse history |
| \`${editor("tui.editor.cursorWordLeft")}\` / \`${editor("tui.editor.cursorWordRight")}\` | Move by word |
| \`${editor("tui.editor.cursorLineStart")}\` / \`${editor("tui.editor.cursorLineEnd")}\` | Start / end of line |
| \`${editor("tui.editor.pageUp")}\` / \`${editor("tui.editor.pageDown")}\` | Scroll by page |

**Editing**
| Key | Action |
|-----|--------|
| \`${editor("tui.input.submit")}\` | Send message |
| \`${editor("tui.input.newLine")}\` | New line |
| \`${editor("tui.editor.deleteWordBackward")}\` / \`${editor("tui.editor.deleteWordForward")}\` | Delete word |
| \`${editor("tui.editor.undo")}\` | Undo |

**Other**
| Key | Action |
|-----|--------|
| \`${editor("tui.input.tab")}\` | Path completion / accept autocomplete |
| \`${app("app.interrupt")}\` | Cancel autocomplete / abort streaming |
| \`${app("app.clear")}\` | Clear editor (first) / exit (second) |
| \`${app("app.exit")}\` | Exit when editor is empty |
| \`${app("app.thinking.cycle")}\` | Cycle thinking level |
| \`${app("app.model.cycleForward")}\` / \`${app("app.model.cycleBackward")}\` | Cycle models |
| \`${app("app.model.select")}\` | Open model selector |
| \`${app("app.tools.expand")}\` | Toggle tool output expansion |
| \`${app("app.message.copy")}\` | Copy last assistant message |
| \`${app("app.clipboard.pasteImage")}\` | Paste image or text from clipboard |
| \`/\` | Slash commands |
| \`!\` / \`!!\` | Run bash command / exclude it from context |
`;
	return createCommandOutput("Keyboard Shortcuts", markdown.trim(), markdownTheme);
}

function createCommandOutput(title: string, markdown: string, markdownTheme: MarkdownTheme): Container {
	const output = new Container();
	output.addChild(new Spacer(1));
	output.addChild(new DynamicBorder());
	output.addChild(new Text(theme.bold(theme.fg("accent", title)), 1, 0));
	output.addChild(new Spacer(1));
	output.addChild(new Markdown(markdown, 1, 1, markdownTheme));
	output.addChild(new DynamicBorder());
	return output;
}

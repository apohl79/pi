import type { AssistantMessage } from "@earendil-works/pi-ai/compat";
import { type Container, type MarkdownTheme, Spacer } from "@earendil-works/pi-tui";
import type { MarkdownTransformer } from "../../../core/extensions/types.ts";
import type { BranchSummaryMessage, CompactionSummaryMessage } from "../../../core/messages.ts";
import { AssistantMessageComponent } from "./assistant-message.ts";
import { BranchSummaryMessageComponent } from "./branch-summary-message.ts";
import { CompactionSummaryMessageComponent } from "./compaction-summary-message.ts";
import { UserMessageComponent } from "./user-message.ts";

/**
 * Shared presentation boundary for durable conversation content.
 *
 * Both local and server-backed sessions project their transcript through this
 * renderer so transport never determines message-card presentation.
 */
export class TranscriptRenderer {
	readonly #container: Container;
	readonly #getMarkdownTheme: () => MarkdownTheme;
	readonly #getHideThinkingBlock: () => boolean;
	readonly #getHiddenThinkingLabel: () => string;
	readonly #getOutputPad: () => number;
	readonly #getMarkdownTransformers: () => readonly MarkdownTransformer[];
	readonly #getToolOutputExpanded: () => boolean;

	constructor(options: {
		container: Container;
		getMarkdownTheme: () => MarkdownTheme;
		getHideThinkingBlock: () => boolean;
		getHiddenThinkingLabel: () => string;
		getOutputPad: () => number;
		getMarkdownTransformers: () => readonly MarkdownTransformer[];
		getToolOutputExpanded: () => boolean;
	}) {
		this.#container = options.container;
		this.#getMarkdownTheme = options.getMarkdownTheme;
		this.#getHideThinkingBlock = options.getHideThinkingBlock;
		this.#getHiddenThinkingLabel = options.getHiddenThinkingLabel;
		this.#getOutputPad = options.getOutputPad;
		this.#getMarkdownTransformers = options.getMarkdownTransformers;
		this.#getToolOutputExpanded = options.getToolOutputExpanded;
	}

	addUser(text: string): void {
		if (!text) return;
		if (this.#container.children.length > 0) this.#container.addChild(new Spacer(1));
		this.#container.addChild(
			new UserMessageComponent(
				text,
				this.#getMarkdownTheme(),
				this.#getOutputPad(),
				this.#getMarkdownTransformers(),
			),
		);
	}

	addAssistant(message: AssistantMessage): AssistantMessageComponent {
		const component = new AssistantMessageComponent(
			message,
			this.#getHideThinkingBlock(),
			this.#getMarkdownTheme(),
			this.#getHiddenThinkingLabel(),
			this.#getOutputPad(),
			this.#getMarkdownTransformers(),
		);
		this.#container.addChild(component);
		return component;
	}

	addCompactionSummary(message: CompactionSummaryMessage): void {
		this.#container.addChild(new Spacer(1));
		const component = new CompactionSummaryMessageComponent(message, this.#getMarkdownTheme());
		component.setExpanded(this.#getToolOutputExpanded());
		this.#container.addChild(component);
	}

	addBranchSummary(message: BranchSummaryMessage): void {
		this.#container.addChild(new Spacer(1));
		const component = new BranchSummaryMessageComponent(message, this.#getMarkdownTheme());
		component.setExpanded(this.#getToolOutputExpanded());
		this.#container.addChild(component);
	}
}

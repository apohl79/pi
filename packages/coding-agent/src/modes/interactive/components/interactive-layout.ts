import { type Component, TuiAltScreen, type TuiMainScreen, type ViewportTUI } from "@earendil-works/pi-tui";
import * as TuiLayouts from "@earendil-works/pi-tui";

/**
 * Transport-neutral interactive screen layout.
 *
 * A session implementation supplies transcript, editor, footer, and optional
 * dock regions; this class owns their regular and fullscreen arrangement.
 */
export class InteractiveLayout {
	readonly transcriptScrollView: TuiLayouts.ScrollView;
	readonly fullscreenRoot: Component;
	readonly #regularComponents: readonly Component[];

	constructor(options: {
		transcript: Component;
		pending: Component;
		status: Component;
		aboveEditor: Component;
		editor: Component;
		belowEditor: Component;
		footer: Component;
		scrollbar: Parameters<TuiLayouts.ScrollView["setScrollbar"]>[0];
		scrollbarStyle: (text: string) => string;
	}) {
		this.transcriptScrollView = new TuiLayouts.ScrollView(options.transcript, {
			follow: "end",
			primary: true,
			overscroll: "chain",
			scrollbar: options.scrollbar,
			scrollbarStyle: options.scrollbarStyle,
		});
		const dock = new TuiLayouts.VStack([
			{ component: options.pending, shrink: 1, minSize: 0 },
			{ component: options.status, shrink: 1, minSize: 0 },
			{ component: options.aboveEditor, shrink: 1, minSize: 0 },
			{ component: options.editor, shrink: 1, minSize: 3 },
			{ component: options.belowEditor, shrink: 1, minSize: 0 },
			{ component: options.footer, shrink: 1, minSize: 1 },
		]);
		this.fullscreenRoot = new TuiLayouts.VStack([
			{ component: this.transcriptScrollView, basis: 0, grow: 1, shrink: 1, minSize: 1 },
			{ component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
		]);
		this.#regularComponents = [
			options.transcript,
			options.pending,
			options.status,
			options.aboveEditor,
			options.editor,
			options.belowEditor,
			options.footer,
		];
	}

	mount(tui: TuiMainScreen | TuiAltScreen): void {
		for (const component of this.#regularComponents) tui.addChild(component);
		if (TuiLayouts.isViewportTUI(tui)) (tui as ViewportTUI).setLayoutRoot(this.fullscreenRoot);
	}

	setScrollbar(scrollbar: Parameters<TuiLayouts.ScrollView["setScrollbar"]>[0]): void {
		this.transcriptScrollView.setScrollbar(scrollbar);
	}
}

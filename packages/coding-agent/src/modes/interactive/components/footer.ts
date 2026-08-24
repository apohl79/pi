import { isAbsolute, relative, resolve, sep } from "node:path";
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentSession } from "../../../core/agent-session.ts";
import { areExperimentalFeaturesEnabled } from "../../../core/experimental.ts";
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.ts";
import { addUsageToTotals, createUsageTotals } from "../../../core/usage-totals.ts";
import type { StatuslineCommand, StatuslineRunner, StatuslineSnapshot } from "../../../server/statusline.ts";
import { stripAnsi } from "../../../utils/ansi.ts";
import { theme } from "../theme/theme.ts";

export interface FooterPresentationState {
	readonly model?: {
		readonly id: string;
		readonly name: string;
		readonly provider: string;
		readonly reasoning: boolean;
	};
	readonly thinkingLevel: string;
	readonly usage: ReturnType<typeof createUsageTotals>;
	readonly latestCacheHitRate?: number;
	readonly contextWindow: number;
	readonly contextPercent: number | null;
	readonly cwd: string;
	readonly sessionName?: string;
	readonly sessionId: string;
	readonly transcriptPath: string;
	readonly isStreaming: boolean;
	readonly connected: boolean;
	readonly detachable: boolean;
	readonly usingSubscription: boolean;
}

export interface FooterPresentationSource {
	getFooterPresentation(): FooterPresentationState;
}

export function createAgentSessionFooterPresentation(session: AgentSession): FooterPresentationSource {
	return {
		getFooterPresentation: () => {
			const usage = createUsageTotals();
			let latestCacheHitRate: number | undefined;
			for (const entry of session.sessionManager.getEntries()) {
				if (entry.type === "message" && entry.message.role === "assistant") {
					addUsageToTotals(usage, entry.message.usage);
					const promptTokens =
						entry.message.usage.input + entry.message.usage.cacheRead + entry.message.usage.cacheWrite;
					latestCacheHitRate = promptTokens > 0 ? (entry.message.usage.cacheRead / promptTokens) * 100 : undefined;
				} else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
					addUsageToTotals(usage, entry.message.usage);
				} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
					addUsageToTotals(usage, entry.usage);
				}
			}
			const contextUsage = session.getContextUsage();
			const model = session.state.model;
			return {
				...(model === undefined
					? {}
					: {
							model: {
								id: model.id,
								name: model.name,
								provider: model.provider,
								reasoning: model.reasoning,
							},
						}),
				thinkingLevel: session.state.thinkingLevel ?? "off",
				usage,
				...(latestCacheHitRate === undefined ? {} : { latestCacheHitRate }),
				contextWindow: contextUsage?.contextWindow ?? model?.contextWindow ?? 0,
				contextPercent: contextUsage?.percent ?? null,
				cwd: session.sessionManager.getCwd(),
				...(session.sessionManager.getSessionName() === undefined
					? {}
					: { sessionName: session.sessionManager.getSessionName() }),
				sessionId: session.sessionId ?? "",
				transcriptPath: session.sessionManager.getSessionFile?.() ?? "",
				isStreaming: session.isStreaming ?? false,
				connected: true,
				detachable: false,
				usingSubscription: model === undefined ? false : session.modelRuntime.isUsingSubscription(model.provider),
			};
		},
	};
}

/**
 * Sanitize text for display in a single-line status.
 * Removes newlines, tabs, carriage returns, and other control characters.
 */
function sanitizeStatusText(text: string): string {
	// Replace newlines, tabs, carriage returns with space, then collapse multiple spaces
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

/**
 * Format token counts for compact footer display.
 */
export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

export function formatCwdForFooter(cwd: string, home: string | undefined): string {
	if (!home) return cwd;

	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const relativeToHome = relative(resolvedHome, resolvedCwd);
	const isInsideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));

	if (!isInsideHome) return cwd;
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

export interface FooterStatuslineOptions {
	readonly runner?: StatuslineRunner;
	readonly command?: StatuslineCommand;
	readonly useColors?: boolean;
	readonly onUpdated?: () => void;
}

/**
 * Footer component that shows pwd, token stats, and context usage.
 * Computes token/context stats from session, gets git branch and extension statuses from provider.
 */
export class FooterComponent implements Component {
	private autoCompactEnabled = true;
	private source: FooterPresentationSource;
	private footerData: ReadonlyFooterDataProvider;
	private statuslineRunner: StatuslineRunner | undefined;
	private statuslineCommand: StatuslineCommand | undefined;
	private statuslineUseColors: boolean;
	private statuslineSnapshot: StatuslineSnapshot = { pending: false };
	private onStatuslineUpdated: (() => void) | undefined;

	constructor(
		source: FooterPresentationSource | AgentSession,
		footerData: ReadonlyFooterDataProvider,
		options: FooterStatuslineOptions = {},
	) {
		this.source = "getFooterPresentation" in source ? source : createAgentSessionFooterPresentation(source);
		this.footerData = footerData;
		this.statuslineRunner = options.runner;
		this.statuslineCommand = options.command;
		this.statuslineUseColors = options.useColors ?? true;
		this.onStatuslineUpdated = options.onUpdated;
	}

	setStatuslineCommand(command: StatuslineCommand | undefined): void {
		this.statuslineCommand = command;
	}

	setSession(session: AgentSession): void {
		this.source = createAgentSessionFooterPresentation(session);
	}

	setSource(source: FooterPresentationSource): void {
		this.source = source;
	}

	setAutoCompactEnabled(enabled: boolean): void {
		this.autoCompactEnabled = enabled;
	}

	/**
	 * No-op: git branch caching now handled by provider.
	 * Kept for compatibility with existing call sites in interactive-mode.
	 */
	invalidate(): void {
		// No-op: git branch is cached/invalidated by provider
	}

	/**
	 * Clean up resources.
	 * Git watcher cleanup now handled by provider.
	 */
	dispose(): void {
		// Git watcher cleanup handled by provider
		void this.statuslineRunner?.dispose();
	}

	render(width: number): string[] {
		const state = this.source.getFooterPresentation();
		const usageTotals = state.usage;
		const contextWindow = state.contextWindow;
		const contextPercentValue = state.contextPercent ?? 0;
		const contextPercent = state.contextPercent === null ? "?" : state.contextPercent.toFixed(1);

		// Replace home directory with ~
		let pwd = formatCwdForFooter(state.cwd, process.env.HOME || process.env.USERPROFILE);

		// Add git branch if available
		const branch = this.footerData.getGitBranch();
		if (branch) {
			pwd = `${pwd} (${branch})`;
		}

		// Add session name if set
		const sessionName = state.sessionName;
		if (sessionName) {
			pwd = `${pwd} • ${sessionName}`;
		}

		// Build stats line
		const statsParts = [];
		if (usageTotals.input) statsParts.push(`↑${formatTokens(usageTotals.input)}`);
		if (usageTotals.output) statsParts.push(`↓${formatTokens(usageTotals.output)}`);
		if (usageTotals.cacheRead) statsParts.push(`R${formatTokens(usageTotals.cacheRead)}`);
		if (usageTotals.cacheWrite) statsParts.push(`W${formatTokens(usageTotals.cacheWrite)}`);
		if ((usageTotals.cacheRead > 0 || usageTotals.cacheWrite > 0) && state.latestCacheHitRate !== undefined) {
			statsParts.push(`CH${state.latestCacheHitRate.toFixed(1)}%`);
		}

		// Kimi Coding is subscription-backed despite using API-key authentication.
		const usingSubscription = state.model ? state.model.provider === "kimi-coding" || state.usingSubscription : false;
		if (usageTotals.cost || usingSubscription) {
			const costStr = `$${usageTotals.cost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`;
			statsParts.push(costStr);
		}

		// Colorize context percentage based on usage
		let contextPercentStr: string;
		const autoIndicator = this.autoCompactEnabled ? " (auto)" : "";
		const contextPercentDisplay =
			contextPercent === "?"
				? `?/${formatTokens(contextWindow)}${autoIndicator}`
				: `${contextPercent}%/${formatTokens(contextWindow)}${autoIndicator}`;
		if (contextPercentValue > 90) {
			contextPercentStr = theme.fg("error", contextPercentDisplay);
		} else if (contextPercentValue > 70) {
			contextPercentStr = theme.fg("warning", contextPercentDisplay);
		} else {
			contextPercentStr = contextPercentDisplay;
		}
		statsParts.push(contextPercentStr);
		if (areExperimentalFeaturesEnabled()) {
			statsParts.push(`${theme.fg("dim", "•")} ${theme.bold(theme.fg("warning", "xp"))}`);
		}

		let statsLeft = statsParts.join(" ");

		// Add model name on the right side, plus thinking level if model supports it
		const modelName = state.model?.id || "no-model";

		let statsLeftWidth = visibleWidth(statsLeft);

		// If statsLeft is too wide, truncate it
		if (statsLeftWidth > width) {
			statsLeft = truncateToWidth(statsLeft, width, "...");
			statsLeftWidth = visibleWidth(statsLeft);
		}

		// Calculate available space for padding (minimum 2 spaces between stats and model)
		const minPadding = 2;

		// Add thinking level indicator if model supports reasoning
		let rightSideWithoutProvider = modelName;
		if (state.model?.reasoning) {
			const thinkingLevel = state.thinkingLevel || "off";
			rightSideWithoutProvider =
				thinkingLevel === "off" ? `${modelName} • thinking off` : `${modelName} • ${thinkingLevel}`;
		}

		// Prepend the provider in parentheses if there are multiple providers and there's enough room
		let rightSide = rightSideWithoutProvider;
		if (this.footerData.getAvailableProviderCount() > 1 && state.model) {
			rightSide = `(${state.model!.provider}) ${rightSideWithoutProvider}`;
			if (statsLeftWidth + minPadding + visibleWidth(rightSide) > width) {
				// Too wide, fall back
				rightSide = rightSideWithoutProvider;
			}
		}

		const rightSideWidth = visibleWidth(rightSide);
		const totalNeeded = statsLeftWidth + minPadding + rightSideWidth;

		let statsLine: string;
		if (totalNeeded <= width) {
			// Both fit - add padding to right-align model
			const padding = " ".repeat(width - statsLeftWidth - rightSideWidth);
			statsLine = statsLeft + padding + rightSide;
		} else {
			// Need to truncate right side
			const availableForRight = width - statsLeftWidth - minPadding;
			if (availableForRight > 0) {
				const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
				const truncatedRightWidth = visibleWidth(truncatedRight);
				const padding = " ".repeat(Math.max(0, width - statsLeftWidth - truncatedRightWidth));
				statsLine = statsLeft + padding + truncatedRight;
			} else {
				// Not enough space for right side at all
				statsLine = statsLeft;
			}
		}

		// Apply dim to each part separately. statsLeft may contain color codes (for context %)
		// that end with a reset, which would clear an outer dim wrapper. So we dim the parts
		// before and after the colored section independently.
		const dimStatsLeft = theme.fg("dim", statsLeft);
		const remainder = statsLine.slice(statsLeft.length); // padding + rightSide
		const dimRemainder = theme.fg("dim", remainder);

		const pwdLine = truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "..."));
		const lines = [pwdLine, dimStatsLeft + dimRemainder];

		// Add extension statuses on a single line, sorted by key alphabetically
		const extensionStatuses = this.footerData.getExtensionStatuses();
		if (extensionStatuses.size > 0) {
			const sortedStatuses = Array.from(extensionStatuses.entries())
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([, text]) => sanitizeStatusText(text));
			const statusLine = sortedStatuses.join(" ");
			// Truncate to terminal width with dim ellipsis for consistency with footer style
			lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
		}

		if (this.statuslineRunner) {
			const payload = {
				harness: "pi",
				session_id: state.sessionId,
				transcript_path: state.transcriptPath,
				cwd: state.cwd,
				session_name: state.sessionName ?? "",
				model: state.model
					? { id: state.model.id, display_name: state.model.name, provider: state.model.provider }
					: undefined,
				effort: { level: state.thinkingLevel },
				workspace: { current_dir: state.cwd },
				cost: { total_cost_usd: usageTotals.cost },
				context_window: {
					total_input_tokens: usageTotals.input,
					total_output_tokens: usageTotals.output,
					context_window_size: contextWindow,
					used_percentage: contextPercentValue,
					remaining_percentage: Math.max(0, 100 - contextPercentValue),
				},
				server: {
					connected: state.connected,
					phase: state.isStreaming ? "turn" : "idle",
					detachable: state.detachable,
				},
			};
			void this.statuslineRunner.update(payload, this.statuslineCommand).then((snapshot) => {
				if (JSON.stringify(snapshot) === JSON.stringify(this.statuslineSnapshot)) return;
				this.statuslineSnapshot = snapshot;
				this.onStatuslineUpdated?.();
			});
			if (this.statuslineSnapshot.output) {
				lines.push(
					this.statuslineUseColors ? this.statuslineSnapshot.output : stripAnsi(this.statuslineSnapshot.output),
				);
			} else if (this.statuslineSnapshot.error) {
				lines.push(`statusline error: ${this.statuslineSnapshot.error}`);
			}
		}

		return lines;
	}
}

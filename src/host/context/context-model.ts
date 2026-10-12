import * as path from "node:path";
import { relativeAge } from "../../views/relative-age.ts";
import { contextTokenLabel, sessionCostLabel } from "../../webview/lib/context-indicator.ts";
import { fmtPercent, fmtTokens } from "../../webview/lib/format.ts";
import type { ChatLiteModel, ChatModel } from "../../chat/model.ts";
import type { MaintenanceState } from "../../chat/events.ts";
import type { JournalFacts } from "../session-cost.ts";
import type { ContextRead, ContextReportRead, PromptContextFiles } from "./context-parse.ts";

/**
 * The Context view's pure projection (design: Context view). Live facts come from the Chat model, the same object the
 * footer's popover reads; the deep read adds what OMP's other read-only surfaces report; the breakdown is OMP's own
 * `/context` report from one explicit request. Nothing here estimates a number.
 */

/** The popover's thresholds (`ContextUsageIndicator`): warning from 70 %, critical above 90 %. */
export const WARNING_PERCENT = 70;
export const CRITICAL_PERCENT = 90;

export interface ContextSubject {
	readonly title: string;
	readonly mode: "chat" | "terminal";
	readonly running: boolean;
}

/** What `model.state` and the Chat model say right now: no I/O. */
export interface ContextLive {
	readonly model: ChatLiteModel | null;
	readonly usage: { readonly tokens: number | null; readonly contextWindow: number | null; readonly percent: number | null } | null;
	/** A turn, a compaction or a maintenance pass is in progress. Refreshes of an existing deep read wait for it to end. */
	readonly busy: boolean;
	/** A compaction or a maintenance pass is rewriting the conversation: no deep read runs until it ends (a turn alone does not stop one). */
	readonly rewriting: boolean;
	readonly maintenance: MaintenanceState | null;
}

export function liveOf(model: ChatModel): ContextLive {
	const state = model.state;
	return {
		model: state?.model ?? null,
		usage: state?.contextUsage ?? null,
		busy: model.working || model.asyncPaused || state?.isCompacting === true || model.maintenance?.status === "working",
		rewriting: state?.isCompacting === true || model.maintenance?.status === "working",
		maintenance: model.maintenance,
	};
}

/** A change of this string is a change the tree shows; streaming deltas leave it alone. */
export function liveSignature(live: ContextLive): string {
	const maintenance = live.maintenance;
	return JSON.stringify([live.model?.provider, live.model?.id, live.model?.name, live.model?.contextWindow, live.usage?.tokens, live.usage?.contextWindow,
		live.usage?.percent, live.busy, live.rewriting, maintenance?.action, maintenance?.status, maintenance?.reason, maintenance?.errorMessage]);
}

export type ItemTone = "normal" | "warning" | "critical" | "muted";
export interface ContextItem {
	readonly key: string;
	readonly label: string;
	readonly description: string | null;
	/** Plain text, never Markdown. */
	readonly tooltip: string;
	/** A codicon id. */
	readonly icon: string;
	readonly tone: ItemTone;
	/** Absolute file to open on click, or `null`. */
	readonly openPath: string | null;
	/** The view command a click runs, or `null`. */
	readonly action: "readBreakdown" | null;
}
export interface ContextGroup {
	readonly id: string;
	readonly label: string;
	readonly description: string | null;
	readonly tooltip: string | null;
	readonly items: readonly ContextItem[];
}
export interface ContextViewModel {
	/** The session title, shown beside the view name. */
	readonly description: string | null;
	/** Replaces the tree when set: the view has nothing to list. */
	readonly message: string | null;
	readonly groups: readonly ContextGroup[];
	/** The viewed session is a live Chat: Compact, Shake and the breakdown request apply. */
	readonly canMaintain: boolean;
}

export const NO_SESSION_MESSAGE = "Open an OMP Chat to see its context.";
export const TERMINAL_MESSAGE = "This session is open as a Terminal. OMP reports its context only to a Chat editor.";
export const NOT_RUNNING_MESSAGE = "This session is not running, so OMP reports no context.";
export const READING_MESSAGE = "Reading context…";

export interface ContextInputs {
	readonly subject: ContextSubject | null;
	readonly live: ContextLive | null;
	readonly read: ContextRead | null;
	/** The last `/context` report an explicit request read, or `null`. */
	readonly report: ContextReportRead | null;
	readonly now: number;
}

const COUNT = new Intl.NumberFormat("en-US");

interface ItemOptions { readonly tone?: ItemTone; readonly openPath?: string; readonly action?: "readBreakdown" }
function item(key: string, label: string, description: string | null, tooltip: string, icon: string, options: ItemOptions = {}): ContextItem {
	return { key, label, description, tooltip, icon, tone: options.tone ?? "normal", openPath: options.openPath ?? null, action: options.action ?? null };
}

function group(id: string, label: string, items: readonly ContextItem[], extra: { description?: string | null; tooltip?: string | null } = {}): ContextGroup {
	return { id, label, description: extra.description ?? null, tooltip: extra.tooltip ?? null, items };
}

/** The view's whole content for one subject. */
export function projectContext(inputs: ContextInputs): ContextViewModel {
	const { subject, live, read, report } = inputs;
	const empty = (message: string, description: string | null = null): ContextViewModel => ({ description, message, groups: [], canMaintain: false });
	if (subject === null) return empty(NO_SESSION_MESSAGE);
	if (subject.mode === "terminal") return empty(TERMINAL_MESSAGE, subject.title);
	if (!subject.running || live === null) return empty(NOT_RUNNING_MESSAGE, subject.title);
	if (read === null && live.usage === null && live.model === null) return empty(READING_MESSAGE, subject.title);
	const groups = [windowGroup(live), breakdownGroup(live, report), ...(read === null ? [] : [statsGroup(read)]), maintenanceGroup(live, read),
		...(read === null ? [] : [historyGroup(read, inputs.now)]), ...(read?.files == null ? [] : filesGroup(read.files))];
	return { description: subject.title, message: null, groups, canMaintain: true };
}

function windowGroup(live: ContextLive): ContextGroup {
	const items: ContextItem[] = [];
	const model = live.model;
	const usage = live.usage;
	if (model !== null) {
		items.push(item("window.model", model.name ?? model.id, model.contextWindow === null ? model.provider : `${model.provider} · ${contextTokenLabel(model.contextWindow)} window`,
			`Model ${model.provider}/${model.id}. The window is the model's own, as OMP reports it.`, "chip"));
	}
	const window = usage?.contextWindow ?? model?.contextWindow ?? null;
	const percent = usage?.percent != null && Number.isFinite(usage.percent) ? Math.min(100, Math.max(0, usage.percent)) : null;
	const tone: ItemTone = percent === null ? "muted" : percent > CRITICAL_PERCENT ? "critical" : percent >= WARNING_PERCENT ? "warning" : "normal";
	items.push(item("window.used", percent === null ? "Usage unavailable" : `${fmtPercent(percent)} used`, `${contextTokenLabel(usage?.tokens)} / ${contextTokenLabel(window)} tokens`,
		"Context window usage exactly as the Chat footer's ring shows it. OMP estimates the tokens: the provider's last reported usage plus a local estimate for what came after. "
			+ "An unknown percentage is never computed from the token counts.", "dashboard", { tone }));
	return group("window", "Context window", items);
}

function percentOfWindow(tokens: number, window: number | null): string | null {
	if (window === null || window <= 0) return null;
	const percent = tokens / window * 100;
	return `${percent < 10 ? percent.toFixed(1) : Math.round(percent)}% of window`;
}

const BREAKDOWN_REQUEST = "Runs OMP's /context in this conversation, as if you typed it: its report also appears in the Chat. OMP offers the category breakdown only as that report.";

function breakdownGroup(live: ContextLive, read: ContextReportRead | null): ContextGroup {
	const tooltip = "OMP's own /context report. Auto-compact buffer and Free are reserved or empty space, not tokens in use. OMP reports no per-rule, per-skill or per-file counts. "
		+ "The report is read when you ask for it and is not refreshed by itself.";
	if (read === null) {
		return group("breakdown", "Breakdown", [item("breakdown.read", "Read breakdown", "runs /context", BREAKDOWN_REQUEST, "graph", { action: "readBreakdown" })], { tooltip });
	}
	const when = new Date(read.at).toLocaleTimeString();
	const moved = read.usageTokensAtRead !== null && live.usage?.tokens != null && live.usage.tokens !== read.usageTokensAtRead;
	const description = moved ? `as of ${when}; usage has changed since` : `as of ${when}`;
	const again = item("breakdown.read", "Read again", "runs /context", BREAKDOWN_REQUEST, "refresh", { action: "readBreakdown" });
	if (read.report.unavailable !== null) {
		return group("breakdown", "Breakdown", [item("breakdown.none", "Breakdown unavailable", null, read.report.unavailable, "circle-slash", { tone: "muted" }), again], { description, tooltip });
	}
	const report = read.report;
	const rows = report.rows.map((row, index) => {
		const reserved = row.label === "Auto-compact buffer" || row.label === "Free";
		const share = percentOfWindow(row.tokens, report.contextWindow);
		return item(`breakdown.${index}`, row.label, [`${COUNT.format(row.tokens)} tokens`, share].filter(Boolean).join(" · "),
			`${row.label}: ${COUNT.format(row.tokens)} tokens${share === null ? "" : ` (${share})`}.${reserved ? " Not tokens in use." : ""}`, reserved ? "circle-outline" : "symbol-number", { tone: reserved ? "muted" : "normal" });
	});
	report.notes.forEach((note, index) => rows.push(item(`breakdown.note.${index}`, note, null, note, "info", { tone: "muted" })));
	return group("breakdown", "Breakdown", [...rows, again], { description, tooltip });
}

function statsGroup(read: ContextRead): ContextGroup {
	const stats = read.stats;
	const items: ContextItem[] = [];
	if (stats !== null) {
		items.push(item("stats.messages", "Messages", `${COUNT.format(stats.totalMessages)} · ${stats.userMessages} user · ${stats.assistantMessages} assistant · ${stats.toolResults} tool results`,
			"Messages OMP currently keeps in the context.", "comment-discussion"));
		items.push(item("stats.tools", "Tool calls", COUNT.format(stats.toolCalls), "Tool calls by the assistant in the messages OMP currently keeps.", "tools"));
		const tokens = stats.tokens;
		const extra = [tokens.cacheRead > 0 ? `cache read ${fmtTokens(tokens.cacheRead)}` : null, tokens.cacheWrite > 0 ? `cache write ${fmtTokens(tokens.cacheWrite)}` : null,
			tokens.reasoning > 0 ? `reasoning ${fmtTokens(tokens.reasoning)}` : null].filter(value => value !== null);
		items.push(item("stats.tokens", "Billed tokens", [`input ${fmtTokens(tokens.input)}`, `output ${fmtTokens(tokens.output)}`, ...extra].join(" · "),
			"Tokens billed by the model calls that belong to the context OMP currently keeps. Every call bills its whole prompt again, so input is not the context size.", "arrow-swap"));
		if (stats.premiumRequests > 0) items.push(item("stats.premium", "Premium requests", `${Number(stats.premiumRequests.toFixed(2))}`, "Premium requests charged for the same model calls, at the model's multiplier.", "star"));
	}
	if (items.length === 0) items.push(item("stats.none", "Statistics unavailable", null, "OMP did not answer get_session_stats.", "circle-slash", { tone: "muted" }));
	return group("stats", "This context window", items, { tooltip: "OMP's get_session_stats: the messages OMP currently keeps in the context and the model calls billed for them. After a compaction this still includes the recent messages it kept." });
}

function maintenanceGroup(live: ContextLive, read: ContextRead | null): ContextGroup {
	const items: ContextItem[] = [];
	if (read?.autoCompaction != null) {
		items.push(item("maintenance.auto", "Auto-compaction", read.autoCompaction ? "on" : "off", "Whether OMP compacts automatically when the context nears its threshold (get_state).", "settings-gear"));
	}
	const pass = live.maintenance;
	if (pass !== null) {
		const running = pass.status === "working";
		items.push(item("maintenance.pass", running ? `${pass.action} in progress` : `Last pass seen: ${pass.action}`, [pass.status, pass.reason ?? null].filter(Boolean).join(" · "),
			`${running ? "A maintenance pass is running" : "The last maintenance pass this window saw"}: ${pass.action}, ${pass.status}${pass.reason === undefined ? "" : `, ${pass.reason}`}.${pass.errorMessage === undefined ? "" : ` ${pass.errorMessage.slice(0, 300)}`}`,
			running ? "sync~spin" : pass.status === "failed" ? "error" : "history", { tone: pass.status === "failed" ? "warning" : "normal" }));
	}
	return group("maintenance", "Maintenance", items.length === 0 ? [item("maintenance.none", "No pass seen", null, "This window has seen no compaction or shake pass.", "history", { tone: "muted" })] : items,
		{ tooltip: "Shake leaves no record in the session file, so only a pass this window saw is listed. Compact and Shake are in the view's title bar." });
}

function kept(compaction: NonNullable<JournalFacts["lastCompaction"]>): string {
	const sizes = compaction.tokensBefore === null ? null : compaction.tokensAfter === null ? `${fmtTokens(compaction.tokensBefore)} tokens before` : `${fmtTokens(compaction.tokensBefore)} → ${fmtTokens(compaction.tokensAfter)} tokens`;
	return [compaction.method ?? "method not recorded", sizes].filter(Boolean).join(" · ");
}

/** Whole-file facts: spend, and the compaction and clear boundaries the session file records on any branch. */
function historyGroup(read: ContextRead, now: number): ContextGroup {
	const journal = read.journal;
	const tooltip = "Read from the session file, every branch of it, abandoned branches included (the scope of OMP's own cost figure). A clear boundary is written before the live reset completes, so it does not prove the clear finished.";
	if (journal === null) return group("history", "Session file", [item("history.none", "Session file not read", null, "The session file could not be read, so spend and boundaries are not listed.", "circle-slash", { tone: "muted" })], { tooltip });
	const items: ContextItem[] = [];
	if (sessionCostLabel(journal.cost) !== null) {
		items.push(item("history.cost", "Session cost", `$${journal.cost.toFixed(2)}`, "Spend across the whole session file, compacted history and abandoned branches included, as the Chat footer shows it.", "credit-card"));
	}
	items.push(item("history.count", "Compactions", `${journal.compactionCount} recorded`, "Compaction entries in the session file.", "fold"));
	const last = journal.lastCompaction;
	if (last !== null) {
		items.push(item("history.last", "Last compaction", `${relativeAge(last.timestamp, now)} · ${kept(last)}`,
			`${last.timestamp}. ${kept(last)}.${last.warning === null ? "" : ` Warning: ${last.warning.slice(0, 300)}`}`, "history", { tone: last.warning === null ? "normal" : "warning" }));
	}
	items.push(item("history.clear", "Last clear boundary", journal.lastClear === null ? "none recorded" : relativeAge(journal.lastClear, now),
		journal.lastClear === null ? "No /clear boundary is recorded in the session file." : `${journal.lastClear}. The newest /clear boundary entry in the session file.`, "clear-all"));
	return group("history", "Session file", items, { tooltip });
}

function filesGroup(files: PromptContextFiles): ContextGroup[] {
	const rows: ContextItem[] = [];
	files.files.forEach((file, index) => rows.push(item(`files.${index}`, path.win32.basename(file.path), `${path.win32.dirname(file.path)} · ${COUNT.format(file.chars)} chars`,
		`${file.path}\n${COUNT.format(file.chars)} characters in the prompt. OMP reports no token count per file; these files are counted inside System context. A path taken from OMP's prompt text, not verified against the file system.`, "file", { openPath: file.path })));
	files.onDemand.forEach((file, index) => rows.push(item(`files.demand.${index}`, path.win32.basename(file), `read on demand · ${path.win32.dirname(file)}`,
		`${file}\nOMP asks the agent to read this file before it changes files in its directory; it is not in the prompt. A path taken from OMP's prompt text.`, "file-symlink-file", { tone: "muted", openPath: file })));
	if (rows.length === 0) return [];
	return [group("files", "Context files", rows, { tooltip: "Paths extracted from the system prompt OMP rendered for this session (AGENTS.md and similar, and rule files of directories the agent reads on demand). OMP does not export a list of loaded files; prompt text can itself contain such markers, so treat the list as references. A click opens the file." })];
}

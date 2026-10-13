/**
 * Pure text, selection and severity rules of the provider-usage status bar item. No `vscode` here: the
 * wiring (`src/wiring/usage-status-wiring.ts`) only hands this module a reading and shows what it returns.
 * The windows come from the Chat footer's `FooterUsage` (`provider-usage.ts`); nothing is derived from tokens.
 */
import { quotaUsedPercent } from "../shared/context-indicator.ts";

/** A quota window as the footer carries it; a field a provider did not report may be absent. */
export interface UsageStatusWindow {
	label: string;
	usedPercent?: number | null;
	/** Epoch milliseconds when the window resets. */
	resetsAt?: number | null;
}

/** What the active Chat tab knows about its provider's limits. */
export interface UsageStatusSource {
	provider: string | null;
	windows: readonly UsageStatusWindow[];
	accountSelection: string | null;
	/** Epoch milliseconds of the last successful `omp usage` read; `null` when unknown. */
	readAt: number | null;
}

export type UsageSeverity = "none" | "warning" | "error";

export interface UsageStatusModel {
	/** `5h - 42% - 2:13 7d - 18% - 3:04:00`. */
	text: string;
	severity: UsageSeverity;
	/** Plain multi-line text: provider, one line per window, the account note and the reading's age. */
	tooltip: string;
}

export const USAGE_WARNING_PERCENT = 80;
export const USAGE_ERROR_PERCENT = 95;
/** The two windows the compact form is about; any other window is shown only when neither exists. */
const PRIMARY_LABELS = ["5h", "7d"] as const;
const MINUTE_MS = 60_000;

const pad2 = (value: number): string => String(value).padStart(2, "0");

/**
 * Time left until `resetsAt`, rounded up to whole minutes so it never reads 0 before the reset.
 * Leading zero components are dropped, inner ones are padded to two digits: `2:03:05`, `4:07`, `9`, `1:00:00`.
 * Returns `null` when the reset time is missing, not a finite number, or not in the future.
 */
export function formatResetCountdown(resetsAt: number | null | undefined, now: number): string | null {
	if (typeof resetsAt !== "number" || !Number.isFinite(resetsAt) || !Number.isFinite(now)) return null;
	const remaining = resetsAt - now;
	if (remaining <= 0) return null;
	const total = Math.ceil(remaining / MINUTE_MS);
	const days = Math.floor(total / 1440);
	const hours = Math.floor(total % 1440 / 60);
	const minutes = total % 60;
	if (days > 0) return `${days}:${pad2(hours)}:${pad2(minutes)}`;
	if (hours > 0) return `${hours}:${pad2(minutes)}`;
	return String(minutes);
}

const percentOf = (window: UsageStatusWindow): number | null =>
	typeof window.usedPercent === "number" && Number.isFinite(window.usedPercent) && window.usedPercent >= 0
		? quotaUsedPercent({ label: window.label, usedPercent: window.usedPercent })
		: null;

/**
 * The windows the item shows: `5h` then `7d` when the provider reports either; otherwise every window the
 * projection gave, in its order. A window that reports neither a percent nor a reset time carries nothing to show.
 */
export function selectUsageWindows(windows: readonly UsageStatusWindow[]): UsageStatusWindow[] {
	const informative = windows.filter(window => percentOf(window) !== null || (typeof window.resetsAt === "number" && Number.isFinite(window.resetsAt)));
	const primary = PRIMARY_LABELS.flatMap(label => informative.filter(window => window.label === label).slice(0, 1));
	return primary.length > 0 ? primary : informative;
}

/** `5h - 42% - 2:13`; a missing percent or an unavailable countdown leaves its part out. */
export function formatUsageWindow(window: UsageStatusWindow, now: number): string {
	const percent = percentOf(window);
	const countdown = formatResetCountdown(window.resetsAt, now);
	return [window.label, ...(percent === null ? [] : [`${percent}%`]), ...(countdown === null ? [] : [countdown])].join(" - ");
}

/**
 * Warning from 80 %, error from 95 % of any shown window, measured on the percent the text shows.
 * A window whose reset time has passed describes a limit that no longer applies and does not count.
 */
export function usageSeverity(windows: readonly UsageStatusWindow[], now: number): UsageSeverity {
	let severity: UsageSeverity = "none";
	for (const window of windows) {
		const percent = percentOf(window);
		const resetPassed = typeof window.resetsAt === "number" && Number.isFinite(window.resetsAt) && formatResetCountdown(window.resetsAt, now) === null;
		if (percent === null || resetPassed) continue;
		if (percent >= USAGE_ERROR_PERCENT) return "error";
		if (percent >= USAGE_WARNING_PERCENT) severity = "warning";
	}
	return severity;
}

/** `just now`, `3 min ago`, `2 h ago`, `1 d ago`; a clock that ran backwards reads as `just now`. */
export function formatReadingAge(readAt: number | null | undefined, now: number): string {
	if (typeof readAt !== "number" || !Number.isFinite(readAt)) return "Reading time unknown";
	const minutes = Math.floor(Math.max(0, now - readAt) / MINUTE_MS);
	if (minutes < 1) return "Read just now";
	if (minutes < 60) return `Read ${minutes} min ago`;
	if (minutes < 1440) return `Read ${Math.floor(minutes / 60)} h ago`;
	return `Read ${Math.floor(minutes / 1440)} d ago`;
}

const defaultLocalTime = (epochMs: number): string => new Date(epochMs).toLocaleString();

function tooltipLine(window: UsageStatusWindow, now: number, localTime: (epochMs: number) => string): string {
	const percent = percentOf(window);
	const parts = [percent === null ? `${window.label}: percent not reported` : `${window.label}: ${percent}% used`];
	if (typeof window.resetsAt === "number" && Number.isFinite(window.resetsAt)) {
		const countdown = formatResetCountdown(window.resetsAt, now);
		parts.push(countdown === null ? `reset time ${localTime(window.resetsAt)} has passed; waiting for the next refresh` : `resets ${localTime(window.resetsAt)} (in ${countdown})`);
	}
	return parts.join(" · ");
}

/**
 * The item's text, severity and tooltip, or `null` (hide the item) when there is no provider, no reading
 * or nothing to show.
 */
export function buildUsageStatus(source: UsageStatusSource | null, now: number, localTime: (epochMs: number) => string = defaultLocalTime): UsageStatusModel | null {
	if (source === null || source.provider === null || source.provider.length === 0) return null;
	const shown = selectUsageWindows(source.windows);
	if (shown.length === 0) return null;
	const tooltip = [
		`OMP Desk provider usage: ${source.provider}`,
		...shown.map(window => tooltipLine(window, now, localTime)),
		...(source.accountSelection === null ? [] : [source.accountSelection]),
		`${formatReadingAge(source.readAt, now)}. Click to refresh.`,
	].join("\n");
	return { text: shown.map(window => formatUsageWindow(window, now)).join(" "), severity: usageSeverity(shown, now), tooltip };
}

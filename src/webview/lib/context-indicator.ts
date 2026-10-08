import { fmtTokens } from "./format.ts";
import type { FooterQuotaWindow } from "../footer-metadata.ts";

/** Compact native token counts; unknown counts are not inferred from the percentage. */
export function contextTokenLabel(value: number | null | undefined): string {
	if (value == null || !Number.isFinite(value) || value < 0) return "?";
	return fmtTokens(value);
}

/** OMP's zero total does not distinguish unpriced usage from a genuinely free session. */
export function sessionCostLabel(value: number | null | undefined): string | null {
	return value != null && Number.isFinite(value) && value > 0 ? `Session cost $${value.toFixed(2)}` : null;
}

export function quotaUsedPercent(window: Pick<FooterQuotaWindow, "label" | "usedPercent">): number {
	return window.label === "monthly" ? Math.floor(window.usedPercent) : Math.round(window.usedPercent);
}

/** Absolute native reset time only; round remaining minutes up and show the largest two units. */
export function quotaWindowLabel(window: FooterQuotaWindow, now: number): string {
	const usage = `${window.label} · ${quotaUsedPercent(window)}% used`;
	if (window.resetsAt === null) return usage;
	const remaining = window.resetsAt - now;
	if (remaining <= 0) return `${usage} · resets now / refreshing`;
	const minutes = Math.ceil(remaining / 60_000);
	let duration: string;
	if (minutes >= 1440) {
		const days = Math.floor(minutes / 1440);
		const hours = Math.floor(minutes % 1440 / 60);
		duration = `${days}d${hours > 0 ? ` ${hours}h` : ""}`;
	} else if (minutes >= 60) {
		const hours = Math.floor(minutes / 60);
		const rest = minutes % 60;
		duration = `${hours}h${rest > 0 ? ` ${rest}m` : ""}`;
	} else duration = `${minutes}m`;
	return `${usage} · resets in ${duration}`;
}

/**
 * Small pure formatting helpers shared across the guest UI.
 *
 * Vendored from oh-my-pi `packages/collab-web/src/lib/format.ts`
 * (rev a1b3b83a7fb8460445f2f5995a6aa56047bd44c7, MIT — see THIRD_PARTY_NOTICES.txt).
 * Local edit: `shortenPath` was dropped (no path chrome in the VS Code panel,
 * which shows the host cwd verbatim).
 */

/** HTML-escape text destined for `dangerouslySetInnerHTML`. */
export function escapeHtml(s: string): string {
	return s
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

/** "950", "12.3k", "1.2M" — tolerant of non-finite input. */
export function fmtTokens(n: number): string {
	if (!Number.isFinite(n) || n <= 0) return "0";
	if (n < 1000) return String(Math.round(n));
	if (n < 1_000_000) {
		const k = n / 1000;
		return `${k >= 100 ? Math.round(k) : Number(k.toFixed(1))}k`;
	}
	const m = n / 1_000_000;
	return `${m >= 100 ? Math.round(m) : Number(m.toFixed(1))}M`;
}

/** "$0.004", "$0.42", "$4.20" — tolerant of non-finite input. */
export function fmtCost(usd: number): string {
	if (!Number.isFinite(usd) || usd <= 0) return "$0.00";
	return `$${usd >= 1 ? usd.toFixed(2) : usd.toFixed(3)}`;
}

/** "847ms", "12.3s", "4m 05s", "1h 12m"; round before splitting units so lower units never show 60. */
export function fmtDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "0ms";
	if (ms < 999.5) return `${Math.round(ms)}ms`;
	const tenths = Math.round(ms / 100);
	if (tenths < 600) return `${tenths / 10}s`;
	const total = Math.round(ms / 1000);
	const min = Math.floor(total / 60);
	if (min < 60) return `${min}m ${String(total % 60).padStart(2, "0")}s`;
	const h = Math.floor(min / 60);
	return `${h}h ${String(min % 60).padStart(2, "0")}m`;
}

/** "now", "42s ago", "5m ago", "3h ago", "2d ago". Input: epoch ms. */
export function relTime(tsMs: number): string {
	if (!Number.isFinite(tsMs)) return "";
	const delta = Date.now() - tsMs;
	if (delta < 10_000) return "now";
	const s = Math.floor(delta / 1000);
	if (s < 60) return `${s}s ago`;
	const min = Math.floor(s / 60);
	if (min < 60) return `${min}m ago`;
	const h = Math.floor(min / 60);
	if (h < 24) return `${h}h ago`;
	return `${Math.floor(h / 24)}d ago`;
}

/** "73%" from a 0–100 percent; em dash for null/non-finite. */
export function fmtPercent(p: number | null | undefined): string {
	if (p === null || p === undefined || !Number.isFinite(p)) return "—";
	return `${Math.round(Math.min(100, Math.max(0, p)))}%`;
}

/** Tolerant text extraction from string | content-block array | message-like objects. */
export function messageText(m: unknown): string {
	if (typeof m === "string") return m;
	if (m === null || m === undefined) return "";
	if (Array.isArray(m)) {
		const parts: string[] = [];
		for (const block of m) {
			if (typeof block === "string") {
				parts.push(block);
				continue;
			}
			if (block && typeof block === "object") {
				const rec = block as Record<string, unknown>;
				if (typeof rec.text === "string") parts.push(rec.text);
				else if (typeof rec.thinking === "string") parts.push(rec.thinking);
			}
		}
		return parts.join("\n");
	}
	if (typeof m === "object") {
		const rec = m as Record<string, unknown>;
		if (typeof rec.text === "string") return rec.text;
		if ("content" in rec) return messageText(rec.content);
	}
	return "";
}

/**
 * Compact one-line digest of tool-call arguments for a card header.
 * Project addition (the vendored per-tool renderers are not bundled): shows the
 * most identifying scalar field instead of dumping JSON into the row.
 */
export function argsDigest(args: unknown): string {
	if (args === null || args === undefined) return "";
	if (typeof args !== "object") return messageText(args);
	const rec = args as Record<string, unknown>;
	for (const key of ["path", "file_path", "command", "pattern", "query", "url", "task", "name", "id", "prompt"]) {
		const value = rec[key];
		if (typeof value === "string" && value.length > 0) return value;
	}
	const keys = Object.keys(rec);
	if (keys.length === 0) return "";
	const first = rec[keys[0] as string];
	return typeof first === "string" ? first : `${keys[0]}: …`;
}

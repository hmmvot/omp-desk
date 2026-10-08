/** Provider, branch and quota facts the host sends to the page. Account labels arrive masked (`account N`, or a truncated label ending in `*`). */
export interface FooterQuotaWindow { label: string; usedPercent: number; resetsAt: number | null }
export interface FooterAccountUsage { label: string; windows: FooterQuotaWindow[] }
export interface FooterUsage { windows: FooterQuotaWindow[]; accounts: FooterAccountUsage[]; accountSelection: string | null }
export interface FooterMetadataMessage extends FooterUsage {
	type: "omp:footer-metadata";
	provider: string | null;
	branch: string | null;
	/** Cost reported by OMP's `get_session_stats`; present only when it is a positive number. */
	sessionCost?: number;
}
export function parseFooterMetadata(value: Record<string, unknown>): FooterMetadataMessage | null {
	const text = (item: unknown): item is string => typeof item === "string" && item.length > 0 && item.length <= 200 && !/[\u0000-\u001f\u007f]/.test(item);
	if (value.provider !== null && !text(value.provider)) return null;
	if (value.branch !== null && !text(value.branch)) return null;
	if (value.accountSelection !== null && !text(value.accountSelection)) return null;
	const parseWindows = (items: unknown): FooterQuotaWindow[] | null => {
		if (!Array.isArray(items) || items.length > 32) return null;
		const windows: FooterQuotaWindow[] = [];
		for (const item of items) {
			if (typeof item !== "object" || item === null || !text(item.label) || typeof item.usedPercent !== "number" || !Number.isFinite(item.usedPercent) || item.usedPercent < 0 || (item.resetsAt !== null && (typeof item.resetsAt !== "number" || !Number.isFinite(item.resetsAt) || item.resetsAt < 0))) return null;
			windows.push({ label: item.label, usedPercent: item.usedPercent, resetsAt: item.resetsAt });
		}
		return windows;
	};
	const windows = parseWindows(value.windows);
	if (!windows || !Array.isArray(value.accounts) || value.accounts.length > 200) return null;
	const accounts: FooterAccountUsage[] = [];
	for (const item of value.accounts) {
		if (typeof item !== "object" || item === null || !text(item.label) || (!/^account \d+$/.test(item.label) && (!item.label.endsWith("*") || item.label.includes("@")))) return null;
		const windows = parseWindows(item.windows);
		if (!windows) return null;
		accounts.push({ label: item.label, windows });
	}
	const sessionCost = typeof value.sessionCost === "number" && Number.isFinite(value.sessionCost) && value.sessionCost > 0 ? value.sessionCost : null;
	return { type: "omp:footer-metadata", provider: value.provider as string | null, branch: value.branch as string | null,
		windows, accounts, accountSelection: value.accountSelection as string | null,
		...(sessionCost === null ? {} : { sessionCost }) };
}

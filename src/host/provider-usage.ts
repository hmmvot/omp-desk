/** Installed OMP usage report -> current-provider quota facts, never token-derived limits. */
import type { FooterAccountUsage, FooterQuotaWindow, FooterUsage } from "../webview/footer-metadata.ts";
import type { OmpCliResult } from "./native-terminal.ts";
export const PROVIDER_USAGE_ARGS = ["usage", "--json", "--redact"] as const;
export const PROVIDER_USAGE_TIMEOUT_MS = 20_000;
export const PROVIDER_USAGE_REFRESH_MS = 5 * 60_000;
const record = (value: unknown): Record<string, unknown> | null => typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value);
interface Candidate extends FooterQuotaWindow { id: string; modelId: string | null; tier: string | null }
export interface ProviderUsageReading { accounts: Array<{ label: string; candidates: Candidate[] }> }
const EMPTY_USAGE: FooterUsage = { windows: [], accounts: [], accountSelection: null };

/** Narrow the redacted CLI payload; windowless/unmeasured limits do not erase useful windows. */
export function parseProviderUsageJson(json: string, provider: string): ProviderUsageReading | null {
	let payload: Record<string, unknown> | null;
	try { payload = record(JSON.parse(json)); } catch { return null; }
	if (!payload || !Array.isArray(payload.reports) || payload.reports.length > 200) return null;
	const accounts: ProviderUsageReading["accounts"] = [];
	for (const item of payload.reports) {
		const report = record(item);
		if (report?.provider !== provider) continue;
		if (!Array.isArray(report.limits) || report.limits.length > 32) return null;
		const metadata = record(report.metadata);
		const candidates: Candidate[] = [];
		for (const item of report.limits) {
			const limit = record(item), window = record(limit?.window), amount = record(limit?.amount), scope = record(limit?.scope);
			if (!limit || !window || !amount) continue;
			const fraction = amount.usedFraction;
			// Match TUI's actual usedFraction; do not invert remainingFraction or infer quotas.
			if (typeof fraction !== "number" || !Number.isFinite(fraction) || fraction < 0) continue;
			const rawLabel = text(window.id) ? window.id : text(window.label) ? window.label : limit.label;
			if (!text(rawLabel)) continue;
			const label = ["daily", "24h", "1d"].includes(rawLabel) ? "1d" : rawLabel;
			const resetsAt = window.resetsAt ?? null;
			if (resetsAt !== null && (typeof resetsAt !== "number" || !Number.isFinite(resetsAt) || resetsAt < 0)) continue;
			const tier = text(scope?.tier) ? scope.tier : text(metadata?.planType) ? metadata.planType : null;
			candidates.push({ label, usedPercent: fraction * 100, resetsAt: resetsAt as number | null,
				id: text(limit.id) ? limit.id : "", modelId: text(scope?.modelId) ? scope.modelId.toLowerCase() : null,
				tier: tier?.toLowerCase() ?? null });
		}
		// Only masked identities may reach the tooltip, regardless of CLI --redact behavior.
		const identity = [metadata?.email, metadata?.accountId, metadata?.projectId].find(value => text(value) && value.endsWith("*") && !value.includes("@"));
		accounts.push({ label: typeof identity === "string" ? identity : `account ${accounts.length + 1}`, candidates });
	}
	return { accounts };
}

/**
 * The TUI picks an active account, then the most specific model/tier group
 * (`#normalizeUsageReports` in its usage component). rpc-ui exposes no active
 * credential identity, so the first matching report in CLI order is the fallback.
 */
export function projectProviderUsage(reading: ProviderUsageReading, modelId: string): FooterUsage {
	const groups = new Map<string, { priority: number; candidates: Candidate[] }>();
	const selected = reading.accounts[0];
	for (const candidate of selected?.candidates ?? []) {
		if (candidate.modelId !== null && candidate.modelId !== modelId.toLowerCase()) continue;
		const key = `${candidate.modelId ?? ""}\0${candidate.tier ?? ""}`;
		const priority = candidate.modelId ? (candidate.tier ? 1 : 0) : candidate.tier ? 3 : 2;
		const group = groups.get(key);
		if (group) group.candidates.push(candidate); else groups.set(key, { priority, candidates: [candidate] });
	}
	let group: { priority: number; candidates: Candidate[] } | undefined;
	for (const candidate of groups.values()) if (!group || candidate.priority < group.priority) group = candidate;
	const windows = new Map<string, Candidate>();
	const monthlyPriority = (id: string): number => id === "cursor:usd:individual-auto" ? 0 : ["cursor:usd:individual-plan", "cursor:usd:individual-overall"].includes(id) ? 1 : id.startsWith("cursor:usd:individual-") ? 2 : 3;
	for (const candidate of group?.candidates ?? []) {
		const previous = windows.get(candidate.label);
		if (!previous || (candidate.label === "monthly" && monthlyPriority(candidate.id) < monthlyPriority(previous.id))) windows.set(candidate.label, candidate);
	}
	const project = (candidate: Candidate): FooterQuotaWindow => ({ label: candidate.label, usedPercent: candidate.usedPercent, resetsAt: candidate.resetsAt });
	const accounts: FooterAccountUsage[] = reading.accounts.map(account => ({ label: account.label,
		windows: account.candidates.map(candidate => ({ ...project(candidate),
			label: `${candidate.label}${candidate.modelId ? ` / ${candidate.modelId}` : candidate.tier ? ` (${candidate.tier})` : ""}`.slice(0, 200) })) }));
	const order: Record<string, number> = { "5h": 0, "1d": 1, "7d": 2, monthly: 3 };
	return { windows: [...windows.values()].sort((a, b) => (order[a.label] ?? 4) - (order[b.label] ?? 4)).map(project), accounts,
		accountSelection: reading.accounts.length > 1 ? "Active account unavailable: showing the first provider report in OMP CLI order." : null };
}

interface Reading { attemptedAt: number; reading: ProviderUsageReading | null; pending: Promise<void> | null }
export class ProviderUsageCache {
	readonly #readings = new Map<string, Reading>();
	readonly now: () => number;
	readonly log: (message: string) => void;
	constructor(now: () => number = Date.now, log: (message: string) => void = () => {}) {
		this.now = now;
		this.log = log;
	}
	get(provider: string, modelId: string): FooterUsage {
		const reading = this.#readings.get(provider)?.reading;
		return reading ? projectProviderUsage(reading, modelId) : EMPTY_USAGE;
	}
	async refresh(provider: string, modelId: string, run: () => Promise<OmpCliResult>): Promise<FooterUsage> {
		const previous = this.#readings.get(provider);
		if (previous?.pending) { await previous.pending; return this.get(provider, modelId); }
		if (previous && this.now() - previous.attemptedAt < PROVIDER_USAGE_REFRESH_MS) return this.get(provider, modelId);
		const reading: Reading = { attemptedAt: this.now(), reading: previous?.reading ?? null, pending: null };
		this.#readings.set(provider, reading);
		reading.pending = (async () => {
			try {
				const result = await run();
				const parsed = result.exitCode === 0 ? parseProviderUsageJson(result.stdout, provider) : null;
				if (parsed === null) this.log("Provider usage refresh returned no valid reading; retaining the last value.");
				else reading.reading = parsed;
			} catch { this.log("Provider usage refresh failed; retaining the last value."); }
			finally { reading.pending = null; }
		})();
		await reading.pending;
		return this.get(provider, modelId);
	}
}

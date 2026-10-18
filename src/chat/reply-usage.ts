/**
 * Turn totals under a finished reply, as the OMP terminal UI shows them by default: `12.4s · 19K tok · $0.02 this turn`.
 * The sums and the wording follow `TurnUsageTally` and `formatTurnUsage` of the installed OMP's `pi-tui` (overlays/usage-row.ts),
 * which are verified against OMP 18.11.1: prompt tokens are input, cache writes and orchestration input (cache reads re-read the
 * context on every request and stay out), output tokens include orchestration output, and the cost is the billed total.
 */
import type { AssistantMessage } from "./messages.ts";

/** What one turn's assistant requests added up to. */
export interface TurnUsage {
	/** Prompt tokens: input, cache writes and orchestration input. */
	readonly input: number;
	/** Output tokens, orchestration output included. */
	readonly output: number;
	/** The cache-write share of {@link input}. */
	readonly cacheWrite: number;
	/** Context re-read from the cache over all requests; not part of any total. */
	readonly cacheRead: number;
	/** Billed cost in dollars. */
	readonly cost: number;
	/** Assistant requests that carried usage (tool-use requests included). */
	readonly requests: number;
}

const count = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;

/** The usage of one request in the TUI's terms, or `null` for a message that reports none. */
export function requestUsage(message: AssistantMessage): Omit<TurnUsage, "requests"> | null {
	// The wire type lists no `orchestration`, which pi-ai's usage carries on some providers; every field read below is validated by `count`.
	const usage = message.usage as (AssistantMessage["usage"] & { orchestration?: { input?: unknown; output?: unknown } }) | undefined;
	if (usage === undefined || usage === null || typeof usage !== "object") return null;
	const orchestration = usage.orchestration;
	const cacheWrite = count(usage.cacheWrite);
	return {
		input: count(usage.input) + cacheWrite + count(orchestration?.input),
		output: count(usage.output) + count(orchestration?.output),
		cacheWrite,
		cacheRead: count(usage.cacheRead),
		cost: count(usage.cost?.total),
	};
}

/** A running sum of a turn's requests. */
export class TurnUsageTally {
	#input = 0;
	#output = 0;
	#cacheWrite = 0;
	#cacheRead = 0;
	#cost = 0;
	#requests = 0;

	add(message: AssistantMessage): void {
		const usage = requestUsage(message);
		if (usage === null) return;
		this.#input += usage.input;
		this.#output += usage.output;
		this.#cacheWrite += usage.cacheWrite;
		this.#cacheRead += usage.cacheRead;
		this.#cost += usage.cost;
		this.#requests += 1;
	}

	/** The total, or `null` when nothing was spent: no tokens and no cost (the TUI draws no line then). */
	total(): TurnUsage | null {
		if (this.#input + this.#output <= 0 && this.#cost <= 0) return null;
		return { input: this.#input, output: this.#output, cacheWrite: this.#cacheWrite, cacheRead: this.#cacheRead, cost: this.#cost, requests: this.#requests };
	}
}

/** `formatNumber` of OMP's `pi-utils`: `999`, `1.5K`, `25K`, `1M`, `1.5B`. */
export function formatTokenCount(value: number): string {
	const tenth = (n: number): string => { const text = n.toFixed(1); return text.endsWith(".0") ? text.slice(0, -2) : text; };
	if (value < 1_000) return String(value);
	if (value < 10_000) return `${tenth(value / 1_000)}K`;
	if (value < 1_000_000) return `${Math.round(value / 1_000)}K`;
	if (value < 10_000_000) return `${tenth(value / 1_000_000)}M`;
	if (value < 1_000_000_000) return `${Math.round(value / 1_000_000)}M`;
	if (value < 10_000_000_000) return `${tenth(value / 1_000_000_000)}B`;
	return `${Math.round(value / 1_000_000_000)}B`;
}

/** The cost as the TUI words it: nothing for zero, `<$0.01` below half a cent. */
export function formatTurnCost(cost: number): string | undefined {
	return cost > 0 ? cost < 0.005 ? "<$0.01" : `$${cost.toFixed(2)}` : undefined;
}

const exact = (value: number): string => value.toLocaleString("en-US");

/**
 * The line (`19K tok · $0.02 this turn`) and its tooltip with exact counts. The time of the turn is a separate item of the
 * footer, so it is not repeated here; `elapsed` is the tooltip's own mention of it, when the footer knows it.
 */
export function formatTurnUsage(usage: TurnUsage, elapsed?: string): { text: string; title: string } {
	const tokens = usage.input + usage.output;
	const cost = formatTurnCost(usage.cost);
	const text = [`${formatTokenCount(tokens)} tok`, cost].filter((part): part is string => part !== undefined).join(" · ");
	const counts = [
		`${exact(tokens)} tokens (${exact(usage.input)} in${usage.cacheWrite > 0 ? `, ${exact(usage.cacheWrite)} of them cache write` : ""} · ${exact(usage.output)} out)`,
		usage.cacheRead > 0 ? `${exact(usage.cacheRead)} cache read` : undefined,
		usage.requests > 1 ? `${usage.requests} requests` : undefined,
		cost === undefined ? undefined : usage.cost < 0.005 ? `$${usage.cost.toFixed(4)}` : cost,
	];
	return { text: `${text} this turn`, title: `This turn: ${[elapsed, ...counts].filter((part): part is string => part !== undefined).join(" · ")}` };
}

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { isRecord } from "../guards.ts";

/**
 * The usage an OMP journal entry bills, as pi-coding-agent's `entryUsage` (session-manager.ts) counts it: an
 * assistant message, a completed `task` result carrying its subagents' spend, or a `model_usage` side call.
 */
function entryUsage(entry: unknown): unknown {
	if (!isRecord(entry)) return undefined;
	if (entry.type === "model_usage") return entry.usage;
	if (entry.type !== "message" || !isRecord(entry.message)) return undefined;
	const message = entry.message;
	if (message.role === "assistant") return message.usage;
	if (message.role === "toolResult" && message.toolName === "task" && isRecord(message.details)) return message.details.usage;
	return undefined;
}

/** One compaction entry of the journal, as OMP wrote it. */
export interface JournalCompaction {
	readonly timestamp: string;
	readonly method: string | null;
	readonly tokensBefore: number | null;
	readonly tokensAfter: number | null;
	readonly warning: string | null;
}

/** What one pass over the journal yields: the spend and the boundaries OMP recorded. */
export interface JournalFacts {
	readonly cost: number;
	/** `compaction` entries of every branch of the file. */
	readonly compactionCount: number;
	readonly lastCompaction: JournalCompaction | null;
	/** `reset_boundary` entries (one per `/clear`) of every branch of the file. */
	readonly clearCount: number;
	readonly lastClear: string | null;
}

const COMPACTION_HEAD = "{\"type\":\"compaction\"";
const RESET_HEAD = "{\"type\":\"reset_boundary\"";

function finiteOrNull(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** A journal timestamp is kept only when it parses as a date: the view prints it. */
function timestampOf(entry: Record<string, unknown>): string | null {
	return typeof entry.timestamp === "string" && Number.isFinite(Date.parse(entry.timestamp)) ? entry.timestamp : null;
}

/**
 * Total spend recorded in a session file across every entry, compacted and abandoned branches included: the figure
 * OMP's own status line shows (`SessionManager.getUsageStatistics().cost`). RPC `get_session_stats` sums only the
 * active window after the latest compaction, so it cannot answer this. The same pass counts the compaction and
 * `/clear` boundary entries (a line begins with its entry type, so message text can never match).
 *
 * Streams the file and parses only lines that can carry a cost or are a boundary; OMP may rewrite the file atomically,
 * so nothing is cached between reads. A torn final line is skipped. `null` when the file cannot be read.
 */
export async function readJournalFacts(file: string): Promise<JournalFacts | null> {
	const stream = createReadStream(file, { encoding: "utf8" });
	const lines = createInterface({ input: stream, crlfDelay: Infinity });
	let cost = 0;
	let compactionCount = 0;
	let lastCompaction: JournalCompaction | null = null;
	let clearCount = 0;
	let lastClear: string | null = null;
	try {
		for await (const line of lines) {
			const compaction = line.startsWith(COMPACTION_HEAD);
			const reset = !compaction && line.startsWith(RESET_HEAD);
			if (!compaction && !reset && !line.includes("\"cost\"")) continue;
			let entry: unknown;
			try { entry = JSON.parse(line); } catch { continue; }
			if (!isRecord(entry)) continue;
			if (compaction || reset) {
				const at = timestampOf(entry);
				if (compaction) {
					compactionCount += 1;
					if (at !== null && (lastCompaction === null || Date.parse(at) >= Date.parse(lastCompaction.timestamp))) {
						lastCompaction = { timestamp: at, method: typeof entry.method === "string" ? entry.method : null,
							tokensBefore: finiteOrNull(entry.tokensBefore), tokensAfter: finiteOrNull(entry.tokensAfter),
							warning: typeof entry.warning === "string" ? entry.warning : null };
					}
				} else {
					clearCount += 1;
					if (at !== null && (lastClear === null || Date.parse(at) >= Date.parse(lastClear))) lastClear = at;
				}
				continue;
			}
			const usage = entryUsage(entry);
			if (!isRecord(usage) || !isRecord(usage.cost)) continue;
			const total = usage.cost.total;
			if (typeof total === "number" && Number.isFinite(total)) cost += total;
		}
	} catch {
		return null;
	} finally {
		lines.close();
		stream.destroy();
	}
	return { cost, compactionCount, lastCompaction, clearCount, lastClear };
}

/** The whole-journal spend alone; `null` when the file cannot be read. */
export async function readJournalCost(file: string): Promise<number | null> {
	return (await readJournalFacts(file))?.cost ?? null;
}

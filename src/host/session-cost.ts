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

/**
 * Total spend recorded in a session file across every entry, compacted and abandoned branches included: the figure
 * OMP's own status line shows (`SessionManager.getUsageStatistics().cost`). RPC `get_session_stats` sums only the
 * active window after the latest compaction, so it cannot answer this.
 *
 * Streams the file and parses only lines that can carry a cost; OMP may rewrite the file atomically, so nothing is
 * cached between reads. A torn final line is skipped. `null` when the file cannot be read.
 */
export async function readJournalCost(file: string): Promise<number | null> {
	const stream = createReadStream(file, { encoding: "utf8" });
	const lines = createInterface({ input: stream, crlfDelay: Infinity });
	let total = 0;
	try {
		for await (const line of lines) {
			if (!line.includes("\"cost\"")) continue;
			let entry: unknown;
			try { entry = JSON.parse(line); } catch { continue; }
			const usage = entryUsage(entry);
			if (!isRecord(usage) || !isRecord(usage.cost)) continue;
			const cost = usage.cost.total;
			if (typeof cost === "number" && Number.isFinite(cost)) total += cost;
		}
	} catch {
		return null;
	} finally {
		lines.close();
		stream.destroy();
	}
	return total;
}

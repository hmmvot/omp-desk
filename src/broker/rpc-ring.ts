/**
 * The bounded line ring of a `managed-rpc` broker
 * ([ADR-0038](../../docs/decisions/0038-host-chat-over-rpc-ui-on-a-broker-pipe-child.md)).
 *
 * The broker drains an `omp --mode rpc-ui` child's stdout continuously into complete lines
 * with a monotonic `seq`. The ring exists only so a (re)attaching client can rebuild the
 * *in-flight* turn and its pending dialogs; the session file is the durable transcript, so
 * nothing here is a store and nothing is parsed beyond what retention needs.
 *
 * Classification is deliberately shallow and lenient: one anchored regex over the first 256
 * characters yields the frame `type` (and a response's `id`), and a line that does not match
 * is *retained* — a misclassification wastes space but never drops an event.
 *
 * - `response` and `rpc_chunk` lines are transient: a client attached *now* gets them, one
 *   that attaches later resynchronizes from disk. The exception is a small `response` whose
 *   id starts with `vsc:` (a refused `prompt` must be learnable after a host restart).
 *   Transient lines are held only until every attached consumer has passed them, under their
 *   own budget: an answer the client asked for (a long session's `get_entries` is tens of MiB
 *   of chunks) is not counted against the retained bound, so within its own budget it never
 *   pushes the retained history out. Eviction still walks one oldest-first queue, though: when
 *   the *retained* bound overflows (2048 lines or 4 MiB of new output while an answer is still
 *   unsent), an older unsent transient line is evicted too and its consumer must reattach.
 * - `message_update` is superseded per open `messageId`: each carries the whole accumulated
 *   message, so only the latest matters, and it is dropped once `message_end` is seen.
 * - Unanswered dialog requests are **pinned** in their own budget and are never evicted;
 *   open `message_start` / `tool_execution_start` lines (each at most 64 KiB) are pinned in a
 *   separate skeleton budget. An unanswered `host_tool_call` (a tool OMP asked the host to run)
 *   is pinned like a dialog until the host's `host_tool_result` is written to the child or OMP
 *   cancels it with `host_tool_cancel`; its budget is soft as well.
 *
 * Every consumer reads through one cursor over the ring for replay *and* live delivery, and
 * {@link RpcSubscriber} sends from it only while its sink's queue is under a pacing bound, so
 * correctness rests on pacing, not on the ring's arithmetic. A cursor that falls behind the
 * eviction point has lost lines: its consumer is disconnected and reattaches with its last
 * `seq`.
 */

import { ptyRpcFragment, ptyRpcFragmentCount } from "../host/pty-protocol.ts";

/** Ring bound: raw bytes of live (non-superseded) replayable lines. */
export const RPC_RING_MAX_BYTES = 4 * 1024 * 1024;
/** Ring bound: live replayable lines. */
export const RPC_RING_MAX_LINES = 2048;
/**
 * Bound on transient lines an attached consumer has not passed yet: twice the client's 64 MiB
 * chunked-response cap, so one whole answer always fits while the replay ahead of it is sent.
 */
export const RPC_TRANSIENT_MAX_BYTES = 128 * 1024 * 1024;
/** Reserved budget for unanswered dialog requests. Exceeding it is reported, never evicted. */
export const RPC_PINNED_DIALOG_MAX_LINES = 256;
export const RPC_PINNED_DIALOG_MAX_BYTES = 1024 * 1024;
/** Reserved budget for open message/tool start lines. Exceeding it means "not pinned". */
export const RPC_PINNED_SKELETON_MAX_LINES = 256;
export const RPC_PINNED_SKELETON_MAX_BYTES = 1024 * 1024;
/** Soft budget for unanswered `host_tool_call` lines. Exceeding it is reported (`hostCallOverflow`), never evicted. */
export const RPC_PINNED_HOST_CALL_MAX_LINES = 32;
export const RPC_PINNED_HOST_CALL_MAX_BYTES = 1024 * 1024;
/** A start line above this gets ordinary ring retention only (tool arguments are unbounded). */
export const RPC_PINNED_SKELETON_LINE_MAX_BYTES = 64 * 1024;
/** A retained `vsc:` response line above this is treated as an ordinary transient response. */
export const RPC_RETAINED_RESPONSE_MAX_BYTES = 4 * 1024;
/** Stop sending to a sink whose unflushed bytes reach this; resume on its drain. */
export const RPC_PACE_BYTES = 2 * 1024 * 1024;
/**
 * A consumer that has been at the pace bound this long without its socket draining is closed, so its owner reattaches at
 * once instead of waiting minutes for the ring to evict the lines it is stuck behind
 * ([ADR-0038](../../docs/decisions/0038-host-chat-over-rpc-ui-on-a-broker-pipe-child.md) amendment, 2026-10-24).
 */
export const RPC_PACED_CLOSE_MS = 10_000;
/** Why a broker closed a consumer on its own initiative; the other closes are the peer's or the caller's. */
export type RpcForcedClose = "fell-behind" | "paced";
export const RPC_FELL_BEHIND_REASON = "the consumer fell behind the retained lines and must reattach";
export const RPC_PACED_REASON = "the consumer stayed paced beyond the limit and must reattach";

export interface RpcRingLimits {
	readonly maxBytes: number;
	readonly maxLines: number;
	readonly transientMaxBytes: number;
	readonly dialogMaxLines: number;
	readonly dialogMaxBytes: number;
	readonly skeletonMaxLines: number;
	readonly skeletonMaxBytes: number;
	readonly skeletonLineMaxBytes: number;
	readonly hostCallMaxLines: number;
	readonly hostCallMaxBytes: number;
}

export const DEFAULT_RPC_RING_LIMITS: RpcRingLimits = {
	maxBytes: RPC_RING_MAX_BYTES,
	maxLines: RPC_RING_MAX_LINES,
	transientMaxBytes: RPC_TRANSIENT_MAX_BYTES,
	dialogMaxLines: RPC_PINNED_DIALOG_MAX_LINES,
	dialogMaxBytes: RPC_PINNED_DIALOG_MAX_BYTES,
	skeletonMaxLines: RPC_PINNED_SKELETON_MAX_LINES,
	skeletonMaxBytes: RPC_PINNED_SKELETON_MAX_BYTES,
	skeletonLineMaxBytes: RPC_PINNED_SKELETON_LINE_MAX_BYTES,
	hostCallMaxLines: RPC_PINNED_HOST_CALL_MAX_LINES,
	hostCallMaxBytes: RPC_PINNED_HOST_CALL_MAX_BYTES,
};

/** One stdout line held for delivery. */
export interface RpcRingEntry {
	readonly seq: number;
	/** The line as UTF-8, without its newline. */
	readonly bytes: Buffer;
	/** `true` when a reattaching client is shown this line; `false` for live-only lines. */
	readonly replayable: boolean;
	/** Superseded, answered or delivered-and-transient: never delivered again. */
	dead: boolean;
	/** Still in the ring's array (pinned entries may outlive their place in it). */
	inRing: boolean;
	pinned: "dialog" | "skeleton" | "hostCall" | null;
}

/** What one line's shallow classification found. */
export interface RpcLinePeek {
	readonly type: string | null;
	/** The `id` when the line starts with one (a response). */
	readonly id: string | null;
}

const TYPE_RE = /^\{(?:"id":"((?:[^"\\]|\\.)*)",)?"type":"([a-z_]+)"/;
const MESSAGE_ID_TAIL_RE = /,"messageId":"(msg-[0-9]+)"\}$/;
const TOOL_HEAD_RE = /^\{"type":"tool_execution_(?:start|end)","toolCallId":"((?:[^"\\]|\\.)*)"/;
const HEAD_CHARS = 256;
const TAIL_CHARS = 128;
/** `extension_ui_request` methods that wait for an answer; everything else is fire-and-forget. */
const DIALOG_METHODS: Record<string, true> = { select: true, confirm: true, input: true, editor: true, ask: true };

/** The frame `type` (and leading `id`) of one JSONL line, or nulls for a line that does not match. */
export function peekRpcLine(line: string): RpcLinePeek {
	const match = TYPE_RE.exec(line.length > HEAD_CHARS ? line.slice(0, HEAD_CHARS) : line);
	if (match === null) return { type: null, id: null };
	return { type: match[2] ?? null, id: match[1] ?? null };
}

/** One top-level string field of a JSON object line, or `null` when the line is not such an object or lacks it. */
export function stringFieldOf(line: string, field: string): string | null {
	try {
		const parsed: unknown = JSON.parse(line);
		if (typeof parsed !== "object" || parsed === null) return null;
		const value = (parsed as Record<string, unknown>)[field];
		return typeof value === "string" ? value : null;
	} catch {
		return null;
	}
}

function messageIdOf(line: string): string | null {
	const tail = line.length > TAIL_CHARS ? line.slice(-TAIL_CHARS) : line;
	return MESSAGE_ID_TAIL_RE.exec(tail)?.[1] ?? null;
}

/** The result of asking the ring which lines a (re)attach should replay. */
export interface RpcReplay {
	readonly entries: RpcRingEntry[];
	/** The `sinceSeq` the replay actually starts after (0 when the requested one is not this child's). */
	readonly fromSeq: number;
	readonly truncated: boolean;
}

export class RpcLineRing {
	private readonly limits: RpcRingLimits;
	private items: RpcRingEntry[] = [];
	private head = 0;
	private deadInItems = 0;
	private liveBytes = 0;
	private liveLines = 0;
	/** Transient lines in the ring, accounted apart from the replayable bound. */
	private transientBytes = 0;
	private transientLines = 0;
	private nextSeq = 1;
	/** Highest `seq` a bound evicted that a live cursor might not have seen. */
	private liveLostThrough = 0;
	/** Highest replayable `seq` a bound evicted without a pin keeping it. */
	private replayLostThrough = 0;
	private readonly updates = new Map<string, RpcRingEntry>();
	private readonly dialogs = new Map<string, RpcRingEntry>();
	private dialogBytes = 0;
	private readonly skeleton = new Map<string, RpcRingEntry>();
	private skeletonBytes = 0;
	private readonly hostCalls = new Map<string, RpcRingEntry>();
	private hostCallBytes = 0;
	private transients: RpcRingEntry[] = [];
	private transientHead = 0;
	private consumers = 0;

	constructor(limits: RpcRingLimits = DEFAULT_RPC_RING_LIMITS) {
		this.limits = limits;
	}

	/** Newest assigned `seq` (0 before any line). */
	get latestSeq(): number {
		return this.nextSeq - 1;
	}

	/** An unanswered dialog request exceeded its reserved budget (none was evicted). */
	get pinnedOverflow(): boolean {
		return this.dialogs.size > this.limits.dialogMaxLines || this.dialogBytes > this.limits.dialogMaxBytes;
	}

	/** Unanswered `host_tool_call` lines exceeded their soft budget (none was evicted). */
	get hostCallOverflow(): boolean {
		return this.hostCalls.size > this.limits.hostCallMaxLines || this.hostCallBytes > this.limits.hostCallMaxBytes;
	}

	/**
	 * How many consumers read the ring. With none, a transient line is not stored: nobody
	 * would ever be shown it, since a later attach replays retained lines only.
	 */
	setConsumers(count: number): void {
		this.consumers = count;
		if (count === 0) this.dropTransientsThrough(Number.MAX_SAFE_INTEGER);
	}

	/** Counters for diagnostics and tests. */
	stats(): { readonly lines: number; readonly bytes: number; readonly dialogs: number; readonly skeleton: number; readonly hostCalls: number } {
		return { lines: this.liveLines + this.transientLines, bytes: this.liveBytes + this.transientBytes, dialogs: this.dialogs.size, skeleton: this.skeleton.size, hostCalls: this.hostCalls.size };
	}

	/**
	 * Take one stdout line. Returns the entry a consumer will be shown, or `null` when the
	 * line was assigned a `seq` but is delivered to nobody (a transient line with no consumer).
	 */
	append(line: string): RpcRingEntry | null {
		const seq = this.nextSeq;
		this.nextSeq += 1;
		const { type, id } = peekRpcLine(line);
		const bytes = Buffer.from(line, "utf8");
		switch (type) {
			case "response": {
				const keep = id !== null && id.startsWith("vsc:") && bytes.length <= RPC_RETAINED_RESPONSE_MAX_BYTES;
				return this.insert(seq, bytes, keep);
			}
			case "rpc_chunk":
				return this.insert(seq, bytes, false);
			case "message_update": {
				const messageId = messageIdOf(line);
				const entry = this.insert(seq, bytes, true);
				if (messageId !== null && entry !== null) {
					const previous = this.updates.get(messageId);
					if (previous !== undefined) this.kill(previous);
					this.updates.set(messageId, entry);
				}
				return entry;
			}
			case "message_start": {
				const messageId = messageIdOf(line);
				const entry = this.insert(seq, bytes, true);
				if (messageId !== null && entry !== null) this.pinSkeleton(`m:${messageId}`, entry);
				return entry;
			}
			case "message_end": {
				const messageId = messageIdOf(line);
				if (messageId !== null) {
					const update = this.updates.get(messageId);
					if (update !== undefined) this.kill(update);
					this.updates.delete(messageId);
					this.unpinSkeleton(`m:${messageId}`);
				}
				return this.insert(seq, bytes, true);
			}
			case "tool_execution_start": {
				const key = TOOL_HEAD_RE.exec(line.length > HEAD_CHARS ? line.slice(0, HEAD_CHARS) : line)?.[1];
				const entry = this.insert(seq, bytes, true);
				if (key !== undefined && entry !== null) this.pinSkeleton(`t:${key}`, entry);
				return entry;
			}
			case "tool_execution_end": {
				const key = TOOL_HEAD_RE.exec(line.length > HEAD_CHARS ? line.slice(0, HEAD_CHARS) : line)?.[1];
				if (key !== undefined) this.unpinSkeleton(`t:${key}`);
				return this.insert(seq, bytes, true);
			}
			case "host_tool_call":
				return this.appendHostCallLine(seq, bytes, line);
			case "host_tool_cancel":
				return this.appendHostCancelLine(seq, bytes, line);
			case "extension_ui_request":
				return this.appendDialogLine(seq, bytes, line);
			default:
				return this.insert(seq, bytes, true);
		}
	}

	/**
	 * The broker forwarded an answer to the dialog `id`: it is never replayed again.
	 * Returns whether a pinned request was released.
	 */
	releaseDialog(id: string): boolean {
		const entry = this.dialogs.get(id);
		if (entry === undefined) return false;
		this.dialogs.delete(id);
		this.dialogBytes -= entry.bytes.length;
		entry.pinned = null;
		this.kill(entry);
		return true;
	}

	/**
	 * The broker wrote the host's `host_tool_result` for the call `id` to the child (or OMP cancelled
	 * it): the call is never replayed again. Returns whether a pinned call was released.
	 */
	releaseHostCall(id: string): boolean {
		const entry = this.hostCalls.get(id);
		if (entry === undefined) return false;
		this.hostCalls.delete(id);
		this.hostCallBytes -= entry.bytes.length;
		entry.pinned = null;
		this.kill(entry);
		return true;
	}

	/** Lines a client attaching with `sinceSeq` is shown, in `seq` order. */
	replay(sinceSeq: number): RpcReplay {
		let since = sinceSeq;
		let truncated = false;
		if (since > this.latestSeq) {
			// A cursor from another child (or another broker generation): replay what there is
			// and say the caller's history is not continuous.
			since = 0;
			truncated = true;
		}
		const entries: RpcRingEntry[] = [];
		for (let index = this.head; index < this.items.length; index += 1) {
			const entry = this.items[index];
			if (entry !== undefined && entry.seq > since && entry.replayable && !entry.dead) entries.push(entry);
		}
		let merged = false;
		for (const pinned of [...this.dialogs.values(), ...this.skeleton.values(), ...this.hostCalls.values()]) {
			if (!pinned.inRing && !pinned.dead && pinned.seq > since) {
				entries.push(pinned);
				merged = true;
			}
		}
		if (merged) entries.sort((a, b) => a.seq - b.seq);
		return { entries, fromSeq: since, truncated: truncated || this.replayLostThrough > since };
	}

	/** Oldest `seq` a replay from 0 could deliver; `latestSeq + 1` when nothing is retained. */
	oldestSeq(): number {
		let oldest = this.latestSeq + 1;
		for (let index = this.head; index < this.items.length; index += 1) {
			const entry = this.items[index];
			if (entry !== undefined && entry.replayable && !entry.dead) {
				oldest = entry.seq;
				break;
			}
		}
		for (const pinned of [...this.dialogs.values(), ...this.skeleton.values(), ...this.hostCalls.values()]) {
			if (!pinned.dead && pinned.seq < oldest) oldest = pinned.seq;
		}
		return oldest;
	}

	/** The first live entry after `cursor`, or `null` when the reader has caught up. */
	next(cursor: number): RpcRingEntry | null {
		let low = this.head;
		let high = this.items.length;
		while (low < high) {
			const middle = (low + high) >>> 1;
			const entry = this.items[middle];
			if (entry !== undefined && entry.seq > cursor) high = middle;
			else low = middle + 1;
		}
		for (let index = low; index < this.items.length; index += 1) {
			const entry = this.items[index];
			if (entry !== undefined && !entry.dead) return entry;
		}
		return null;
	}

	/** `true` when a line after `cursor` was evicted before its reader saw it. */
	lostAfter(cursor: number): boolean {
		return this.liveLostThrough > cursor;
	}

	/** Transient lines every consumer has passed can go: nobody will ask for them again. */
	dropTransientsThrough(minCursor: number): void {
		while (this.transientHead < this.transients.length) {
			const entry = this.transients[this.transientHead];
			if (entry === undefined || entry.seq > minCursor) break;
			this.kill(entry);
			this.transientHead += 1;
		}
		if (this.transientHead > 256 && this.transientHead * 2 > this.transients.length) {
			this.transients = this.transients.slice(this.transientHead);
			this.transientHead = 0;
		}
	}

	private appendDialogLine(seq: number, bytes: Buffer, line: string): RpcRingEntry | null {
		let request: { readonly id?: unknown; readonly method?: unknown; readonly targetId?: unknown } | null = null;
		try {
			const parsed: unknown = JSON.parse(line);
			if (typeof parsed === "object" && parsed !== null) request = parsed;
		} catch {
			// Not JSON: an ordinary retained line.
		}
		const entry = this.insert(seq, bytes, true);
		if (request === null || entry === null) return entry;
		if (request.method === "cancel") {
			if (typeof request.targetId === "string") this.releaseDialog(request.targetId);
			return entry;
		}
		if (typeof request.id === "string" && typeof request.method === "string" && DIALOG_METHODS[request.method] === true) {
			// A re-sent id replaces the earlier pin rather than leaking its budget.
			this.releaseDialog(request.id);
			entry.pinned = "dialog";
			this.dialogs.set(request.id, entry);
			this.dialogBytes += bytes.length;
		}
		return entry;
	}

	private appendHostCallLine(seq: number, bytes: Buffer, line: string): RpcRingEntry | null {
		const entry = this.insert(seq, bytes, true);
		const id = entry === null ? null : stringFieldOf(line, "id");
		// A call without a string id cannot be answered or cancelled by id: it is an ordinary retained line.
		if (entry === null || id === null || id.length === 0) return entry;
		// A re-sent id replaces the earlier pin rather than leaking its budget.
		this.releaseHostCall(id);
		entry.pinned = "hostCall";
		this.hostCalls.set(id, entry);
		this.hostCallBytes += bytes.length;
		return entry;
	}

	private appendHostCancelLine(seq: number, bytes: Buffer, line: string): RpcRingEntry | null {
		const entry = this.insert(seq, bytes, true);
		const targetId = stringFieldOf(line, "targetId");
		if (targetId !== null) this.releaseHostCall(targetId);
		return entry;
	}

	private pinSkeleton(key: string, entry: RpcRingEntry): void {
		if (entry.bytes.length > this.limits.skeletonLineMaxBytes) return;
		if (this.skeleton.size >= this.limits.skeletonMaxLines) return;
		if (this.skeletonBytes + entry.bytes.length > this.limits.skeletonMaxBytes) return;
		this.unpinSkeleton(key);
		entry.pinned = "skeleton";
		this.skeleton.set(key, entry);
		this.skeletonBytes += entry.bytes.length;
	}

	private unpinSkeleton(key: string): void {
		const entry = this.skeleton.get(key);
		if (entry === undefined) return;
		this.skeleton.delete(key);
		this.skeletonBytes -= entry.bytes.length;
		entry.pinned = null;
	}

	private insert(seq: number, bytes: Buffer, replayable: boolean): RpcRingEntry | null {
		if (!replayable && this.consumers === 0) return null;
		const entry: RpcRingEntry = { seq, bytes, replayable, dead: false, inRing: true, pinned: null };
		this.items.push(entry);
		this.account(entry, 1);
		if (!replayable) this.transients.push(entry);
		this.evict();
		return entry;
	}

	/** Add (`1`) or remove (`-1`) an in-ring entry from the budget its kind counts against. */
	private account(entry: RpcRingEntry, sign: 1 | -1): void {
		if (entry.replayable) {
			this.liveBytes += sign * entry.bytes.length;
			this.liveLines += sign;
		} else {
			this.transientBytes += sign * entry.bytes.length;
			this.transientLines += sign;
		}
	}

	/** Mark an entry permanently undeliverable and release its ring accounting. */
	private kill(entry: RpcRingEntry): void {
		if (entry.dead) return;
		entry.dead = true;
		if (!entry.inRing) return;
		this.account(entry, -1);
		this.deadInItems += 1;
		this.compact();
	}

	private overBound(): boolean {
		return this.liveLines > this.limits.maxLines || this.liveBytes > this.limits.maxBytes || this.transientBytes > this.limits.transientMaxBytes;
	}

	private evict(): void {
		while (this.overBound() && this.liveLines + this.transientLines > 1) {
			const entry = this.items[this.head];
			if (entry === undefined) break;
			this.head += 1;
			if (entry.dead) {
				this.deadInItems -= 1;
				continue;
			}
			entry.inRing = false;
			this.account(entry, -1);
			this.liveLostThrough = Math.max(this.liveLostThrough, entry.seq);
			if (entry.replayable && entry.pinned === null) {
				this.replayLostThrough = Math.max(this.replayLostThrough, entry.seq);
			}
		}
		if (this.head > 1024 && this.head * 2 > this.items.length) {
			this.items = this.items.slice(this.head);
			this.head = 0;
		}
	}

	/** Drop dead entries once they outnumber the live ones, so a long turn cannot grow the array. */
	private compact(): void {
		if (this.deadInItems <= 1024 || this.deadInItems <= this.liveLines + this.transientLines) return;
		const kept: RpcRingEntry[] = [];
		for (let index = this.head; index < this.items.length; index += 1) {
			const entry = this.items[index];
			if (entry !== undefined && !entry.dead) kept.push(entry);
		}
		this.items = kept;
		this.head = 0;
		this.deadInItems = 0;
	}
}

/** Where a subscriber's fragments go: one attached connection. */
export interface RpcSink {
	readonly closed: boolean;
	/** Bytes accepted and not yet flushed. */
	readonly pendingBytes: number;
	sendFragment(seq: number, index: number, count: number, data: string): void;
	/** End the connection. `forced` names the broker's own reason, which the next attach reports. */
	close(reason: string, forced: RpcForcedClose): void;
}

/** What one subscriber's pump has done: the measurement that settles whether the broker or the consumer is slow. */
export interface RpcPumpStats {
	/** Lines handed to the sink completely. */
	lines: number;
	/** Raw line bytes of those lines. */
	bytes: number;
	/** `pump` calls, and the time they took in total and at most. */
	pumps: number;
	busyMs: number;
	maxPumpMs: number;
	/** Times the pump stopped at the pace bound; times the timer found the queue partly flushed below it; times it found the queue empty with no drain reported since the pace began. */
	pacedEpisodes: number;
	resumedBelowBound: number;
	missedDrains: number;
}

/**
 * One attached consumer: replay first, then live, through one cursor, paced on its sink.
 *
 * `pump` sends until the sink's queue reaches the pacing bound and reports whether the
 * subscriber is idle (caught up with nothing partly sent); the caller pumps again on the
 * sink's drain and whenever the ring gains a line. A sink that stays at the bound for
 * {@link RPC_PACED_CLOSE_MS} is closed by {@link enforcePace}, which a timer calls.
 */
export class RpcSubscriber {
	/** Newest `seq` this subscriber has been handed (or skipped as dead). */
	cursor: number;
	readonly stats: RpcPumpStats = { lines: 0, bytes: 0, pumps: 0, busyMs: 0, maxPumpMs: 0, pacedEpisodes: 0, resumedBelowBound: 0, missedDrains: 0 };
	private readonly ring: RpcLineRing;
	private readonly sink: RpcSink;
	private readonly replay: readonly RpcRingEntry[];
	private readonly paceBytes: number;
	private readonly now: () => number;
	private replayIndex = 0;
	private current: { readonly entry: RpcRingEntry; readonly count: number; index: number } | null = null;
	private pacedAt: number | null = null;
	private drainedAt: number | null = null;

	constructor(
		ring: RpcLineRing,
		sink: RpcSink,
		replay: readonly RpcRingEntry[],
		startCursor: number,
		paceBytes = RPC_PACE_BYTES,
		now: () => number = () => performance.now(),
	) {
		this.ring = ring;
		this.sink = sink;
		this.replay = replay;
		this.cursor = startCursor;
		this.paceBytes = paceBytes;
		this.now = now;
	}

	/** Nothing is partly sent and nothing is waiting. */
	get idle(): boolean {
		return this.current === null && this.replayIndex >= this.replay.length && this.ring.next(this.cursor) === null;
	}

	/** Whether the last pump stopped at the pace bound and the sink has not drained since. */
	get paced(): boolean {
		return this.pacedAt !== null && !this.sink.closed;
	}

	/** How long the sink has been at the pace bound, or `null` when it is not. */
	pacedForMs(): number | null {
		return this.pacedAt === null ? null : this.now() - this.pacedAt;
	}

	/** Send until paced or caught up. Returns `true` when idle. */
	pump(): boolean {
		const started = this.now();
		const idle = this.pumpLines();
		const elapsed = this.now() - started;
		this.stats.pumps += 1;
		this.stats.busyMs += elapsed;
		if (elapsed > this.stats.maxPumpMs) this.stats.maxPumpMs = elapsed;
		return idle;
	}

	/**
	 * Called on a timer while the subscriber is paced. `"closed"`: it has stood at the bound for `limitMs` and the sink was
	 * closed as paced. `"resume"`: its queue is below the bound again and the caller must pump it (and flush what a pump
	 * owes: the exit barrier, released transient lines). `"wait"`: still at the bound, inside the limit (or not paced).
	 * A resume that finds the queue empty although no drain was reported since the pace began is counted as a missed
	 * drain; one that finds it partly flushed is a normal slow drain and counts separately.
	 */
	enforcePace(limitMs: number): "closed" | "resume" | "wait" {
		if (this.pacedAt === null || this.sink.closed) return "wait";
		if (this.sink.pendingBytes < this.paceBytes) {
			if (this.sink.pendingBytes === 0 && (this.drainedAt === null || this.drainedAt < this.pacedAt)) this.stats.missedDrains += 1;
			else this.stats.resumedBelowBound += 1;
			return "resume";
		}
		if (this.now() - this.pacedAt < limitMs) return "wait";
		this.pacedAt = null;
		this.sink.close(RPC_PACED_REASON, "paced");
		return "closed";
	}

	/** The sink reported that its queue emptied: the moment a drain was last seen, against which a missed one is counted. */
	noteDrain(): void {
		this.drainedAt = this.now();
	}

	private pumpLines(): boolean {
		while (!this.sink.closed) {
			if (this.sink.pendingBytes >= this.paceBytes) {
				if (this.pacedAt === null) {
					this.pacedAt = this.now();
					this.stats.pacedEpisodes += 1;
				}
				return false;
			}
			this.pacedAt = null;
			if (this.current === null) {
				const entry = this.takeNext();
				if (entry === null) return !this.sink.closed;
				this.current = { entry, count: ptyRpcFragmentCount(entry.bytes.length), index: 0 };
			}
			const { entry, count, index } = this.current;
			this.sink.sendFragment(entry.seq, index, count, ptyRpcFragment(entry.bytes, index));
			if (index + 1 >= count) {
				this.current = null;
				this.stats.lines += 1;
				this.stats.bytes += entry.bytes.length;
			} else this.current.index = index + 1;
		}
		return false;
	}

	private takeNext(): RpcRingEntry | null {
		while (this.replayIndex < this.replay.length) {
			const entry = this.replay[this.replayIndex];
			this.replayIndex += 1;
			if (entry !== undefined && !entry.dead) return entry;
		}
		if (this.ring.lostAfter(this.cursor)) {
			this.sink.close(RPC_FELL_BEHIND_REASON, "fell-behind");
			return null;
		}
		const entry = this.ring.next(this.cursor);
		if (entry !== null) this.cursor = entry.seq;
		return entry;
	}
}

/**
 * The extension's background broker processes, as the Processes view shows them.
 *
 * A broker is the detached process that owns one OMP session child or one folder
 * terminal and outlives windows by design. This module is the model and the policy of
 * the view that lists them. It holds no `vscode` import and no I/O of its own: every
 * reading arrives through a port, so what it may claim about a process is decidable in a
 * test. Stopping is orchestrated in `broker-process-controller.ts` and performed by the
 * existing authenticated broker paths; **no process id is ever signalled** (ADR-0029,
 * ADR-0037, ADR-0039).
 *
 * ## What a listing may claim
 *
 * A row is a *record* the broker published (`pty-registry.ts`) whose broker process is
 * alive **and is the process the record describes**: the record names the broker's own
 * kernel creation time, the PID is open, and a fresh reading of that PID equals it. A dead
 * PID, a recycled PID and a record with no creation time are not rows. The listing
 * authenticates to nothing. The token never leaves the registry; rows are built from
 * {@link BrokerRecordFacts}, which has none.
 *
 * ## What "in use" means
 *
 * A slot is *referenced* when any durable source names it (see
 * {@link buildBrokerProcessCatalog}); the launch path records a broker-slot mapping
 * *before* it spawns the broker, so a mapping, not only a row's recorded host, counts. A
 * slot no source names is `orphaned` only when every source was read in full; a source that
 * reported an unreadable or dropped entry makes it `unknown`, because a mapping this build
 * could not parse is not the same as no mapping.
 */

import { PTY_PROTOCOL_VERSION, PTY_RUNTIME_VERSION } from "./pty-protocol.ts";
import type { PtyBrokerRecord, PtyKind } from "./pty-protocol.ts";
import type { PtyIdentityReading } from "./pty-identity.ts";

/** A broker record without its authentication token. */
export type BrokerRecordFacts = Omit<PtyBrokerRecord, "token">;

/** Drop the token: a view model never carries a capability. */
export function brokerRecordFacts(record: PtyBrokerRecord): BrokerRecordFacts {
	const { token: _token, ...facts } = record;
	return facts;
}

/** Where a record was read: this extension's storage, or the predecessor id's (read-only). */
export type BrokerProcessSource = "current" | "predecessor";

export interface SourcedBrokerRecord {
	readonly source: BrokerProcessSource;
	readonly record: BrokerRecordFacts;
}

/** What a user sees a process as: a session's host, or a folder terminal's. */
export type BrokerProcessKind = "session" | "terminal" | "stats";

/**
 * - `in-use`: a durable source references the slot;
 * - `orphaned`: no source references it and every source was read in full;
 * - `unknown`: no source references it, but the catalog is still loading or a source
 *   could not be read in full.
 */
export type BrokerProcessStatus = "in-use" | "orphaned" | "unknown";

/**
 * Which window shows or drives the process, as far as this window can tell.
 *
 * `other-window` is a record, not proof: a session claim another window holds, or a
 * terminal slot recorded as open in an editor (which also stays set after a window ended
 * abruptly).
 */
export type BrokerProcessWindow = "this-window" | "other-window" | "none";

/** Whether the broker's own child (the OMP process or the shell) still runs. */
export type BrokerProcessChild = "running" | "exited" | "unknown";

/** What the catalog says a session slot hosts. */
export interface BrokerProcessSessionHost {
	readonly kind: "session";
	/** The conversation row, or `null` when only an editor slot's mapping names the broker. */
	readonly tabId: string | null;
	readonly title: string;
	readonly folder: string | null;
	readonly window: BrokerProcessWindow;
	/** This window runs a host of the row under exactly this slot, so its own stop flow owns it. */
	readonly drivenHere: boolean;
	/** The row's recorded host names this slot (not only a mapping). */
	readonly recorded: boolean;
}

export interface BrokerProcessTerminalHost {
	readonly kind: "terminal";
	readonly folder: string;
	readonly label: string;
	readonly window: BrokerProcessWindow;
}

/** A standalone dashboard's broker record is its durable background-work reference. */
export interface BrokerProcessStatsHost {
	readonly kind: "stats";
	readonly window: BrokerProcessWindow;
}

export type BrokerProcessHost = BrokerProcessSessionHost | BrokerProcessTerminalHost | BrokerProcessStatsHost;

/** The catalog's answer, from state this window already holds. */
export interface BrokerProcessCatalog {
	/** `false` while the profile catalog is still being read. */
	readonly ready: boolean;
	/** `false` when a source dropped an entry or could not be read in full. */
	readonly complete: boolean;
	session(slot: string): BrokerProcessSessionHost | null;
	terminal(slot: string): BrokerProcessTerminalHost | null;
}

/** A stop this build can perform, or the reason it cannot. */
export type BrokerProcessStopAvailability =
	| { readonly available: true }
	| { readonly available: false; readonly reason: string; readonly diagnosticReason?: string };

export interface BrokerProcessRow {
	/** Stable across refreshes while the same broker runs. */
	readonly id: string;
	readonly source: BrokerProcessSource;
	readonly kind: BrokerProcessKind;
	readonly ptyKind: PtyKind;
	readonly slot: string;
	readonly brokerId: string;
	readonly generation: string;
	readonly brokerPid: number;
	readonly brokerCreationTime: string;
	readonly startedAt: string;
	/** Milliseconds since `startedAt`, or `null` when it is not a date. */
	readonly uptimeMs: number | null;
	/** The broker's own title (a hint for an orphan), or `null`. */
	readonly title: string | null;
	readonly status: BrokerProcessStatus;
	readonly host: BrokerProcessHost | null;
	readonly window: BrokerProcessWindow;
	/** A runtime of this window drives the session: its own stop flow owns the row. */
	readonly drivenHere: boolean;
	readonly child: BrokerProcessChild;
	/** The broker runs another build's staged runtime than this extension's package. */
	readonly olderBuild: boolean;
	readonly stop: BrokerProcessStopAvailability;
}

export interface BrokerProcessSnapshot {
	readonly rows: readonly BrokerProcessRow[];
	/** Records whose broker is gone, whose PID is now another process, or that name no creation time. */
	readonly hidden: number;
	/** Record files present but unreadable or from another format. */
	readonly unreadable: number;
	readonly takenAt: number;
}

export interface BrokerProcessReadPorts {
	listRecords(): Promise<{ readonly records: readonly SourcedBrokerRecord[]; readonly unreadable: number }>;
	/**
	 * The catalog as of *now*. Called after {@link listRecords}: the launch path records a
	 * mapping before it spawns, so a record already listed has its reference visible here.
	 * `fresh` asks the implementation to re-read the shared catalog first.
	 */
	catalog(fresh: boolean): Promise<BrokerProcessCatalog>;
	/** Cheap synchronous liveness of a PID. */
	isAlive(pid: number): boolean;
	/** Kernel creation time of a PID (a process spawn per call: cached by the reader). */
	readCreationTime(pid: number): Promise<PtyIdentityReading>;
	/**
	 * Child state through one authenticated, owner-hint-free, read-only attach. Only asked
	 * for a row this build can authenticate to, on an explicit read, and never throws.
	 */
	readChild(row: BrokerRecordFacts): Promise<BrokerProcessChild>;
	/** Digest of this build's packaged broker tree, or `null` when it cannot be computed. */
	buildDigest(): Promise<string | null>;
	now(): number;
}

export interface BrokerProcessReadOptions {
	/**
	 * An explicit read: drop the identity cache, re-read the shared catalog and read every
	 * row's child state. A tick reads none of these and reuses the last answers.
	 */
	readonly fresh?: boolean;
}

export interface BrokerProcessReader {
	read(options?: BrokerProcessReadOptions): Promise<BrokerProcessSnapshot>;
}

/** Every Nth tick re-verifies the cached identities, so a recycled PID cannot show for long. */
const REVERIFY_EVERY_TICKS = 12;
/** Authenticated attaches, and creation-time probes, in flight at once. */
const READ_CONCURRENCY = 4;

function identityKey(record: BrokerRecordFacts): string {
	return `${record.brokerId}|${record.brokerPid}|${record.brokerCreationTime ?? "-"}`;
}

/** Run `work` over `items` with at most {@link READ_CONCURRENCY} in flight, keeping order. */
async function mapBounded<T, R>(items: readonly T[], work: (item: T) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const worker = async (): Promise<void> => {
		for (let index = next++; index < items.length; index = next++) results[index] = await work(items[index]!);
	};
	await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, items.length) }, worker));
	return results;
}

/**
 * Build the reader.
 *
 * A broker generation that read as gone or as another process never comes back (a broker
 * does not restart, and a creation time identifies one process lifetime), so that verdict
 * is kept for good: the registry keeps one record per stopped broker, and each must cost
 * one probe ever, not one per refresh. A *verified* identity is remembered only while the
 * PID stays alive and is dropped on every explicit read and every twelfth tick. The caches
 * decide only what is displayed: a stop re-derives everything fresh.
 */
export function createBrokerProcessReader(ports: BrokerProcessReadPorts): BrokerProcessReader {
	let verified = new Set<string>();
	const dead = new Set<string>();
	const children = new Map<string, BrokerProcessChild>();
	let ticks = 0;
	return {
		async read(options = {}) {
			const fresh = options.fresh === true;
			if (fresh || ++ticks % REVERIFY_EVERY_TICKS === 0) verified = new Set();
			// Records first, catalog second: see BrokerProcessReadPorts.catalog.
			const listing = await ports.listRecords();
			const catalog = await ports.catalog(fresh);
			const digest = await ports.buildDigest();
			const now = ports.now();
			let hidden = 0;
			const candidates = listing.records.filter(entry => {
				const alive =
					entry.record.brokerCreationTime !== null &&
					!dead.has(identityKey(entry.record)) &&
					ports.isAlive(entry.record.brokerPid);
				if (!alive) hidden++;
				return alive;
			});
			const resolved = await mapBounded(candidates, async entry => {
				if (verified.has(identityKey(entry.record))) return { entry, ok: true };
				const reading = await ports.readCreationTime(entry.record.brokerPid);
				const ok = reading.kind === "found" && reading.creationTime === entry.record.brokerCreationTime;
				// Only a definite answer is final; an unreadable process is retried next time.
				if (!ok && (reading.kind === "gone" || reading.kind === "found")) dead.add(identityKey(entry.record));
				return { entry, ok };
			});
			const stillVerified = new Set<string>();
			const live: SourcedBrokerRecord[] = [];
			for (const item of resolved) {
				if (!item.ok) {
					hidden++;
					continue;
				}
				stillVerified.add(identityKey(item.entry.record));
				live.push(item.entry);
			}
			verified = stillVerified;
			if (fresh) {
				children.clear();
				const todo = live.filter(entry => stopAvailability(entry).available);
				await mapBounded(todo, async entry => {
					children.set(identityKey(entry.record), await ports.readChild(entry.record));
				});
			}
			const rows = live.map(entry =>
				deriveBrokerProcessRow(entry, catalog, digest, now, children.get(identityKey(entry.record)) ?? "unknown"),
			);
			rows.sort(compareRows);
			return { rows, hidden, unreadable: listing.unreadable, takenAt: now };
		},
	};
}

/** Whether this build can ask the broker to stop, and why not otherwise. */
export function stopAvailability(entry: SourcedBrokerRecord): BrokerProcessStopAvailability {
	const { record, source } = entry;
	if (source === "predecessor") {
		return {
			available: false,
			reason: "Started by a previous version of OMP Desk. Close its session in that version, or use Task Manager; Copy Diagnostics has the process details.",
			diagnosticReason: `Predecessor extension id omp-vscode.omp-vscode; broker pid ${record.brokerPid}, protocol ${record.protocolVersion}, runtime ${record.runtimeVersion}.`,
		};
	}
	if (record.protocolVersion !== PTY_PROTOCOL_VERSION || record.runtimeVersion !== PTY_RUNTIME_VERSION) {
		return {
			available: false,
			reason: "Started by an incompatible version of OMP Desk. Close its session in that version, or use Task Manager; Copy Diagnostics has the process details.",
			diagnosticReason: `Broker pid ${record.brokerPid}, protocol ${record.protocolVersion}, runtime ${record.runtimeVersion}; this build requires protocol ${PTY_PROTOCOL_VERSION}, runtime ${PTY_RUNTIME_VERSION}.`,
		};
	}
	return { available: true };
}

/** Classify one live broker record. Pure. */
export function deriveBrokerProcessRow(
	entry: SourcedBrokerRecord,
	catalog: BrokerProcessCatalog,
	buildDigest: string | null,
	now: number,
	child: BrokerProcessChild,
): BrokerProcessRow {
	const { record, source } = entry;
	const kind: BrokerProcessKind = record.kind === "stats-dashboard" ? "stats" : record.kind === "folder-shell" ? "terminal" : "session";
	let host: BrokerProcessHost | null = null;
	let status: BrokerProcessStatus = "unknown";
	if (kind === "stats" && source === "current") {
		host = { kind: "stats", window: "none" };
		status = "in-use";
	} else if (catalog.ready && source === "current") {
		host = kind === "terminal" ? catalog.terminal(record.slot) : catalog.session(record.slot);
		status = host !== null ? "in-use" : catalog.complete ? "orphaned" : "unknown";
	}
	const startedMs = Date.parse(record.startedAt);
	return {
		id: `${source}|${record.slot}|${record.brokerId}`,
		source,
		kind,
		ptyKind: record.kind,
		slot: record.slot,
		brokerId: record.brokerId,
		generation: record.generation,
		brokerPid: record.brokerPid,
		brokerCreationTime: record.brokerCreationTime ?? "",
		startedAt: record.startedAt,
		uptimeMs: Number.isNaN(startedMs) ? null : Math.max(0, now - startedMs),
		title: record.title,
		status,
		host,
		window: host?.window ?? "none",
		drivenHere: host?.kind === "session" && host.drivenHere,
		child,
		olderBuild: buildDigest !== null && record.treeDigest !== buildDigest,
		stop: stopAvailability(entry),
	};
}

function compareRows(left: BrokerProcessRow, right: BrokerProcessRow): number {
	const rank = (row: BrokerProcessRow): number =>
		row.source === "predecessor" ? 4 : row.status === "orphaned" ? 0 : row.child === "exited" ? 1 : row.status === "unknown" ? 2 : 3;
	if (rank(left) !== rank(right)) return rank(left) - rank(right);
	const leftStart = Date.parse(left.startedAt);
	const rightStart = Date.parse(right.startedAt);
	if (!Number.isNaN(leftStart) && !Number.isNaN(rightStart) && leftStart !== rightStart) return rightStart - leftStart;
	return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/**
 * The rows `Stop Orphaned and Idle Processes` may act on: orphaned, or with an exited
 * child; stoppable through the broker; not driven by this window and not shown by an
 * editor of this window. Anything else belongs to its own row's Stop.
 */
export function selectOrphanedAndIdle(rows: readonly BrokerProcessRow[]): readonly BrokerProcessRow[] {
	return rows.filter(
		row =>
			row.stop.available &&
			!row.drivenHere &&
			row.window !== "this-window" &&
			(row.status === "orphaned" || row.child === "exited"),
	);
}

// The catalog

/** What the session index says about one conversation row, as far as slots are concerned. */
export interface BrokerCatalogRow {
	readonly tabId: string;
	readonly title: string;
	readonly folder: string | null;
	/** `host.rpc.slot` of the row's recorded host, or `null`. */
	readonly hostSlot: string | null;
	readonly window: BrokerProcessWindow;
	/** Slot of the runtime this window drives for the row, or `null`. */
	readonly drivenSlot: string | null;
}

export interface BrokerCatalogShell {
	readonly slot: string;
	readonly folder: string;
	readonly label: string;
	readonly window: BrokerProcessWindow;
}

export interface BrokerCatalogSources {
	/** The profile catalog has been read. */
	readonly ready: boolean;
	readonly rows: readonly BrokerCatalogRow[];
	/** `brokerSlots` `byConversation`: slot to conversation id. */
	readonly byConversation: ReadonlyMap<string, string>;
	/** `brokerSlots` `byEditor` values. */
	readonly byEditor: ReadonlySet<string>;
	/** `false` when the broker-slot table was unreadable or dropped or conflicted an entry. */
	readonly brokerSlotsComplete: boolean;
	readonly shells: readonly BrokerCatalogShell[];
	/** `false` when the shell-slot value was unreadable or dropped an entry. */
	readonly shellSlotsComplete: boolean;
}

/**
 * The union of what durable sources say a slot hosts.
 *
 * Session slots: a row whose recorded host names the slot; else a conversation mapping
 * whose conversation still has a row (the row's own headline); else an editor mapping
 * alone (a conflicting newcomer may exist only there), shown without a row. A conversation
 * mapping whose row is gone references nothing: that is a stale mapping, and the broker it
 * names is an orphan. Terminal slots: the shell slot list.
 */
export function buildBrokerProcessCatalog(sources: BrokerCatalogSources): BrokerProcessCatalog {
	const byTab = new Map(sources.rows.map(row => [row.tabId, row] as const));
	const byHostSlot = new Map<string, BrokerCatalogRow>();
	for (const row of sources.rows) if (row.hostSlot !== null) byHostSlot.set(row.hostSlot, row);
	const shellBySlot = new Map(sources.shells.map(shell => [shell.slot, shell] as const));
	const sessionHost = (row: BrokerCatalogRow, slot: string): BrokerProcessSessionHost => ({
		kind: "session",
		tabId: row.tabId,
		title: row.title,
		folder: row.folder,
		window: row.window,
		drivenHere: row.drivenSlot === slot,
		recorded: row.hostSlot === slot,
	});
	return {
		ready: sources.ready,
		complete: sources.ready && sources.brokerSlotsComplete && sources.shellSlotsComplete,
		session(slot) {
			const byHost = byHostSlot.get(slot);
			if (byHost !== undefined) return sessionHost(byHost, slot);
			const tabId = sources.byConversation.get(slot);
			const mapped = tabId === undefined ? undefined : byTab.get(tabId);
			if (mapped !== undefined) return sessionHost(mapped, slot);
			if (sources.byEditor.has(slot)) {
				return { kind: "session", tabId: null, title: "An editor of a session", folder: null, window: "none", drivenHere: false, recorded: false };
			}
			return null;
		},
		terminal(slot) {
			const shell = shellBySlot.get(slot);
			return shell === undefined ? null : { kind: "terminal", folder: shell.folder, label: shell.label, window: shell.window };
		},
	};
}


/**
 * The broker slot one managed native host owns, durable across a conversation
 * switch and an extension-host restart.
 *
 * A broker record is filed under its slot, and that record is the only way to find
 * the process again after this window restarts. The slot therefore cannot be
 * derived from the conversation id: a verified native `/resume B` keeps the *same
 * process* while the conversation changes, and a slot named after A would leave the
 * surviving writer unfindable — or, worse, look like a free slot that a second
 * launch could take.
 *
 * So the slot is minted once, when the host is launched, and then recorded under
 * both identities the window can look it up by:
 *
 * - the **editor slot** (the immutable editor identity of the WebviewPanel that
 *   opened it), which is what a restore of that editor has;
 * - the **conversation** it currently serves, which is what an index row or a
 *   launcher click has, and which a settled transfer re-points from A to B.
 *
 * Nothing here starts, stops or qualifies a process: it is a lookup table.
 *
 * The table is deliberately kind-blind: the same `host:<uuid>` slot names an rpc-ui host
 * (`managed-rpc`) or a previous build's TUI host (`managed-omp`). Which one a slot is comes
 * from the broker *record* filed under it (`kind`), which is what a caller reads to choose
 * `attachRpc` or `attach`; nothing here carries or guesses a kind.
 */
import { randomUUID } from "node:crypto";
import { mergeKeyedMap } from "./catalog-merge.ts";
import type { RecordConflictDraft } from "./catalog-merge.ts";

/** The key this table owns in workspace state. */
export const BROKER_SLOTS_KEY = "omp.brokerSlots.v1";

/**
 * How many hosts are remembered.
 *
 * The bound is a refusal threshold, never an eviction rule: an entry here may name
 * a broker that is still running, and silently dropping it would strand that process
 * (unfindable after a restart) or, worse, make its slot look free to a second
 * launch. A slot leaves this table only through {@link BrokerSlotStore.forget},
 * which a caller uses after a verified stop.
 */
export const BROKER_SLOT_LIMIT = 64;

/** The exact shape a managed host slot has: `host:<uuid>`. */
const HOST_SLOT_RE = /^host:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isHostSlotId(value: unknown): value is string {
	return typeof value === "string" && HOST_SLOT_RE.test(value);
}

/** Mint a fresh host slot for one managed launch. */
export function createHostSlotId(): string {
	return `host:${randomUUID()}`;
}

export interface BrokerMemento {
	get(key: string, fallback: unknown): unknown;
	update(key: string, value: unknown, base?: unknown): PromiseLike<void>;
}

interface BrokerSlotTable {
	/** Editor slot id to the host slot it opened. */
	readonly byEditor: Readonly<Record<string, string>>;
	/** Conversation tab id to the host slot currently serving it. */
	readonly byConversation: Readonly<Record<string, string>>;
	/**
	 * Conversation keys whose recorded value this version had to drop as malformed,
	 * or `null` when the table itself was not the shape this version writes.
	 *
	 * Kept so a caller that must decide whether a *writer* may exist can tell "this
	 * row recorded no slot" from "this row's provenance could not be read": dropping
	 * the difference would turn unknown metadata into absence. An identity two stored
	 * sources disagreed about is kept here as well — a mapping nobody could
	 * reconcile must not choose a transport for a live process.
	 */
	readonly unreadableConversations: ReadonlySet<string> | null;
	/** Editor keys this version had to drop as malformed, or `null` for a table it could not read at all. */
	readonly unreadableEditors: ReadonlySet<string> | null;
}

/**
 * What one identity's recorded broker provenance says, as a category.
 *
 * Only `none` may be read as "no broker provenance is recorded for this identity",
 * and even that is not proof that nothing was launched — an older hidden-terminal
 * launch recorded none at all.
 */
export type BrokerSlotProvenance =
	| { readonly kind: "none" }
	| { readonly kind: "unreadable" }
	| { readonly kind: "slot"; readonly slot: string };

function parseTable(value: unknown): BrokerSlotTable {
	const unreadableConversations = new Set<string>();
	const unreadableEditors = new Set<string>();
	if (value === undefined || value === null) {
		return { byEditor: {}, byConversation: {}, unreadableConversations, unreadableEditors };
	}
	if (typeof value !== "object" || Array.isArray(value)) {
		// A table this version cannot read at all: every identity's provenance is
		// unknown, which is what `null` marks.
		return { byEditor: {}, byConversation: {}, unreadableConversations: null, unreadableEditors: null };
	}
	const record = value as { byEditor?: unknown; byConversation?: unknown; conflictedConversations?: unknown; conflictedEditors?: unknown };
	// Identities an import could not reconcile: their mapping is retained for
	// recovery but never chosen as a transport.
	for (const key of identityList(record.conflictedConversations)) unreadableConversations.add(key);
	for (const key of identityList(record.conflictedEditors)) unreadableEditors.add(key);
	let structural = false;
	const read = (source: unknown, dropped: Set<string>): Record<string, string> => {
		const out: Record<string, string> = {};
		if (source === undefined || source === null) return out;
		if (typeof source !== "object" || Array.isArray(source)) {
			structural = true;
			return out;
		}
		for (const [key, slot] of Object.entries(source as Record<string, unknown>)) {
			if (key.length === 0 || key.length > 128 || !isHostSlotId(slot)) {
				dropped.add(key);
				continue;
			}
			out[key] = slot;
		}
		return out;
	};
	const byEditor = read(record.byEditor, unreadableEditors);
	const byConversation = read(record.byConversation, unreadableConversations);
	return {
		byEditor,
		byConversation,
		unreadableConversations: structural ? null : unreadableConversations,
		unreadableEditors: structural ? null : unreadableEditors,
	};
}

/**
 * What recording a host slot produced.
 *
 * A refusal means this window cannot carry another host: the caller must not start
 * one it could not record, because an unrecorded broker is a process no restart can
 * find again.
 */
export type BrokerSlotRecordResult =
	| { readonly ok: true }
	| { readonly ok: false; readonly reason: string };

/** What moving a conversation binding produced. */
export type BrokerSlotRepointResult =
	| { readonly ok: true; readonly slot: string }
	| { readonly ok: false; readonly reason: string };

/**
 * The table one repoint would commit, or why it must not be applied.
 *
 * `value` is the whole `omp.brokerSlots.v1` record as it should be committed; it is
 * handed to a catalog transaction rather than written here, so the conversation's row,
 * its binding and this mapping become visible together.
 */
export type BrokerRepointPlan =
	| {
			readonly ok: true;
			readonly slot: string;
			/** The mapping the plan would commit, per identity, for a caller that writes it itself. */
			readonly byEditor: Readonly<Record<string, string>>;
			readonly byConversation: Readonly<Record<string, string>>;
			/** The whole record as the catalog transaction should commit it. */
			readonly value: unknown;
	  }
	| { readonly ok: false; readonly reason: string };

export interface BrokerSlotStore {
	/** The host slot recorded for one conversation, or `null`. */
	forConversation(tabId: string): string | null;
	/** The host slot recorded for one editor slot, or `null`. */
	forEditor(editorId: string): string | null;
	/**
	 * What the recorded provenance for one identity says, without loss.
	 *
	 * {@link BrokerSlotStore.forConversation} and {@link BrokerSlotStore.forEditor}
	 * answer `null` both for "no slot is recorded" and for a mapping this version had
	 * to drop as malformed. A caller deciding whether a *writer* may exist must keep
	 * that difference, and this is where it is preserved: an unreadable table or
	 * entry is `unreadable`, never "no slot".
	 */
	provenanceFor(keys: { readonly conversation?: string | null; readonly editor?: string | null }): BrokerSlotProvenance;
	/**
	 * Every mapping the table holds and whether it was read in full, for a caller deciding
	 * whether a slot is referenced by *anything*.
	 *
	 * `complete` is `false` when the table was not the shape this version writes, or any
	 * identity's value was dropped as malformed or retained as a conflict marker: a slot
	 * named only by such an entry is not "unreferenced", it is unknown.
	 */
	references(): {
		readonly byConversation: Readonly<Record<string, string>>;
		readonly byEditor: Readonly<Record<string, string>>;
		readonly complete: boolean;
	};
	/**
	 * Record the same host slot under both identities.
	 *
	 * Called before a launch, so a full table refuses *before* a process exists;
	 * re-recording a slot this table already knows is never growth.
	 */
	record(input: { readonly slot: string; readonly conversation: string | null; readonly editor: string | null }): Promise<BrokerSlotRecordResult>;
	/**
	 * Move one conversation's binding to another row, keeping the editor's.
	 *
	 * Refused when the destination already names a *different* host slot: that is the
	 * live-incumbent case, where two writers exist for one conversation and the
	 * incumbent's mapping must not be overwritten — both are kept, each under its own
	 * immutable editor slot, and the caller treats the newcomer as non-controlling.
	 */
	repointConversation(fromTabId: string, toTabId: string): Promise<BrokerSlotRepointResult>;
	/**
	 * The repointed table, computed without writing.
	 *
	 * A settled conversation switch publishes the conversation's row and binding
	 * together with the mapping that follows the same process, in one catalog
	 * transaction (`SessionIndex`'s companion change). This is the value that
	 * transaction commits: the same rule {@link BrokerSlotStore.repointConversation}
	 * applies, evaluated against the current table so the caller can hand the result to
	 * a commit that does the durable write itself.
	 */
	planRepoint(fromTabId: string, toTabId: string): BrokerRepointPlan;
	/**
	 * The same plan computed against a table the caller supplies.
	 *
	 * A settled switch must be planned against the *newest committed* table inside the
	 * catalog transaction that publishes the conversation, so a mapping another window
	 * recorded meanwhile refuses the switch instead of being overwritten by this window's
	 * cached copy.
	 */
	planRepointAgainst(table: unknown, fromTabId: string, toTabId: string, claimedDestinationSlot?: string): BrokerRepointPlan;
	/** Forget a host slot entirely, once its process is proven stopped. */
	forget(slot: string): Promise<void>;
	/**
	 * Forget this window's cached copy of the table, so the next read is the newest
	 * committed revision. Called when the shared catalog changed under this window.
	 */
	reload(): void;
}

/**
 * Build the table over one memento.
 *
 * The bound is applied per map on write: the table is a lookup, and a slot whose
 * record the broker has already retired is uninteresting here — the broker's own
 * record is the authority on whether a process still exists.
 */
export function createBrokerSlotStore(memento: BrokerMemento): BrokerSlotStore {
	let cache: BrokerSlotTable | null = null;
	/** The record this window's table was derived from, named as the merge base. */
	let loadedBase: unknown = undefined;
	const load = (): BrokerSlotTable => {
		if (cache === null) {
			loadedBase = memento.get(BROKER_SLOTS_KEY, null);
			cache = parseTable(loadedBase);
		}
		return cache;
	};
	const write = async (next: {
		readonly byEditor: Readonly<Record<string, string>>;
		readonly byConversation: Readonly<Record<string, string>>;
	}): Promise<void> => {
		const current = load();
		const written = {
			byEditor: next.byEditor,
			byConversation: next.byConversation,
			// A mapping an import could not reconcile, or a record this version could
			// not read, stays unreadable: it must never become "no slot is recorded".
			conflictedConversations: [...(current.unreadableConversations ?? [])],
			conflictedEditors: [...(current.unreadableEditors ?? [])],
		};
		await memento.update(BROKER_SLOTS_KEY, written, loadedBase);
		loadedBase = written;
		// What this window just wrote is readable by construction, so nothing new is
		// recorded as dropped.
		cache = {
			byEditor: next.byEditor,
			byConversation: next.byConversation,
			unreadableConversations: current.unreadableConversations === null ? null : new Set(current.unreadableConversations),
			unreadableEditors: current.unreadableEditors === null ? null : new Set(current.unreadableEditors),
		};
	};
	return {
		forConversation(tabId: string): string | null {
			return load().byConversation[tabId] ?? null;
		},
		forEditor(editorId: string): string | null {
			return load().byEditor[editorId] ?? null;
		},
		references() {
			const table = load();
			const complete =
				table.unreadableConversations !== null &&
				table.unreadableEditors !== null &&
				table.unreadableConversations.size === 0 &&
				table.unreadableEditors.size === 0;
			return { byConversation: table.byConversation, byEditor: table.byEditor, complete };
		},
		provenanceFor(keys): BrokerSlotProvenance {
			const table = load();
			if (table.unreadableConversations === null || table.unreadableEditors === null) return { kind: "unreadable" };
			const conversation = keys.conversation ?? null;
			if (conversation !== null) {
				const slot = table.byConversation[conversation] ?? null;
				if (slot !== null) return { kind: "slot", slot };
				if (table.unreadableConversations.has(conversation)) return { kind: "unreadable" };
			}
			const editor = keys.editor ?? null;
			if (editor !== null) {
				const slot = table.byEditor[editor] ?? null;
				if (slot !== null) return { kind: "slot", slot };
				if (table.unreadableEditors.has(editor)) return { kind: "unreadable" };
			}
			return { kind: "none" };
		},
		async record(input): Promise<BrokerSlotRecordResult> {
			const current = load();
			const known =
				(input.editor !== null && current.byEditor[input.editor] !== undefined) ||
				(input.conversation !== null && current.byConversation[input.conversation] === input.slot);
			const distinct = new Set([...Object.values(current.byEditor), ...Object.values(current.byConversation)]);
			if (!known && distinct.size >= BROKER_SLOT_LIMIT) {
				return {
					ok: false,
					reason:
						`This window already tracks ${BROKER_SLOT_LIMIT} running OMP hosts, and a broker record may name a live ` +
						"process, so no entry is dropped to make room. Close one of those sessions and try again.",
				};
			}
			const byEditor = { ...current.byEditor };
			const byConversation = { ...current.byConversation };
			if (input.editor !== null) byEditor[input.editor] = input.slot;
			if (input.conversation !== null) byConversation[input.conversation] = input.slot;
			await write({ byEditor, byConversation });
			return { ok: true };
		},
		planRepoint(fromTabId: string, toTabId: string): BrokerRepointPlan {
			return planBrokerRepoint(load(), fromTabId, toTabId);
		},
		planRepointAgainst(table: unknown, fromTabId: string, toTabId: string, claimedDestinationSlot?: string): BrokerRepointPlan {
			return planBrokerRepoint(table, fromTabId, toTabId, claimedDestinationSlot);
		},
		async repointConversation(fromTabId: string, toTabId: string): Promise<BrokerSlotRepointResult> {
			const plan = this.planRepoint(fromTabId, toTabId);
			if (!plan.ok) return { ok: false, reason: plan.reason };
			await write({ byEditor: plan.byEditor, byConversation: plan.byConversation });
			return { ok: true, slot: plan.slot };
		},
		async forget(slot: string): Promise<void> {
			const current = load();
			const drop = (map: Readonly<Record<string, string>>): Record<string, string> => {
				const out: Record<string, string> = {};
				for (const [key, value] of Object.entries(map)) if (value !== slot) out[key] = value;
				return out;
			};
			await write({ byEditor: drop(current.byEditor), byConversation: drop(current.byConversation) });
		},
		reload(): void {
			cache = null;
			loadedBase = undefined;
		},
	};
}

/**
 * The repointed table for one conversation, computed from a *given* table.
 *
 * Pure so the plan can be evaluated against the newest committed table inside the
 * catalog transaction that publishes the conversation it belongs to, rather than against
 * this window's cached copy: a mapping another window recorded meanwhile makes the plan
 * refuse instead of being overwritten by it.
 */
export function planBrokerRepoint(table: unknown, fromTabId: string, toTabId: string, claimedDestinationSlot?: string): BrokerRepointPlan {
	const current = parseTable(table);
	const slot = current.byConversation[fromTabId] ?? null;
	if (slot === null) return { ok: false, reason: `no broker slot is recorded for ${fromTabId}` };
	const existing = current.byConversation[toTabId] ?? null;
	// Native observation may replace the exact old mapping only after the destination
	// row was reconciled and its writer claim acquired. A newer mapping still refuses;
	// the old editor lookup stays intact for recovery.
	if (claimedDestinationSlot !== undefined && (current.unreadableConversations === null || current.unreadableConversations.has(toTabId))) {
		return { ok: false, reason: "the claimed native destination has unreadable broker provenance" };
	}
	if (existing !== null && existing !== slot && existing !== claimedDestinationSlot) {
		return { ok: false, reason: `another running OMP host is already recorded for that conversation (${existing})` };
	}
	const byConversation = { ...current.byConversation };
	delete byConversation[fromTabId];
	byConversation[toTabId] = slot;
	return {
		ok: true,
		slot,
		byEditor: current.byEditor,
		byConversation,
		value: {
			byEditor: current.byEditor,
			byConversation,
			conflictedEditors: [...(current.unreadableEditors ?? [])],
			conflictedConversations: [...(current.unreadableConversations ?? [])],
		},
	};
}

/** The identity list a conflict marker field may carry, read leniently. */
function identityList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string" && item.length > 0 && item.length <= 128);
}

/**
 * Merge this window's lookup table into the newest committed one.
 *
 * Both maps merge per identity, not as a whole value: two windows recording two
 * different hosts' slots both keep their entries, which is the case a whole-record
 * overwrite loses — and a lost broker mapping is a running process no restart can
 * find again. Identities an earlier read could not reconcile stay marked unreadable
 * through the merge, so a merging write never turns "unknown transport" into "no
 * transport recorded".
 */
export function mergeBrokerSlotRecords(input: {
	readonly base: unknown;
	readonly desired: unknown;
	readonly latest: unknown;
}): { readonly value: unknown; readonly conflicts: readonly RecordConflictDraft[] } {
	const conflicts: RecordConflictDraft[] = [];
	const desired = parseTable(input.desired);
	const latest = parseTable(input.latest);
	const base = parseTable(input.base);
	const byEditor = mergeKeyedMap({
		base: base.byEditor,
		desired: desired.byEditor,
		latest: latest.byEditor,
		label: "host slot mapping",
		conflicts,
	});
	const byConversation = mergeKeyedMap({
		base: base.byConversation,
		desired: desired.byConversation,
		latest: latest.byConversation,
		label: "host slot mapping",
		conflicts,
	});
	const unreadable = (mine: ReadonlySet<string> | null, theirs: ReadonlySet<string> | null): string[] => {
		if (mine === null || theirs === null) return [];
		return [...new Set([...mine, ...theirs])].sort();
	};
	return {
		value: {
			byEditor,
			byConversation,
			conflictedEditors: unreadable(desired.unreadableEditors, latest.unreadableEditors),
			conflictedConversations: unreadable(desired.unreadableConversations, latest.unreadableConversations),
		},
		conflicts,
	};
}

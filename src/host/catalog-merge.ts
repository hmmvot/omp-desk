/**
 * OMP Desk — the shared rules every record in the profile catalog merges by.
 *
 * A window writes a whole snapshot of the record it owns (its folder list, the
 * conversation index, the broker lookup table, a shell record, a panel surface),
 * but it may not write the snapshot it *has*: another window may have committed a
 * change since this window read the record. These helpers turn "here is my whole
 * snapshot" into "here is the difference I intend", which the catalog applies to the
 * newest committed revision under its lock (see `src/host/profile-catalog.ts`).
 *
 * Three rules, the same for every record:
 *
 * - **A record this window changed is this window's.** A user's action is never
 *   silently replaced by another window's write, and both versions are reported
 *   when the other window changed the same record (unless both wrote the same value,
 *   which loses nothing and is not reported; this holds for the keyed-array helper).
 * - **A record this window did not touch takes the committed value.** Another
 *   window's new or updated record survives here instead of being overwritten by
 *   this window's stale copy.
 * - **A record this window removed stays removed**, unless the other window changed
 *   it after the value this window saw — then the other window's change is kept and
 *   reported, because deleting a record somebody just wrote is worse than a row the
 *   user removes again.
 */

/** One record this window refused to apply, retained raw for recovery. */
export interface RecordConflictDraft {
	/** Identity of the record inside its key (tab id, slot id, folder path). */
	readonly identity: string;
	readonly reason: string;
	/** The value that was kept. */
	readonly retained: unknown;
	/** The value that was not applied. */
	readonly rejected: unknown;
}

/** Two values are the same record when their normalized JSON is identical. */
export function sameRecord(left: unknown, right: unknown): boolean {
	if (left === right) return true;
	if (left === undefined || right === undefined) return false;
	try {
		return JSON.stringify(left) === JSON.stringify(right);
	} catch {
		return false;
	}
}

/** Identity of one record inside a keyed collection. */
export type RecordKey<T> = (record: T) => string;

function indexBy<T>(records: readonly T[] | undefined, key: RecordKey<T>): Map<string, T> {
	return new Map((records ?? []).map(record => [key(record), record]));
}

/**
 * Three-way merge of one keyed collection: this window's delta over the committed
 * value.
 *
 * `base` is the value this window last saw (its in-memory state was derived from
 * it), `desired` is what this window wants now, and `latest` is what is committed.
 * Ordering follows `desired` so this window's own layout is stable, with records it
 * has never seen appended in their committed order.
 */
export function mergeKeyedArray<T>(input: {
	readonly base: readonly T[] | undefined;
	readonly desired: readonly T[] | undefined;
	readonly latest: readonly T[] | undefined;
	readonly key: RecordKey<T>;
	/** Human name of one record, for the conflict reason. */
	readonly label: string;
	readonly conflicts: RecordConflictDraft[];
}): T[] {
	const base = indexBy(input.base, input.key);
	const latest = indexBy(input.latest, input.key);
	const merged: T[] = [];
	const taken = new Set<string>();
	for (const record of input.desired ?? []) {
		const identity = input.key(record);
		taken.add(identity);
		const before = base.get(identity);
		const theirs = latest.get(identity);
		const mineIsLocalChange = before === undefined || !sameRecord(before, record);
		if (!mineIsLocalChange) {
			// Untouched here: the committed record is the answer, and its *absence* is a
			// committed deletion — another window removed the record this one never
			// changed, which must not be re-added by this window's stale copy.
			if (theirs !== undefined) merged.push(theirs);
			continue;
		}
		if (theirs !== undefined && !sameRecord(before, theirs) && !sameRecord(record, theirs)) {
			input.conflicts.push({
				identity,
				reason: `another window changed this ${input.label} while this window changed it too; this window's own facts were applied`,
				retained: record,
				rejected: theirs,
			});
		}
		merged.push(record);
	}
	for (const [identity, record] of latest) {
		if (taken.has(identity)) continue;
		const before = base.get(identity);
		if (before !== undefined && sameRecord(before, record)) continue;
		if (before !== undefined) {
			input.conflicts.push({
				identity,
				reason: `this window removed this ${input.label} while another window changed it; the change was kept`,
				retained: record,
				rejected: null,
			});
		}
		merged.push(record);
	}
	return merged;
}

/**
 * Merge one keyed string map (a lookup table) with the same rules.
 *
 * Maps are merged per key rather than as a whole value: two windows recording two
 * different conversations' broker slots both keep their entry, which is the case a
 * whole-record overwrite would silently lose.
 */
export function mergeKeyedMap<V>(input: {
	readonly base: Readonly<Record<string, V>> | undefined;
	readonly desired: Readonly<Record<string, V>> | undefined;
	readonly latest: Readonly<Record<string, V>> | undefined;
	readonly label: string;
	readonly conflicts: RecordConflictDraft[];
}): Record<string, V> {
	const base = input.base ?? {};
	const desired = input.desired ?? {};
	const latest = input.latest ?? {};
	const merged: Record<string, V> = {};
	for (const [identity, value] of Object.entries(desired)) {
		const before = base[identity];
		const theirs = latest[identity];
		const mineIsLocalChange = before === undefined || !sameRecord(before, value);
		if (!mineIsLocalChange) {
			// Untouched here: a committed *absence* is a deletion another window made.
			if (theirs !== undefined) merged[identity] = theirs;
			continue;
		}
		if (mineIsLocalChange && theirs !== undefined && !sameRecord(before, theirs)) {
			input.conflicts.push({
				identity,
				reason: `another window changed this ${input.label} while this window changed it too; this window's own mapping was applied`,
				retained: value,
				rejected: theirs,
			});
		}
		merged[identity] = value;
	}
	for (const [identity, value] of Object.entries(latest)) {
		if (Object.prototype.hasOwnProperty.call(merged, identity)) continue;
		const before = base[identity];
		if (before !== undefined && sameRecord(before, value)) continue;
		if (before !== undefined) {
			input.conflicts.push({
				identity,
				reason: `this window removed this ${input.label} while another window changed it; the change was kept`,
				retained: value,
				rejected: null,
			});
		}
		merged[identity] = value;
	}
	return merged;
}

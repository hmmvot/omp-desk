/**
 * Read the broker records of one or two storage roots for the Processes view.
 *
 * Records are immutable once published, and the registry keeps one per broker ever
 * stopped (a stopped broker keeps its record as recovery metadata), so a listing that
 * re-read and re-parsed every file on every refresh would grow with the history. A parsed
 * record is therefore cached by file name together with the file's size and modification
 * time, and only a changed or new file is read. The token is dropped at the parse
 * boundary: nothing downstream of this module carries a capability.
 *
 * The predecessor directory is read, never written, locked or verified here; its records
 * only ever become list-only rows (`broker-processes.ts`).
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { brokerRecordFacts } from "./broker-processes.ts";
import type { BrokerProcessSource, SourcedBrokerRecord } from "./broker-processes.ts";
import { PTY_RECORD_SUFFIX, parsePtyBrokerRecord } from "./pty-protocol.ts";
import { ptyStateDirectory } from "./pty-registry.ts";

export interface BrokerRecordListing {
	readonly records: readonly SourcedBrokerRecord[];
	/** Record-named files that could not be read or parsed. */
	readonly unreadable: number;
}

export interface BrokerRecordListerOptions {
	/** This extension's global storage. */
	readonly storageDir: string;
	/** The predecessor id's global storage, or `null` to skip it. */
	readonly predecessorStorageDir: string | null;
}

interface CachedFile {
	readonly stamp: string;
	/** `null` when the file did not parse. */
	readonly record: SourcedBrokerRecord | null;
}

/** A lister that remembers what it has parsed. */
export function createBrokerRecordLister(options: BrokerRecordListerOptions): () => Promise<BrokerRecordListing> {
	const cache = new Map<string, CachedFile>();

	async function readDirectory(directory: string, source: BrokerProcessSource, seen: Set<string>): Promise<{ records: SourcedBrokerRecord[]; unreadable: number }> {
		let names: string[];
		try {
			names = await readdir(directory);
		} catch {
			return { records: [], unreadable: 0 };
		}
		const records: SourcedBrokerRecord[] = [];
		let unreadable = 0;
		for (const name of names) {
			if (!name.endsWith(PTY_RECORD_SUFFIX)) continue;
			const path = join(directory, name);
			seen.add(path);
			let stamp: string;
			try {
				const info = await stat(path);
				stamp = `${info.size}|${info.mtimeMs}`;
			} catch {
				unreadable++;
				continue;
			}
			let entry = cache.get(path);
			if (entry === undefined || entry.stamp !== stamp) {
				let record: SourcedBrokerRecord | null = null;
				try {
					record = { source, record: brokerRecordFacts(parsePtyBrokerRecord(JSON.parse(await readFile(path, "utf8")))) };
				} catch {
					record = null;
				}
				entry = { stamp, record };
				cache.set(path, entry);
			}
			if (entry.record === null) unreadable++;
			else records.push(entry.record);
		}
		return { records, unreadable };
	}

	return async () => {
		const seen = new Set<string>();
		const current = await readDirectory(ptyStateDirectory(options.storageDir), "current", seen);
		const predecessor =
			options.predecessorStorageDir === null
				? { records: [], unreadable: 0 }
				: await readDirectory(ptyStateDirectory(options.predecessorStorageDir), "predecessor", seen);
		for (const path of [...cache.keys()]) if (!seen.has(path)) cache.delete(path);
		return { records: [...current.records, ...predecessor.records], unreadable: current.unreadable + predecessor.unreadable };
	};
}

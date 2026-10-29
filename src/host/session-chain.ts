/**
 * Session continuations (OMP 18.13): the same conversation moved to a newer file.
 *
 * A session that cannot keep writing its own file (another live process owns it, or the file changed under it) goes on in
 * a sibling `<time>_<newId>.jsonl` of the same directory. Its header carries a new session id and `continuationOf`, the id
 * of the session it continues; the old file is left as it was, and `--session <old file>` opens the newest copy. So the
 * file and the id OMP serves are not the ones that were asked for, without anything being wrong.
 *
 * This module is the one place that decides whether a file really continues another one. The decision reads the files:
 * nothing OMP reports is trusted by itself. Nothing here writes, claims or touches the catalog.
 */
import { readdir } from "node:fs/promises";
import * as path from "node:path";
import { normalizeSessionIdentityKey, readSessionFileHeader } from "./session-files.ts";
import type { SessionFileHeader } from "./session-files.ts";

/** Most links followed from a file back to the one asked for; a chain this long is not a chain OMP made. */
export const MAX_CONTINUATION_HOPS = 64;

/** Session ids are UUIDs; an id with anything else in it is never put into a file name pattern. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** Evidence that `toFile` is the conversation of `fromFile` carried on in a newer file. */
export interface ContinuationProof {
	/** The file that was asked for (the older one). */
	readonly fromFile: string;
	/** The file the conversation went on in (the newer one). */
	readonly toFile: string;
	/** The session id in `fromFile`'s own header. */
	readonly fromId: string;
	/** The session id in `toFile`'s own header: the id OMP serves from `toFile`. */
	readonly toId: string;
	/** Links between the two files: 1 for a direct continuation. */
	readonly hops: number;
}

/** What {@link proveContinuation} reads; replaceable by a test. */
export interface ContinuationReaders {
	readonly readHeader: (file: string) => Promise<SessionFileHeader | null>;
	readonly listDirectory: (directory: string) => Promise<readonly string[]>;
}

const DEFAULT_READERS: ContinuationReaders = {
	readHeader: readSessionFileHeader,
	listDirectory: directory => readdir(directory),
};

/** Whether two files are the same file (the claim module's identity: case and 8.3 aliases on Windows). */
function sameFile(left: string, right: string): boolean {
	return normalizeSessionIdentityKey(left) === normalizeSessionIdentityKey(right);
}

/**
 * Whether `toFile` is a continuation of `fromFile`: walking back from `toFile` along `continuationOf` reaches `fromFile`.
 *
 * Each step reads the header of the current file, takes the id its `continuationOf` names and looks for the file of that id
 * in the same directory, by its `<time>_<id>.jsonl` name or as `fromFile` itself; the file found must hold that very id in
 * its own header. The proof is `null` when any of this fails: `toFile` is `fromFile`, a header is unreadable, a link is
 * missing or names an id that no file of the directory holds, two files hold the id, the chain repeats an id (a cycle) or
 * is longer than {@link MAX_CONTINUATION_HOPS}, or `fromFile` is not in the chain at all (an unrelated or forged link).
 */
export async function proveContinuation(
	fromFile: string,
	toFile: string,
	readers: ContinuationReaders = DEFAULT_READERS,
): Promise<ContinuationProof | null> {
	if (!path.isAbsolute(fromFile) || !path.isAbsolute(toFile) || sameFile(fromFile, toFile)) return null;
	const directory = path.dirname(toFile);
	if (!sameFile(path.dirname(fromFile), directory)) return null;
	const [from, to] = await Promise.all([readers.readHeader(fromFile), readers.readHeader(toFile)]);
	if (from === null || to === null || from.sessionId === to.sessionId) return null;
	let names: readonly string[] | null = null;
	const seen = new Set<string>([to.sessionId]);
	let current: SessionFileHeader = to;
	for (let hops = 1; hops <= MAX_CONTINUATION_HOPS; hops++) {
		const parentId = current.continuationOf;
		if (parentId === undefined || !SESSION_ID_PATTERN.test(parentId) || seen.has(parentId)) return null;
		seen.add(parentId);
		if (parentId === from.sessionId) {
			// The file asked for holds this id. A second file of the directory holding it too would make the link ambiguous.
			names ??= await readers.listDirectory(directory);
			const others = await filesHoldingId(directory, names, parentId, readers, fromFile);
			return others === 0 ? { fromFile, toFile, fromId: from.sessionId, toId: to.sessionId, hops } : null;
		}
		names ??= await readers.listDirectory(directory);
		const parent = await fileHoldingId(directory, names, parentId, readers);
		if (parent === null) return null;
		current = parent;
	}
	return null;
}

/** The one file of `directory` named for `id` whose own header holds it; `null` for none or for more than one. */
async function fileHoldingId(
	directory: string,
	names: readonly string[],
	id: string,
	readers: ContinuationReaders,
): Promise<SessionFileHeader | null> {
	let found: SessionFileHeader | null = null;
	for (const name of names) {
		if (!name.endsWith(`_${id}.jsonl`)) continue;
		const header = await readers.readHeader(path.join(directory, name));
		if (header === null || header.sessionId !== id) continue;
		if (found !== null) return null;
		found = header;
	}
	return found;
}

/** How many files of `directory` named for `id`, other than `except`, hold `id` in their own header. */
async function filesHoldingId(
	directory: string,
	names: readonly string[],
	id: string,
	readers: ContinuationReaders,
	except: string,
): Promise<number> {
	let count = 0;
	for (const name of names) {
		if (!name.endsWith(`_${id}.jsonl`)) continue;
		const file = path.join(directory, name);
		if (sameFile(file, except)) continue;
		const header = await readers.readHeader(file);
		if (header !== null && header.sessionId === id) count++;
	}
	return count;
}

/** One session file of a listing, narrowed to what grouping a chain needs. */
export interface ChainMember {
	/** Anything that identifies the file to the caller (usually its path). */
	readonly key: string;
	/** The directory of the file: a chain never crosses one. */
	readonly directory: string;
	readonly sessionId: string;
	readonly continuationOf: string | null;
}

/**
 * The chains among `members`: files of one directory linked by `continuationOf`, each chain in the order it was listed.
 * A file that continues nothing the list holds and is continued by nothing is a chain of one. Every member is in exactly one
 * chain. The grouping only reads what the members already carry: it proves nothing, and a caller that must be sure of a link
 * asks {@link proveContinuation}.
 */
export function groupChains<T extends ChainMember>(members: readonly T[]): T[][] {
	const parent = new Map<number, number>();
	const find = (index: number): number => {
		let root = index;
		while ((parent.get(root) ?? root) !== root) root = parent.get(root) ?? root;
		parent.set(index, root);
		return root;
	};
	const byId = new Map<string, number[]>();
	members.forEach((member, index) => {
		const key = `${normalizeSessionIdentityKey(member.directory)}\u0000${member.sessionId}`;
		byId.set(key, [...(byId.get(key) ?? []), index]);
	});
	members.forEach((member, index) => {
		if (member.continuationOf === null) return;
		const targets = byId.get(`${normalizeSessionIdentityKey(member.directory)}\u0000${member.continuationOf}`) ?? [];
		// An id that two listed files hold links nothing: which of them continued is not known.
		if (targets.length !== 1) return;
		const left = find(index);
		const right = find(targets[0]!);
		if (left !== right) parent.set(left, right);
	});
	const chains = new Map<number, T[]>();
	members.forEach((member, index) => {
		const root = find(index);
		chains.set(root, [...(chains.get(root) ?? []), member]);
	});
	return [...chains.values()];
}

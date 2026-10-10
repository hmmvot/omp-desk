/**
 * Change notification for the session claims directory (ADR-0039).
 *
 * Claims are filed by other extension windows, so this window only learns of a
 * claim, release or takeover by watching the directory. The watch is a hint, like
 * the profile catalog's: the caller re-reads the claims it cares about, so a missed
 * or spurious event costs a refresh, never correctness.
 */

import * as path from "node:path";
import { watchDirectory } from "./directory-watch.ts";
import { claimPathFor, claimsDirectory } from "./session-claim.ts";

const CLAIM_FILE_SUFFIX = ".claim";

export interface ClaimWatchOptions {
	/** Debounce window that folds the several events of one claim write into one callback. */
	readonly debounceMs?: number;
	readonly onError?: (detail: string) => void;
}

/**
 * Watch the session claims directory (creating it when missing) and call
 * `onChange` once per debounce window with the distinct claim file base names
 * (`<hex>.claim`) that changed in it. Mutex, staging and temporary entries are
 * ignored.
 *
 * An EMPTY set means the platform reported a change without a file name, or a
 * window mixed named and nameless events: which claims changed is unknown, so the
 * caller MUST treat every claim as possibly changed.
 *
 * Never throws; setup, watcher and `onChange` failures go to `options.onError`.
 * Returns an idempotent disposer; after it runs no callback fires, even for an
 * event that was already queued.
 */
export function startClaimWatch(
	storageDir: string,
	onChange: (claimFiles: ReadonlySet<string>) => void,
	options: ClaimWatchOptions = {},
): () => void {
	let directory: string;
	try {
		directory = claimsDirectory(storageDir);
	} catch (error) {
		options.onError?.(`the session claims directory could not be watched: ${error instanceof Error ? error.message : String(error)}`);
		return () => {};
	}
	return watchDirectory(directory, onChange, {
		suffix: CLAIM_FILE_SUFFIX,
		description: "the session claims directory",
		...(options.debounceMs === undefined ? {} : { debounceMs: options.debounceMs }),
		...(options.onError === undefined ? {} : { onError: options.onError }),
	});
}

/**
 * Base name of the claim file `identity` (a session file path or a draft
 * identity) is filed under, in the form {@link startClaimWatch} reports it.
 */
export function claimFileNameFor(storageDir: string, identity: string): string {
	return path.basename(claimPathFor(storageDir, identity));
}

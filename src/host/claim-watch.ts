/**
 * Change notification for the session claims directory (ADR-0039).
 *
 * Claims are filed by other extension windows, so this window only learns of a
 * claim, release or takeover by watching the directory. The watch is a hint, like
 * the profile catalog's: the caller re-reads the claims it cares about, so a missed
 * or spurious event costs a refresh, never correctness.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { claimPathFor, claimsDirectory } from "./session-claim.ts";

const CLAIM_FILE_SUFFIX = ".claim";
const DEFAULT_DEBOUNCE_MS = 150;

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
	const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
	const report = (detail: string): void => {
		try {
			options.onError?.(detail);
		} catch {
			// An error sink that throws must not take the watcher down.
		}
	};
	let disposed = false;
	let timer: NodeJS.Timeout | null = null;
	let pending = new Set<string>();
	let unknown = false;

	const schedule = (): void => {
		if (timer !== null) return;
		timer = setTimeout(() => {
			timer = null;
			if (disposed) return;
			const changed: ReadonlySet<string> = unknown ? new Set<string>() : pending;
			pending = new Set<string>();
			unknown = false;
			try {
				onChange(changed);
			} catch (error) {
				report(`a session claim change handler failed: ${messageOf(error)}`);
			}
		}, debounceMs);
		timer.unref?.();
	};

	let watcher: fs.FSWatcher | null = null;
	try {
		const directory = claimsDirectory(storageDir);
		fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
		watcher = fs.watch(directory, { persistent: false }, (_event, filename) => {
			if (disposed) return;
			if (filename === null || filename === undefined) {
				unknown = true;
				schedule();
				return;
			}
			const name = path.basename(String(filename));
			if (!name.endsWith(CLAIM_FILE_SUFFIX)) return;
			pending.add(name);
			schedule();
		});
		watcher.on("error", error => {
			report(`the session claims directory could not be watched: ${messageOf(error)}`);
		});
	} catch (error) {
		report(`the session claims directory could not be watched: ${messageOf(error)}`);
	}

	return () => {
		disposed = true;
		clearTimeout(timer ?? undefined);
		timer = null;
		pending.clear();
		unknown = false;
		watcher?.close();
		watcher = null;
	};
}

/**
 * Base name of the claim file `identity` (a session file path or a draft
 * identity) is filed under, in the form {@link startClaimWatch} reports it.
 */
export function claimFileNameFor(storageDir: string, identity: string): string {
	return path.basename(claimPathFor(storageDir, identity));
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

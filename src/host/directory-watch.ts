/**
 * Debounced change notification for one directory of shared global storage.
 *
 * The claims, window-registry and window-request directories are written by other
 * extension windows, so this window only learns of a change by watching the directory.
 * The watch is a hint: the caller re-reads what it cares about, so a missed or spurious
 * event costs a refresh, never correctness.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export const DEFAULT_DIRECTORY_WATCH_DEBOUNCE_MS = 150;

export interface DirectoryWatchOptions {
	/** Only names ending in this suffix are reported; staging, mutex and temporary entries are ignored. */
	readonly suffix: string;
	/** Debounce window that folds the several events of one write into one callback. */
	readonly debounceMs?: number;
	/** What the directory is, for error text ("the session claims directory"). */
	readonly description: string;
	readonly onError?: (detail: string) => void;
}

/**
 * Watch `directory` (creating it when missing) and call `onChange` once per debounce
 * window with the distinct base names that changed in it.
 *
 * An EMPTY set means the platform reported a change without a file name, or a window
 * mixed named and nameless events: which entries changed is unknown, so the caller MUST
 * treat every entry as possibly changed.
 *
 * Never throws; setup, watcher and `onChange` failures go to `options.onError`. Returns
 * an idempotent disposer; after it runs no callback fires, even for an event that was
 * already queued.
 */
export function watchDirectory(
	directory: string,
	onChange: (names: ReadonlySet<string>) => void,
	options: DirectoryWatchOptions,
): () => void {
	const debounceMs = options.debounceMs ?? DEFAULT_DIRECTORY_WATCH_DEBOUNCE_MS;
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
				report(`a change handler of ${options.description} failed: ${messageOf(error)}`);
			}
		}, debounceMs);
		timer.unref?.();
	};

	let watcher: fs.FSWatcher | null = null;
	try {
		fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
		watcher = fs.watch(directory, { persistent: false }, (_event, filename) => {
			if (disposed) return;
			if (filename === null || filename === undefined) {
				unknown = true;
				schedule();
				return;
			}
			const name = path.basename(String(filename));
			if (!name.endsWith(options.suffix)) return;
			pending.add(name);
			schedule();
		});
		watcher.on("error", error => {
			report(`${options.description} could not be watched: ${messageOf(error)}`);
		});
	} catch (error) {
		report(`${options.description} could not be watched: ${messageOf(error)}`);
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

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

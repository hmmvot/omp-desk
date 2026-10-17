import path from "node:path";
import { silentLogger, type Logger } from "../shared/logger.ts";
import { isInside } from "./link-scope.ts";

/**
 * Which file-system events may change what a code link's lookup answers, and when the resolver is told
 * (docs/designs/2026-10-10-code-symbol-links.md, "Fencing"). Pure: the settings, the clock and the timers are injected.
 *
 * The workspace watcher sees everything under the workspace folders, a Unity project's `Temp/` and `Library/` and a
 * repository's `.git/` included, and every create, delete or rename it reports discards the lookups under way. A file
 * the window hides from search (`files.exclude`, `search.exclude` of its own workspace folder, which are the globs
 * the file search passes to `findFiles`) or that lies below `.git` is never in a lookup's answer, so an event for it is
 * ignored. The events that remain are coalesced: one invalidation per burst, not one per file.
 */

/** The regular expression of one VS Code glob (`**`, `*`, `?`, `[a-z]`, `[!a-z]`, `{a,b}`), or `null` for syntax this does not handle (the pattern then hides nothing: an event is ignored only when it is certain). */
export function globRegExp(pattern: string): RegExp | null {
	let source = "";
	let depth = 0;
	for (let index = 0; index < pattern.length; index++) {
		const char = pattern[index]!;
		if (char === "*") {
			if (pattern[index + 1] !== "*") { source += "[^/]*"; continue; }
			let end = index + 2;
			while (pattern[end] === "*") end++;
			if (pattern[end] === "/") { source += "(?:[^/]+/)*"; index = end; } else { source += ".*"; index = end - 1; }
		} else if (char === "?") source += "[^/]";
		else if (char === "{") { depth++; source += "(?:"; }
		else if (char === "}") {
			if (depth === 0) return null;
			depth--;
			source += ")";
		} else if (char === ",") source += depth > 0 ? "|" : ",";
		else if (char === "[") {
			const close = pattern.indexOf("]", index + 2);
			if (close < 0) return null;
			const body = pattern.slice(index + 1, close);
			if (!/^!?[\w.\-]+$/.test(body)) return null;
			source += `[${body.startsWith("!") ? `^${body.slice(1)}` : body}]`;
			index = close;
		} else if (char === "\\") return null;
		else source += char.replace(/[.+^$()|\\/]/g, "\\$&");
	}
	if (depth !== 0) return null;
	try { return new RegExp(`^${source}$`); } catch { return null; }
}

/** What an event for a file may do to the lookups. */
export type FileEventKind = "created" | "deleted" | "changed";

export interface FileEventGateOptions {
	/** The open workspace folders. */
	readonly folders: () => readonly string[];
	/** The patterns `folder`'s own `files.exclude` and `search.exclude` hide (the search's own source of them). */
	readonly excludes: (folder: string) => readonly string[];
	/** Some file appeared, vanished or moved: every answer is stale. */
	readonly dropFiles: () => void;
	/** Some file's contents changed: the symbol answers are stale. */
	readonly dropContent: () => void;
	/** An event burst is reported this long after its last event. */
	readonly delayMs?: number;
	/** A burst that never pauses is reported at the latest this long after its first event. */
	readonly maxWaitMs?: number;
	readonly now?: () => number;
	readonly log?: Logger;
}

const BURST_DELAY_MS = 250;
const BURST_MAX_WAIT_MS = 2000;

/**
 * Filters and coalesces the watcher's events. A change is reported as {@link FileEventGateOptions.dropFiles} when the burst held
 * a create, a delete or a rename, else as {@link FileEventGateOptions.dropContent}.
 */
export class FileEventGate {
	readonly #options: FileEventGateOptions;
	readonly #now: () => number;
	readonly #log: Logger;
	readonly #patterns = new Map<string, readonly RegExp[]>();
	#filesDirty = false;
	#contentDirty = false;
	#timer: NodeJS.Timeout | undefined;
	#burstStartedAt = 0;
	#events = 0;
	#ignored = 0;

	constructor(options: FileEventGateOptions) {
		this.#options = options;
		this.#now = options.now ?? Date.now;
		this.#log = options.log ?? silentLogger;
	}

	/** A file was created, deleted or changed. Ignored when the answer of no lookup can depend on it. */
	event(kind: FileEventKind, file: string): void {
		if (this.#hidden(file)) { this.#ignored++; return; }
		this.#events++;
		if (kind === "changed") this.#contentDirty = true; else this.#filesDirty = true;
		this.#schedule();
	}

	/** Files were renamed by the user in VS Code; the paths are not looked at. */
	renamed(): void {
		this.#events++;
		this.#filesDirty = true;
		this.#schedule();
	}

	/** `files.exclude` or `search.exclude` changed, or the workspace folders did: the patterns are read again with the next event. */
	resetExcludes(): void {
		this.#patterns.clear();
	}

	dispose(): void {
		clearTimeout(this.#timer);
		this.#timer = undefined;
	}

	#schedule(): void {
		const delay = this.#options.delayMs ?? BURST_DELAY_MS;
		const now = this.#now();
		if (this.#timer === undefined) this.#burstStartedAt = now;
		else clearTimeout(this.#timer);
		const wait = Math.max(0, Math.min(delay, this.#burstStartedAt + (this.#options.maxWaitMs ?? BURST_MAX_WAIT_MS) - now));
		this.#timer = setTimeout(() => this.#flush(), wait);
		this.#timer.unref?.();
	}

	#flush(): void {
		this.#timer = undefined;
		const files = this.#filesDirty;
		const content = this.#contentDirty;
		this.#log.debug(`link lookups: ${files ? "files" : "contents"} changed (${this.#events} event${this.#events === 1 ? "" : "s"}, ${this.#ignored} ignored since the last report)`);
		this.#filesDirty = false;
		this.#contentDirty = false;
		this.#events = 0;
		this.#ignored = 0;
		if (files) this.#options.dropFiles();
		else if (content) this.#options.dropContent();
	}

	/** Whether no lookup can depend on `file`: it lies below `.git`, or every workspace folder holding it hides it. */
	#hidden(file: string): boolean {
		if (path.win32.normalize(file).split("\\").includes(".git")) return true;
		const holding = this.#options.folders().filter(folder => isInside(folder, file));
		return holding.length > 0 && holding.every(folder => this.#hiddenIn(folder, file));
	}

	/** Whether `folder`'s excludes hide `file`: a pattern that matches the file or a directory above it. */
	#hiddenIn(folder: string, file: string): boolean {
		const relative = path.win32.relative(folder, file);
		if (relative === "") return false;
		let patterns = this.#patterns.get(folder.toLowerCase());
		if (patterns === undefined) {
			patterns = this.#options.excludes(folder).flatMap(pattern => globRegExp(pattern) ?? []);
			this.#patterns.set(folder.toLowerCase(), patterns);
		}
		if (patterns.length === 0) return false;
		const segments = relative.split("\\");
		for (let length = 1; length <= segments.length; length++) {
			const candidate = segments.slice(0, length).join("/");
			// `Temp/**` hides what is inside `Temp`, and so the directory itself: nothing in it is looked up.
			if (patterns.some(pattern => pattern.test(candidate) || (length === segments.length && pattern.test(`${candidate}/`)))) return true;
		}
		return false;
	}
}

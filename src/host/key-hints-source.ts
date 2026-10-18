/**
 * Keeps the effective keys of the empty state current (docs/designs/2026-10-18-chat-keys-and-empty-state.md, section 6).
 *
 * `src/host/key-hints.ts` computes; this module reads: this extension's manifest, the other installed extensions' manifests (given by
 * the caller, who also says when they change) and the user's `keybindings.json` of the active profile, and tells the caller when the
 * answer differs from the last one. It imports neither `vscode` nor the extension host's files, so the file and the watcher are ports
 * and a test can drive it with a scratch folder; `src/wiring/key-hints-wiring.ts` fills the ports in.
 *
 * Nothing here blocks activation: the first computation runs in the background, the file is read asynchronously and size-capped, and
 * a change is debounced. A file that is missing is no user bindings. A file that cannot be read, is too large or is not JSON keeps the
 * bindings read before it (the user may be half-way through an edit) and logs one line.
 */
import { open } from "node:fs/promises";
import { watch } from "node:fs";
import * as path from "node:path";
import type { Logger } from "../shared/logger.ts";
import { parseJsonc } from "../shared/jsonc.ts";
import { EMPTY_STATE_KEY_COMMANDS } from "../shared/key-hints.ts";
import type { ChatKeyHint, EmptyStateKeyCommand } from "../shared/key-hints.ts";
import { computeKeyHints, defaultBindingsOf, foreignBindingsOf, userBindingsOf } from "./key-hints.ts";
import type { DefaultBinding, ExtensionManifest, ForeignBinding, KeyHintResult, UserBinding } from "./key-hints.ts";

/** `keybindings.json` larger than this is not read. */
export const MAX_KEYBINDINGS_BYTES = 1024 * 1024;
/** Quiet time after an extension change and after a change of the file, before the read. */
export const EXTENSIONS_DEBOUNCE_MS = 100;
export const FILE_DEBOUNCE_MS = 150;

/** The folder of the profile that `globalStorageFsPath` (`<profile folder>/globalStorage/<publisher.name>`) belongs to. */
export function profileFolderOf(globalStorageFsPath: string): string {
	return path.dirname(path.dirname(globalStorageFsPath));
}

export interface KeyHintsSourceDeps {
	/** This extension's id and manifest: the defaults come from its own `contributes.keybindings`. */
	readonly ownId: string;
	readonly ownManifest: unknown;
	/** Every installed extension, this one included; read again after {@link KeyHintsSource.extensionsChanged}. */
	readonly extensions: () => readonly ExtensionManifest[];
	/** The user's `keybindings.json` of the active profile. */
	readonly keybindingsPath: string;
	/** The answer differs from the one before: tell the pages. */
	readonly changed: () => void;
	readonly log: Logger;
	/** The file's text, `null` when it does not exist; throws when it cannot be read or is larger than {@link MAX_KEYBINDINGS_BYTES}. Defaults to the file system. */
	readonly readFile?: (path: string) => Promise<string | null>;
	/** Calls `listener` when something in `folder` named `fileName` may have changed; defaults to `fs.watch` on the folder. */
	readonly watchFolder?: (folder: string, fileName: string, listener: () => void) => { dispose(): void } | null;
	readonly extensionsDebounceMs?: number;
	readonly fileDebounceMs?: number;
}

export interface KeyHintsSource {
	/** The hints as last computed, one per command; empty until the first computation has finished. */
	current(): readonly ChatKeyHint[];
	/** The Keyboard Shortcuts query for the current key of `command`, or `null` when it has none or nothing is known yet. */
	queryOf(command: EmptyStateKeyCommand): string | null;
	/** The installed extensions changed. */
	extensionsChanged(): void;
	/** Settles when the pending reads and recomputations are done (for tests). */
	idle(): Promise<void>;
	dispose(): void;
}

async function readCapped(file: string): Promise<string | null> {
	let handle;
	try {
		handle = await open(file, "r");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
	try {
		const { size } = await handle.stat();
		if (size > MAX_KEYBINDINGS_BYTES) throw new Error(`larger than ${MAX_KEYBINDINGS_BYTES} bytes`);
		return await handle.readFile({ encoding: "utf8" });
	} finally {
		await handle.close();
	}
}

function watchFolderOnDisk(folder: string, fileName: string, listener: () => void): { dispose(): void } | null {
	const wanted = fileName.toLowerCase();
	const watcher = watch(folder, { persistent: false }, (_event, changed) => {
		if (changed === null || changed.toString().toLowerCase() === wanted) listener();
	});
	// An error of the watcher (the folder was removed) ends the watch; the next change of the extensions still recomputes.
	watcher.on("error", () => watcher.close());
	return { dispose: () => watcher.close() };
}

export function createKeyHintsSource(deps: KeyHintsSourceDeps): KeyHintsSource {
	const read = deps.readFile ?? readCapped;
	const extensionsDelay = deps.extensionsDebounceMs ?? EXTENSIONS_DEBOUNCE_MS;
	const fileDelay = deps.fileDebounceMs ?? FILE_DEBOUNCE_MS;
	const defaults: readonly DefaultBinding[] = defaultBindingsOf(deps.ownManifest, EMPTY_STATE_KEY_COMMANDS);
	let foreign: readonly ForeignBinding[] = [];
	let user: readonly UserBinding[] = [];
	let results: readonly KeyHintResult[] = [];
	let serialized = "";
	let disposed = false;
	let extensionsTimer: NodeJS.Timeout | undefined;
	let fileTimer: NodeJS.Timeout | undefined;
	let fileGeneration = 0;
	const inFlight = new Set<Promise<void>>();

	const recompute = (reason: string): void => {
		const started = performance.now();
		results = computeKeyHints({ defaults, user, foreign });
		const hints = results.map(result => result.hint);
		const next = JSON.stringify(hints);
		const conflicts = hints.reduce((sum, hint) => sum + hint.conflicts.length + hint.more, 0);
		deps.log.debug(`key hints (${reason}): ${foreign.length} foreign binding(s), ${user.length} user entr${user.length === 1 ? "y" : "ies"}, ${conflicts} conflict(s), ${(performance.now() - started).toFixed(1)} ms`);
		if (next === serialized) return;
		serialized = next;
		try {
			deps.changed();
		} catch (error) {
			deps.log.warn(`key hints: change notification failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	};

	const readExtensions = (): void => {
		try {
			foreign = foreignBindingsOf(deps.extensions(), deps.ownId);
		} catch (error) {
			deps.log.warn(`key hints: the installed extensions could not be read: ${error instanceof Error ? error.message : String(error)}`);
		}
	};

	const readUser = async (reason: string): Promise<void> => {
		const mine = ++fileGeneration;
		try {
			const text = await read(deps.keybindingsPath);
			if (disposed || mine !== fileGeneration) return;
			user = text === null ? [] : userBindingsOf(parseJsonc(text));
		} catch (error) {
			if (disposed || mine !== fileGeneration) return;
			deps.log.warn(`key hints: keybindings.json was not read, the previous bindings stay: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}
		recompute(reason);
	};

	const track = (work: Promise<void>): void => {
		inFlight.add(work);
		void work.finally(() => inFlight.delete(work));
	};

	const scheduleFile = (reason: string): void => {
		fileGeneration++;
		clearTimeout(fileTimer);
		fileTimer = setTimeout(() => {
			fileTimer = undefined;
			track(readUser(reason));
		}, fileDelay);
	};

	let watcher: { dispose(): void } | null = null;
	try {
		watcher = (deps.watchFolder ?? watchFolderOnDisk)(path.dirname(deps.keybindingsPath), path.basename(deps.keybindingsPath), () => scheduleFile("keybindings.json changed"));
	} catch (error) {
		deps.log.debug(`key hints: keybindings.json is not watched: ${error instanceof Error ? error.message : String(error)}`);
	}

	// The first answer is computed in the background, after the caller has returned.
	track((async () => {
		await Promise.resolve();
		readExtensions();
		await readUser("start");
	})());

	return {
		current: () => results.map(result => result.hint),
		queryOf: command => results.find(result => result.hint.command === command)?.query ?? null,
		extensionsChanged() {
			clearTimeout(extensionsTimer);
			extensionsTimer = setTimeout(() => {
				extensionsTimer = undefined;
				if (disposed) return;
				readExtensions();
				recompute("extensions changed");
			}, extensionsDelay);
		},
		async idle() {
			for (;;) {
				if (extensionsTimer === undefined && fileTimer === undefined && inFlight.size === 0) return;
				await Promise.all([...inFlight]);
				await new Promise<void>(resolve => setTimeout(resolve, Math.max(extensionsDelay, fileDelay) + 10));
			}
		},
		dispose() {
			disposed = true;
			fileGeneration++;
			clearTimeout(extensionsTimer);
			clearTimeout(fileTimer);
			watcher?.dispose();
		},
	};
}

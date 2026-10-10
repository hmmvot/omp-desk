/**
 * OMP Desk — the user's pinned workspace folders.
 *
 * This is the only authority for *which folders the launcher keeps*: an ordered,
 * versioned list of absolute paths the user pinned (an explicit Add, a Pin on a
 * folder VS Code has open, or a folder registered by an earlier build), each with a
 * stable id and the presentation-only collapsed state of its tree node. Folders VS
 * Code merely has open in a window are not here: `src/views/launcher-folders.ts`
 * merges them with this list per window and never persists them. This registry owns
 * no session identity, no claim, no host handle and no transcript: a folder is a
 * navigation grouping, and unpinning one removes nothing but this metadata.
 *
 * Two authorities are deliberately kept apart here (ADR-0020):
 *
 * - This registry decides which folders are pinned, in which order, and whether
 *   their node is collapsed. The list is profile-wide: every window of the profile
 *   shares one list through the profile catalog.
 * - `SessionIndex` decides which session tabs exist and who may write them.
 *   VS Code decides which editors are actually open. Folders never pin themselves
 *   from either source, and no folder record ever carries a session id.
 *
 * Paths are compared two different ways, and the difference matters:
 *
 * - *Adding* a folder compares filesystem identities through the claim path
 *   normalizer (`normalizeSessionIdentityKey`), so `C:\Work`, `c:/work/` and an
 *   8.3 short name fold onto one entry and a second Add selects the existing
 *   folder instead of creating a twin.
 * - *Matching a folder to a session* compares the same canonical form the index
 *   stored for a row's working directory (`normalizeWorkspaceDirectory`), which
 *   preserves an absolute root (`C:\`, `/`) instead of reducing it to a
 *   drive-relative or empty value.
 */
import { createHash } from "node:crypto";
import {
	isAbsoluteWorkspaceDirectory,
	normalizeSessionIdentityKey,
	normalizeWorkspaceDirectory,
} from "../host/session-index.ts";
import { mergeKeyedArray } from "../host/catalog-merge.ts";
import type { RecordConflictDraft } from "../host/catalog-merge.ts";

/** Catalog record key holding the profile-wide folder list. */
export const WORKSPACE_FOLDERS_STORAGE_KEY = "omp.workspaceFolders.v1";

/** Persisted snapshot schema version; a mismatch discards the snapshot. */
const FOLDERS_VERSION = 1;

/** Every folder id is minted with this prefix, so an id is never a bare path. */
const FOLDER_ID_PREFIX = "folder:";

/** The durable half of {@link vscode.Memento} this registry needs. */
export interface WorkspaceFolderStore {
	get<T>(key: string): T | undefined;
	update(key: string, value: unknown, base?: unknown): unknown;
}

/**
 * One folder the user added.
 *
 * `path` is the absolute path exactly as it was validated when added, so a drive
 * or POSIX root stays a usable root. `collapsed` is presentation state only: it
 * is what the folder's tree node is built from, and it never changes which
 * sessions a folder holds.
 */
export interface WorkspaceFolder {
	readonly id: string;
	readonly path: string;
	readonly collapsed: boolean;
}

/**
 * The id a folder has once pinned, derived from the folder's filesystem identity.
 *
 * A folder the window shows because VS Code has it open must carry the id it will
 * keep when the user pins it, so a folder-scoped command or tree row survives the
 * pin. Identity folding makes every spelling of one directory (case, separators,
 * trailing separator, 8.3 short names) the same id, in every window. Records pinned
 * by an earlier build keep the random id they were minted with.
 */
export function windowFolderId(folderPath: string): string {
	return folderIdFromKey(folderIdentityKeyOrCanonical(folderPath));
}

/** The id of the folder whose identity key is `key`; the form {@link windowFolderId} derives. */
export function folderIdFromKey(key: string): string {
	return `${FOLDER_ID_PREFIX}${createHash("sha256").update(key, "utf8").digest("hex").slice(0, 32)}`;
}

/**
 * The identity key of a path for comparing and for id derivation. A path the claim
 * normalizer cannot fold falls back to its canonical text, so it still has one key.
 */
export function folderIdentityKeyOrCanonical(folderPath: string): string {
	try {
		return folderIdentityKey(folderPath);
	} catch {
		return `raw:${normalizeWorkspaceDirectory(folderPath)}`;
	}
}

/** What inspecting one user-supplied path established. */
export type FolderPathVerdict =
	| { readonly ok: true; readonly path: string }
	| { readonly ok: false; readonly reason: string };

/**
 * The one filesystem read Add needs.
 *
 * The registry is injected with this instead of the filesystem so its ordering,
 * identity folding, persistence and ambiguity rules are testable without an
 * editor; the extension host answers it from VS Code's own file system.
 */
export interface FolderPathInspector {
	/** Turn a user-supplied path into a usable absolute folder path, or say why not. */
	inspect(rawPath: string): Promise<FolderPathVerdict>;
}

export type AddWorkspaceFolderResult =
	| { readonly ok: true; readonly folder: WorkspaceFolder; readonly created: boolean }
	| { readonly ok: false; readonly reason: string };

export type RemoveWorkspaceFolderResult =
	| { readonly removed: true; readonly folder: WorkspaceFolder }
	| { readonly removed: false; readonly reason: string };

interface PersistedFolders {
	version: number;
	folders: Array<{ id: string; path: string; collapsed: boolean }>;
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isPersistedFolders(value: unknown): value is PersistedFolders {
	if (typeof value !== "object" || value === null) return false;
	const snapshot = value as Partial<PersistedFolders>;
	if (snapshot.version !== FOLDERS_VERSION) return false;
	return Array.isArray(snapshot.folders);
}

function isPersistedFolder(value: unknown): value is { id: string; path: string; collapsed: boolean } {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Partial<PersistedFolders["folders"][number]>;
	return (
		typeof record.id === "string" &&
		record.id.startsWith(FOLDER_ID_PREFIX) &&
		typeof record.path === "string" &&
		isAbsoluteWorkspaceDirectory(record.path) &&
		typeof record.collapsed === "boolean"
	);
}

/** Which folder a folder-scoped command was invoked on. */
export type FolderArgument<T extends WorkspaceFolder = WorkspaceFolder> =
	/** A folder id that is still shown. */
	| { readonly kind: "folder"; readonly folder: T }
	/** No folder was supplied, so the caller must ask the user. */
	| { readonly kind: "absent" }
	/** A supplied id that is not registered: the caller must report and stop. */
	| { readonly kind: "stale" };

/**
 * The folder id a command was invoked with.
 *
 * A folder argument carries a stable registry id and never a path: a
 * caller-supplied path is not resolved into a folder here or anywhere else, so a
 * command cannot be pointed at a directory the user never added.
 */
export function folderIdArgument(argument: unknown): string | null {
	if (typeof argument === "string" && argument.length > 0) return argument;
	if (typeof argument !== "object" || argument === null || !("folderId" in argument)) return null;
	const folderId = argument.folderId;
	return typeof folderId === "string" && folderId.length > 0 ? folderId : null;
}

/**
 * Resolve one command's folder argument against the registered folders.
 *
 * A supplied id is resolved again here: a row that went stale, or a folder the
 * user removed while the command was on its way, reports as `stale` — which stops
 * the command rather than letting it fall back to another folder. An absent or
 * malformed argument is `absent`, which is what makes the caller ask the user.
 */
export function folderArgument<T extends WorkspaceFolder>(argument: unknown, folders: readonly T[]): FolderArgument<T> {
	const id = folderIdArgument(argument);
	if (id === null) return { kind: "absent" };
	const folder = folders.find(candidate => candidate.id === id);
	return folder === undefined ? { kind: "stale" } : { kind: "folder", folder: { ...folder } };
}

/**
 * The identity two folder paths are compared by when deciding whether an Add
 * means the folder that is already listed.
 *
 * The claim path normalizer resolves existing ancestors through the filesystem,
 * so aliases of one directory collide here — which is exactly the rule the
 * session claims use for the same path. A path it cannot fold is still usable as
 * a path; it simply cannot be compared, and `add` reports that.
 */
export function folderIdentityKey(folderPath: string): string {
	return normalizeSessionIdentityKey(folderPath);
}

/**
 * Whether a folder holds a session that recorded `cwd` as its working directory.
 *
 * Both sides are folded the same way, so a row's stored cwd and a folder path
 * that differ only in trailing separators or Windows case still match, while a
 * root (`C:\`, `/`) keeps matching itself.
 */
export function folderMatchesCwd(folderPath: string, cwd: string): boolean {
	if (typeof cwd !== "string" || cwd.trim().length === 0) return false;
	return normalizeWorkspaceDirectory(folderPath) === normalizeWorkspaceDirectory(cwd);
}

/**
 * The ordered, profile-wide folder list.
 *
 * Every mutation persists the whole snapshot through the injected store and
 * reports its own failure instead of throwing: a sidebar that cannot save the
 * presentation flag must still be usable, and the user must be able to see that
 * the change was not saved.
 */
export class WorkspaceFolderRegistry {
	readonly #store: WorkspaceFolderStore;
	readonly #inspector: FolderPathInspector;
	#folders: WorkspaceFolder[];
	#loadError: string | null = null;
	#persistError: string | null = null;
	#persistChain: Promise<void> = Promise.resolve();
	/**
	 * The list this window's folder state was derived from, named as the merge base so a
	 * folder another window added since is not read as this window's removal of it.
	 */
	#loadedBase: unknown = undefined;

	constructor(options: { readonly store: WorkspaceFolderStore; readonly inspector: FolderPathInspector }) {
		this.#store = options.store;
		this.#inspector = options.inspector;
		this.#folders = this.#load();
	}

	/** The registered folders in the order the user added them. */
	list(): readonly WorkspaceFolder[] {
		return this.#folders.map(folder => ({ ...folder }));
	}

	get(id: string): WorkspaceFolder | null {
		const found = this.#folders.find(folder => folder.id === id);
		return found === undefined ? null : { ...found };
	}

	/** Set when the persisted list could not be read back as this registry's state. */
	get loadError(): string | null {
		return this.#loadError;
	}

	/** Set when the last attempt to persist the list failed. */
	get persistError(): string | null {
		return this.#persistError;
	}

	/** The folder a session's working directory belongs to, if one is registered. */
	folderForCwd(cwd: string): WorkspaceFolder | null {
		const found = this.#folders.find(folder => folderMatchesCwd(folder.path, cwd));
		return found === undefined ? null : { ...found };
	}

	/** Whether this exact folder is already registered, by filesystem identity. */
	hasPath(folderPath: string): boolean {
		const key = this.#keyOf(folderPath);
		return key !== null && this.#folders.some(folder => this.#keyOf(folder.path) === key);
	}

	/**
	 * Add one user-chosen folder.
	 *
	 * A relative path, a path that is not an existing directory, and a path whose
	 * identity cannot be folded are each refused with their own reason. An
	 * equivalent Add — the same directory through another alias — selects the
	 * folder that is already listed and reports `created: false`, so the list
	 * never holds the same directory twice.
	 */
	async add(rawPath: string, options: { readonly collapsed?: boolean } = {}): Promise<AddWorkspaceFolderResult> {
		const trimmed = rawPath.trim();
		if (trimmed.length === 0) return { ok: false, reason: "No folder path was given." };
		if (!isAbsoluteWorkspaceDirectory(trimmed)) {
			return { ok: false, reason: `"${trimmed}" is not an absolute folder path. Add the absolute path of a local folder.` };
		}
		return await this.#register(trimmed, options.collapsed === true);
	}

	/**
	 * Register a folder this extension verified itself.
	 *
	 * This is the post-switch path (ADR-0025): after a native conversation switch
	 * to a target whose own header supplied an existing usable absolute working
	 * directory, that directory is added to **this launcher's** list — never to
	 * VS Code's workspace roots, and never before the switch is verified. It has
	 * the same identity folding, duplicate selection and persistence rules as
	 * {@link WorkspaceFolderRegistry.add}, so an
	 * alias of an already listed folder selects it instead of creating a twin; a
	 * persistence failure is reported through {@link WorkspaceFolderRegistry.persistError}
	 * rather than thrown, so the caller can hold the binding in a visible degraded
	 * state and retry.
	 */
	async registerValidated(folderPath: string): Promise<AddWorkspaceFolderResult> {
		const trimmed = folderPath.trim();
		if (trimmed.length === 0) {
			return { ok: false, reason: "The native session recorded no usable working directory to register." };
		}
		if (!isAbsoluteWorkspaceDirectory(trimmed)) {
			return {
				ok: false,
				reason: `The native session's recorded working directory "${trimmed}" is not an absolute folder path.`,
			};
		}
		return await this.#register(trimmed, false);
	}

	/** The one implementation both entry points share. */
	async #register(candidate: string, collapsed: boolean): Promise<AddWorkspaceFolderResult> {
		const verdict = await this.#inspector.inspect(candidate);
		if (!verdict.ok) return { ok: false, reason: verdict.reason };
		let key: string;
		try {
			key = folderIdentityKey(verdict.path);
		} catch (error) {
			return { ok: false, reason: `"${verdict.path}" could not be compared with the folders already listed: ${describeError(error)}` };
		}
		for (const existing of this.#folders) {
			if (this.#keyOf(existing.path) === key) return { ok: true, folder: { ...existing }, created: false };
		}
		const folder: WorkspaceFolder = { id: windowFolderId(verdict.path), path: verdict.path, collapsed };
		this.#folders = [...this.#folders, folder];
		await this.#persist();
		return { ok: true, folder: { ...folder }, created: true };
	}

	/**
	 * Remove one folder from the list.
	 *
	 * This is metadata only: no editor is closed, no host stopped, no session
	 * forgotten and no file removed, and a running session never refuses it. A
	 * malformed or stale id is reported instead of falling back to another folder.
	 */
	async remove(id: string): Promise<RemoveWorkspaceFolderResult> {
		const index = this.#folders.findIndex(folder => folder.id === id);
		if (index < 0) {
			return { removed: false, reason: "That folder is no longer in the OMP launcher." };
		}
		const folder = this.#folders[index];
		this.#folders = [...this.#folders.slice(0, index), ...this.#folders.slice(index + 1)];
		await this.#persist();
		return { removed: true, folder: { ...folder } };
	}

	/**
	 * Record whether the user collapsed this folder's tree node.
	 *
	 * Presentation only. The saved value is what the folder's node is built from,
	 * so a refresh cannot silently expand a folder the user collapsed.
	 */
	async setCollapsed(id: string, collapsed: boolean): Promise<boolean> {
		const index = this.#folders.findIndex(folder => folder.id === id);
		if (index < 0) return false;
		if (this.#folders[index].collapsed === collapsed) return true;
		this.#folders = this.#folders.map((folder, at) => (at === index ? { ...folder, collapsed } : folder));
		await this.#persist();
		return true;
	}

	/**
	 * Adopt the committed list as the newest catalog revision holds it.
	 *
	 * Called when another window commits to the shared catalog. It returns whether
	 * this window's list changed, so the caller refreshes only what changed. A change
	 * this window could not save is not resurrected here: the committed list is the
	 * durable one, and the failure is still reported through
	 * {@link WorkspaceFolderRegistry.persistError}.
	 */
	async reload(): Promise<boolean> {
		let changed = false;
		this.#persistChain = this.#persistChain.then(() => {
			const folders = this.#load();
			if (JSON.stringify(folders) === JSON.stringify(this.#folders)) return;
			this.#folders = folders;
			changed = true;
		});
		await this.#persistChain;
		return changed;
	}

	#keyOf(folderPath: string): string | null {
		try {
			return folderIdentityKey(folderPath);
		} catch {
			return null;
		}
	}

	#load(): WorkspaceFolder[] {
		let raw: unknown;
		try {
			raw = this.#store.get<unknown>(WORKSPACE_FOLDERS_STORAGE_KEY);
		} catch (error) {
			this.#loadError = `The registered OMP folders could not be read: ${describeError(error)}`;
			return [];
		}
		this.#loadedBase = raw;
		const read = readFolderRecords(raw);
		if (!read.readable) {
			this.#loadError =
				"The persisted OMP folder list did not match the schema of this version and was discarded; no folder, session or file was touched.";
			return [];
		}
		if (read.duplicates > 0) {
			this.#loadError = `${read.duplicates} stored OMP folder record(s) were invalid or duplicated and were dropped; no folder, session or file was touched.`;
		}
		return read.folders;
	}

	async #persist(): Promise<void> {
		const snapshot: PersistedFolders = {
			version: FOLDERS_VERSION,
			folders: this.#folders.map(folder => ({ id: folder.id, path: folder.path, collapsed: folder.collapsed })),
		};
		this.#persistChain = this.#persistChain.then(async () => {
			try {
				await Promise.resolve(this.#store.update(WORKSPACE_FOLDERS_STORAGE_KEY, snapshot, this.#loadedBase));
				this.#loadedBase = snapshot;
				this.#persistError = null;
			} catch (error) {
				this.#persistError = `The OMP folder list could not be saved: ${describeError(error)}`;
			}
		});
		await this.#persistChain;
	}
}

/**
 * The readable folder records of one value, deduplicated by identity and path.
 *
 * `duplicates` counts records this read had to drop, so a caller can report that
 * the stored list and the loaded one differ instead of silently shortening it.
 */
function readFolderRecords(
	value: unknown,
	options: { readonly dedupeByPath?: boolean } = {},
): { readonly folders: WorkspaceFolder[]; readonly readable: boolean; readonly duplicates: number } {
	const dedupeByPath = options.dedupeByPath !== false;
	if (value === undefined || value === null) return { folders: [], readable: true, duplicates: 0 };
	if (!isPersistedFolders(value)) return { folders: [], readable: false, duplicates: 0 };
	const folders: WorkspaceFolder[] = [];
	const ids = new Set<string>();
	const keys = new Set<string>();
	let duplicates = 0;
	for (const record of value.folders) {
		if (!isPersistedFolder(record) || ids.has(record.id)) {
			duplicates++;
			continue;
		}
		// Two records naming the same directory are one folder: the first wins, so the
		// user's own order decides which entry is the folder.
		let key: string | null = null;
		try {
			key = folderIdentityKey(record.path);
		} catch {
			key = null;
		}
		if (dedupeByPath && key !== null && keys.has(key)) {
			duplicates++;
			continue;
		}
		ids.add(record.id);
		if (key !== null) keys.add(key);
		folders.push({ id: record.id, path: record.path, collapsed: record.collapsed });
	}
	return { folders, readable: true, duplicates };
}

/**
 * Merge this window's folder list into the newest committed one.
 *
 * The list is one record keyed by folder id, so a folder one window added or
 * removed is that window's decision while a folder it never touched follows the
 * committed list — two windows adding two folders both keep theirs, and a folder
 * removed in one window is not re-added by another window's stale copy. The
 * collapse flag is durable presentation state and merges with its folder: the
 * list is shared by every window of the profile, so a folder collapsed in one
 * window is collapsed in the others.
 */
export function mergeWorkspaceFolderRecords(input: {
	readonly base: unknown;
	readonly desired: unknown;
	readonly latest: unknown;
}): { readonly value: unknown; readonly conflicts: readonly RecordConflictDraft[] } {
	const desired = readFolderRecords(input.desired, { dedupeByPath: false });
	if (!desired.readable) return { value: input.latest, conflicts: [] };
	const latest = readFolderRecords(input.latest, { dedupeByPath: false });
	if (!latest.readable) return { value: input.desired, conflicts: [] };
	// Read every record, including two ids for one directory: which of them owns that
	// directory is a decision for the merge below, where the committed owner is known.
	const base = readFolderRecords(input.base, { dedupeByPath: false });
	const conflicts: RecordConflictDraft[] = [];
	const merged = mergeKeyedArray({
		base: base.folders,
		desired: desired.folders,
		latest: latest.folders,
		key: folder => folder.id,
		label: "registered OMP folder",
		conflicts,
	});
	// Earlier builds minted random ids per window, so two windows adding the same directory
	// independently produced two ids for one path (current builds derive one id from the path
	// identity, so this now mainly concerns those older records). The merged result is therefore de-duplicated by
	// *filesystem identity*: the first (established) entry keeps the folder and the
	// duplicate is reported, because two navigation entries for one directory is a state
	// the loader would silently shorten on the next read.
	const byPath = new Map<string, WorkspaceFolder>();
	const folders: WorkspaceFolder[] = [];
	// An established (already committed) entry is the owner of its directory: a contender that
	// independently minted another id for the same path must not replace its identity, order or
	// collapse state, because id-targeted commands would go stale. Committed owners are therefore
	// visited first.
	const committed = new Set(latest.folders.map(folder => folder.id));
	const ordered = [
		...merged.filter(folder => committed.has(folder.id)),
		...merged.filter(folder => !committed.has(folder.id)),
	];
	for (const folder of ordered) {
		let key: string | null = null;
		try {
			key = folderIdentityKey(folder.path);
		} catch {
			key = null;
		}
		const owner = key === null ? undefined : byPath.get(key);
		if (owner !== undefined) {
			conflicts.push({
				identity: folder.id,
				reason: `another window registered ${folder.path} under a different id; the folder already listed was kept`,
				retained: owner,
				rejected: folder,
			});
			continue;
		}
		if (key !== null) byPath.set(key, folder);
		folders.push(folder);
	}
	return {
		value: { version: FOLDERS_VERSION, folders },
		conflicts,
	};
}

/**
 * Merge one import source's folder list into the shared one, additively.
 *
 * A folder the shared list does not hold is appended in the source's own order; a
 * folder it already holds keeps its shared record. Two records for one directory —
 * the same id with a different path, or a different id for the same directory — are
 * reported and the shared record is kept, because two navigation entries for one
 * directory is a duplicate the user did not create.
 */
export function unionWorkspaceFolderRecords(input: {
	readonly existing: unknown;
	readonly incoming: unknown;
	readonly source: string;
	readonly at: string;
}): {
	readonly value: unknown;
	readonly conflicts: readonly RecordConflictDraft[];
	readonly added: number;
	readonly quarantined: readonly string[];
} {
	const incoming = readFolderRecords(input.incoming);
	const existing = readFolderRecords(input.existing);
	if (!incoming.readable) {
		return {
			value: input.existing,
			conflicts: [],
			added: 0,
			quarantined: ["the registered OMP folder list did not match the schema of this version"],
		};
	}
	const conflicts: RecordConflictDraft[] = [];
	const kept = [...existing.folders];
	const byId = new Map(kept.map(folder => [folder.id, folder]));
	const idByKey = new Map<string, string>();
	for (const folder of kept) {
		try {
			idByKey.set(folderIdentityKey(folder.path), folder.id);
		} catch {
			/* a path that cannot be folded cannot be compared; it is still usable */
		}
	}
	let added = 0;
	for (const folder of incoming.folders) {
		const mine = byId.get(folder.id);
		if (mine !== undefined) {
			if (mine.path !== folder.path) {
				conflicts.push({
					identity: folder.id,
					reason: `another stored source (${input.source}) uses this folder id for a different directory; the folder already listed was kept`,
					retained: mine,
					rejected: folder,
				});
			}
			continue;
		}
		let key: string | null = null;
		try {
			key = folderIdentityKey(folder.path);
		} catch {
			key = null;
		}
		const owner = key === null ? undefined : idByKey.get(key);
		if (owner !== undefined) {
			conflicts.push({
				identity: folder.id,
				reason: `another stored source (${input.source}) lists this directory under another id; the folder already listed was kept`,
				retained: byId.get(owner) ?? null,
				rejected: folder,
			});
			continue;
		}
		kept.push({ ...folder });
		byId.set(folder.id, folder);
		if (key !== null) idByKey.set(key, folder.id);
		added++;
	}
	return { value: { version: FOLDERS_VERSION, folders: kept }, conflicts, added, quarantined: [] };
}

/**
 * OMP Desk — the folders the Sessions view shows in this window.
 *
 * The displayed list is a per-window union of three sources, deduplicated by
 * filesystem identity (`folderIdentityKey`) so one directory appears once whatever
 * its spelling:
 *
 * 1. the folders VS Code has open in this window (the single folder, or every root
 *    of a multi-root workspace; local `file` roots only), in VS Code's order and
 *    only while `omp.showWorkspaceFolders` is on;
 * 2. the profile-wide **pinned** folders (`WorkspaceFolderRegistry`), in their
 *    stored order; a pinned folder that is also open keeps its place among the open
 *    ones and says it is pinned;
 * 3. folders that are neither pinned nor open but hold a session this window runs,
 *    so a live row never disappears with its workspace folder.
 *
 * Only pinned folders are durable and shared. Open and live-only folders are derived
 * from this window every time and never persisted; the one thing kept for them is
 * the collapsed state of their node, in this window's own store. This module owns no
 * session identity, claim or host handle; it reads only what it is handed, plus the
 * filesystem to resolve a path's identity (remembered per path, see `forgetIdentities`).
 *
 * Ids stay stable across pinning: an unpinned folder's id is `windowFolderId(path)`,
 * and Pin registers the folder under exactly that id, so a folder-scoped command or
 * tree row that named the folder before it was pinned still resolves after.
 */
import { folderIdFromKey, folderIdentityKeyOrCanonical, folderMatchesCwd } from "./workspace-folders.ts";
import type {
	RemoveWorkspaceFolderOptions,
	WorkspaceFolder,
	WorkspaceFolderRegistry,
	WorkspaceFolderStore,
} from "./workspace-folders.ts";
import { normalizeWorkspaceDirectory } from "../host/session-index.ts";

/** Window-scoped key holding the ids of unpinned folders whose node the user collapsed. */
export const WINDOW_FOLDER_COLLAPSED_KEY = "omp.windowFolderCollapsed.v1";

/** One folder as the Sessions view shows it. */
export interface LauncherFolder extends WorkspaceFolder {
	/** Kept in the profile-wide pinned list: it survives this window and shows in every window. */
	readonly pinned: boolean;
	/** VS Code has this folder open in this window. */
	readonly open: boolean;
}

export type PinFolderResult =
	| { readonly ok: true; readonly folder: LauncherFolder; readonly created: boolean }
	| { readonly ok: false; readonly reason: string };

export type UnpinFolderResult =
	| { readonly unpinned: true; readonly folder: LauncherFolder; readonly stillShown: boolean }
	| { readonly unpinned: false; readonly reason: string };

/** The part of the pinned registry this module drives. */
export type PinnedFolders = Pick<
	WorkspaceFolderRegistry,
	"list" | "add" | "remove" | "setCollapsed" | "reload" | "loadError" | "persistError"
>;

export interface LauncherFoldersOptions {
	readonly pinned: PinnedFolders;
	/** This window's own store (workspace state): the collapsed state of unpinned folders. */
	readonly local: WorkspaceFolderStore;
	/** Absolute local paths of the folders VS Code has open, in VS Code's order. */
	readonly windowPaths: () => readonly string[];
	/** The `omp.showWorkspaceFolders` setting. */
	readonly showWindowFolders: () => boolean;
	/** Working directories of the sessions that run in this window. */
	readonly liveSessionCwds: () => readonly string[];
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** What one path is compared and named by, resolved through the filesystem once and then remembered. */
interface PathIdentity {
	readonly key: string;
	readonly id: string;
}

/** More remembered paths than any window plausibly shows; beyond it the memory is simply rebuilt. */
const IDENTITY_MEMORY_LIMIT = 256;

export class LauncherFolders {
	readonly #pinned: PinnedFolders;
	readonly #local: WorkspaceFolderStore;
	readonly #windowPaths: () => readonly string[];
	readonly #showWindowFolders: () => boolean;
	readonly #liveSessionCwds: () => readonly string[];
	readonly #identities = new Map<string, PathIdentity>();
	#localPersistError: string | null = null;

	constructor(options: LauncherFoldersOptions) {
		this.#pinned = options.pinned;
		this.#local = options.local;
		this.#windowPaths = options.windowPaths;
		this.#showWindowFolders = options.showWindowFolders;
		this.#liveSessionCwds = options.liveSessionCwds;
	}

	/**
	 * Forget what remembered paths resolved to.
	 *
	 * Resolving a path folds it through the filesystem (junctions, 8.3 names, drive
	 * aliases), which is too slow to repeat on every refresh, so each path is resolved
	 * once. Anything that can change the answer clears the memory: the open folders
	 * changing, the pinned list being re-read, and an explicit refresh.
	 */
	forgetIdentities(): void {
		this.#identities.clear();
	}

	#identityOf(folderPath: string): PathIdentity {
		let identity = this.#identities.get(folderPath);
		if (identity === undefined) {
			if (this.#identities.size >= IDENTITY_MEMORY_LIMIT) this.#identities.clear();
			const key = folderIdentityKeyOrCanonical(folderPath);
			identity = { key, id: folderIdFromKey(key) };
			this.#identities.set(folderPath, identity);
		}
		return identity;
	}

	/**
	 * The folders to show: open folders in VS Code's order, then the other pinned
	 * folders in their stored order, then folders kept visible only by a live session.
	 * Every id in the list is unique.
	 */
	list(): readonly LauncherFolder[] {
		const pinned = this.#pinned.list();
		const pinnedKeys = pinned.map(folder => this.#identityOf(folder.path).key);
		const collapsedIds = this.#collapsedIds();
		const openKeys = new Set<string>();
		const windowEntries: Array<{ readonly identity: PathIdentity; readonly path: string }> = [];
		for (const windowPath of this.#windowPaths()) {
			const identity = this.#identityOf(windowPath);
			if (openKeys.has(identity.key)) continue;
			openKeys.add(identity.key);
			windowEntries.push({ identity, path: windowPath });
		}
		const shown: LauncherFolder[] = [];
		const consumed = new Set<number>();
		if (this.#showWindowFolders()) {
			for (const entry of windowEntries) {
				const at = pinnedKeys.indexOf(entry.identity.key);
				if (at >= 0) {
					consumed.add(at);
					shown.push({ ...pinned[at]!, pinned: true, open: true });
					continue;
				}
				const id = entry.identity.id;
				shown.push({ id, path: entry.path, collapsed: collapsedIds.has(id), pinned: false, open: true });
			}
		}
		pinned.forEach((folder, at) => {
			if (consumed.has(at)) return;
			shown.push({ ...folder, pinned: true, open: openKeys.has(pinnedKeys[at]!) });
		});
		const usedIds = new Set(shown.map(folder => folder.id));
		for (const cwd of this.#liveSessionCwds()) {
			if (typeof cwd !== "string" || cwd.trim().length === 0) continue;
			if (shown.some(folder => folderMatchesCwd(folder.path, cwd))) continue;
			// Rows are filed under the folder their working directory spells, so a session whose cwd
			// is another spelling of a shown directory still needs its own heading: it gets an id
			// from that spelling instead of repeating the shown folder's.
			let id = this.#identityOf(cwd).id;
			if (usedIds.has(id)) id = folderIdFromKey(`spelling:${normalizeWorkspaceDirectory(cwd)}`);
			usedIds.add(id);
			shown.push({ id, path: cwd, collapsed: collapsedIds.has(id), pinned: false, open: false });
		}
		return shown;
	}

	get(id: string): LauncherFolder | null {
		return this.list().find(folder => folder.id === id) ?? null;
	}

	/** The shown folder a session's working directory belongs to, if any. */
	folderForCwd(cwd: string): LauncherFolder | null {
		return this.list().find(folder => folderMatchesCwd(folder.path, cwd)) ?? null;
	}

	/** Set when the persisted pinned list could not be read back as this version's state. */
	get loadError(): string | null {
		return this.#pinned.loadError;
	}

	/** Set when the last attempt to save a pin, an unpin or a collapsed state failed. */
	get persistError(): string | null {
		return this.#pinned.persistError ?? this.#localPersistError;
	}

	/** Adopt the pinned list another window committed; whether this window's list changed. */
	async reload(): Promise<boolean> {
		this.forgetIdentities();
		return await this.#pinned.reload();
	}

	/**
	 * Pin a folder by path: the explicit Add flow, and a folder a new session was
	 * started in. A folder that is already pinned is selected, never duplicated; an
	 * open or live-only one keeps its id and collapsed state.
	 */
	async add(rawPath: string): Promise<PinFolderResult> {
		const key = this.#identityOf(rawPath.trim()).key;
		const shown = this.list().find(folder => this.#identityOf(folder.path).key === key) ?? null;
		if (shown?.pinned === true) return { ok: true, folder: shown, created: false };
		const added = await this.#pinned.add(rawPath, { collapsed: shown?.collapsed === true });
		if (!added.ok) return added;
		if (added.created) await this.#writeCollapsed(added.folder.id, false);
		return { ok: true, folder: this.get(added.folder.id) ?? { ...added.folder, pinned: true, open: false }, created: added.created };
	}

	/** Pin a folder the view shows. The pinned record carries the folder's own id and collapsed state. */
	async pin(id: string): Promise<PinFolderResult> {
		const folder = this.get(id);
		if (folder === null) return { ok: false, reason: "That folder is no longer in the OMP launcher." };
		if (folder.pinned) return { ok: true, folder, created: false };
		const added = await this.#pinned.add(folder.path, { collapsed: folder.collapsed });
		if (!added.ok) return { ok: false, reason: added.reason };
		if (added.created) await this.#writeCollapsed(folder.id, false);
		const pinned = this.get(added.folder.id) ?? { ...added.folder, pinned: true, open: folder.open };
		return { ok: true, folder: pinned, created: added.created };
	}

	/**
	 * Unpin a pinned folder: it leaves the profile-wide list and so every window's
	 * list. It stays visible in a window that has it open, or while that window runs a
	 * session in it, under the id it would have had unpinned. Metadata only; refused
	 * while a managed OMP session of that folder runs, exactly as a removal always was.
	 */
	async unpin(id: string, options: RemoveWorkspaceFolderOptions = {}): Promise<UnpinFolderResult> {
		const folder = this.get(id);
		if (folder === null || !folder.pinned) {
			return { unpinned: false, reason: "That folder is no longer pinned in the OMP launcher." };
		}
		const removed = await this.#pinned.remove(id, options);
		if (!removed.removed) return { unpinned: false, reason: removed.reason };
		const nextId = this.#identityOf(folder.path).id;
		if (folder.collapsed) await this.#writeCollapsed(nextId, true);
		return { unpinned: true, folder, stillShown: this.get(nextId) !== null };
	}

	/** Record whether the user collapsed this folder's node: durably for a pinned folder, per window otherwise. */
	async setCollapsed(id: string, collapsed: boolean): Promise<boolean> {
		const folder = this.get(id);
		if (folder === null) return false;
		if (folder.pinned) return await this.#pinned.setCollapsed(id, collapsed);
		if (folder.collapsed === collapsed) return true;
		await this.#writeCollapsed(id, collapsed);
		return true;
	}

	#collapsedIds(): ReadonlySet<string> {
		let raw: unknown;
		try {
			raw = this.#local.get<unknown>(WINDOW_FOLDER_COLLAPSED_KEY);
		} catch {
			return new Set();
		}
		if (typeof raw !== "object" || raw === null || !("collapsed" in raw) || !Array.isArray(raw.collapsed)) return new Set();
		return new Set(raw.collapsed.filter((value): value is string => typeof value === "string"));
	}

	async #writeCollapsed(id: string, collapsed: boolean): Promise<void> {
		const ids = new Set(this.#collapsedIds());
		if (ids.has(id) === collapsed) return;
		if (collapsed) ids.add(id);
		else ids.delete(id);
		try {
			await Promise.resolve(this.#local.update(WINDOW_FOLDER_COLLAPSED_KEY, { version: 1, collapsed: [...ids] }));
			this.#localPersistError = null;
		} catch (error) {
			this.#localPersistError = `The collapsed state of an OMP folder could not be saved: ${describeError(error)}`;
		}
	}
}

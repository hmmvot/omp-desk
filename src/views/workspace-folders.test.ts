/**
 * Tests for the user's explicit OMP folder list.
 *
 * What is worth defending here: that the list is only ever what the user added
 * (order, stable ids, nothing inferred), that an equivalent Add selects the
 * folder that is already listed instead of creating a twin, that a relative or
 * non-directory path is refused with a reason, that a folder's collapse flag is
 * presentation state that survives a reload, that a session's working directory
 * matches only its own folder, and that neither a corrupt snapshot nor a failed
 * save can silently lose or fabricate a folder.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import {
	WORKSPACE_FOLDERS_STORAGE_KEY,
	WorkspaceFolderRegistry,
	folderArgument,
	folderMatchesCwd,
	mergeWorkspaceFolderRecords,
	windowFolderId,
} from "./workspace-folders.ts";
import type { FolderPathInspector, FolderPathVerdict, WorkspaceFolderStore } from "./workspace-folders.ts";
import { normalizeSessionIdentityKey, normalizeWorkspaceDirectory } from "../host/session-index.ts";

/** A memento stub: one in-memory value per key, with a switch to make writes fail. */
function memoryStore(): WorkspaceFolderStore & { readonly raw: () => unknown; failWrites: boolean } {
	let value: unknown;
	return {
		get<T>(key: string): T | undefined {
			return key === WORKSPACE_FOLDERS_STORAGE_KEY ? (value as T | undefined) : undefined;
		},
		update(key: string, next: unknown): unknown {
			if (key === WORKSPACE_FOLDERS_STORAGE_KEY) {
				if (this.failWrites) throw new Error("disk is full");
				value = next;
			}
			return undefined;
		},
		raw: () => value,
		failWrites: false,
	};
}

/** An inspector that accepts exactly the directories a test declares. */
function stubInspector(verdict: (rawPath: string) => FolderPathVerdict, calls?: string[]): FolderPathInspector {
	return {
		async inspect(rawPath: string): Promise<FolderPathVerdict> {
			calls?.push(rawPath);
			return verdict(rawPath);
		},
	};
}

describe("workspace folder registry", () => {
	let temp: string;
	let first: string;
	let second: string;

	before(async () => {
		temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-workspace-folders-"));
		first = path.join(temp, "project-a");
		second = path.join(temp, "project-b");
		await fs.promises.mkdir(first);
		await fs.promises.mkdir(second);
		// A child and a sibling, to show a folder match is not a prefix match.
		await fs.promises.mkdir(path.join(first, "nested"));
	});

	after(async () => {
		await fs.promises.rm(temp, { recursive: true, force: true });
	});

	function registry(store: WorkspaceFolderStore, calls?: string[]): WorkspaceFolderRegistry {
		// The real inspector answers from VS Code's own file system, which accepts
		// any spelling of a real directory; the stub accepts the same aliases by
		// comparing filesystem identities the way the registry itself does.
		const known = new Set([normalizeSessionIdentityKey(first), normalizeSessionIdentityKey(second)]);
		return new WorkspaceFolderRegistry({
			store,
			inspector: stubInspector(raw => {
				try {
					if (known.has(normalizeSessionIdentityKey(raw))) return { ok: true, path: raw };
				} catch {
					// An unfoldable path is simply not a directory this stub knows.
				}
				return { ok: false, reason: `${raw} is not a directory.` };
			}, calls),
		});
	}

	it("keeps the order the user added folders in, with stable ids", async () => {
		const store = memoryStore();
		const folders = registry(store);
		const addedFirst = await folders.add(first);
		const addedSecond = await folders.add(second);
		assert.equal(addedFirst.ok, true);
		assert.equal(addedSecond.ok, true);
		assert.deepEqual(
			folders.list().map(folder => folder.path),
			[first, second],
		);
		assert.match(folders.list()[0]!.id, /^folder:/);
		// A reload through the same memento keeps both, in order, with the same ids.
		const reloaded = registry(store);
		assert.deepEqual(reloaded.list(), folders.list());
	});

	it("selects the existing folder when an equivalent path is added again", async () => {
		const store = memoryStore();
		const folders = registry(store);
		const added = await folders.add(first);
		assert.equal(added.ok, true);
		// Two aliases of one directory: a trailing separator and a `sub/..` detour.
		await fs.promises.mkdir(path.join(temp, "detour"), { recursive: true });
		for (const alias of [first + path.sep, path.join(temp, "detour", "..", "project-a")]) {
			const again = await folders.add(alias);
			assert.equal(again.ok, true);
			assert.equal(again.ok && again.created, false);
			assert.equal(again.ok && again.folder.id, added.ok ? added.folder.id : "");
			assert.equal(folders.list().length, 1);
		}
		assert.equal(folders.hasPath(first + path.sep), true);
	});

	it("refuses a relative path, an empty path and a path that is not a directory", async () => {
		const calls: string[] = [];
		const folders = registry(memoryStore(), calls);
		const relative = await folders.add(path.join("relative", "folder"));
		assert.equal(relative.ok, false);
		assert.match(relative.ok ? "" : relative.reason, /absolute folder path/);
		const empty = await folders.add("   ");
		assert.equal(empty.ok, false);
		// Neither refusal reached the filesystem.
		assert.deepEqual(calls, []);
		const missing = await folders.add(path.join(temp, "does-not-exist"));
		assert.equal(missing.ok, false);
		assert.match(missing.ok ? "" : missing.reason, /not a directory/);
		assert.deepEqual(folders.list(), []);
	});

	it("resolves a folder argument by registry id, and never by path", async () => {
		const store = memoryStore();
		const folders = registry(store);
		const firstAdded = await folders.add(first);
		const secondAdded = await folders.add(second);
		const firstId = firstAdded.ok ? firstAdded.folder.id : "";
		const list = folders.list();
		const secondId = secondAdded.ok ? secondAdded.folder.id : "";

		// A folder row passes its id.
		const fromRow = folderArgument({ folderId: firstId }, list);
		assert.equal(fromRow.kind, "folder");
		assert.equal(fromRow.kind === "folder" ? fromRow.folder.id : "", firstId);
		assert.equal(folderArgument(firstId, list).kind, "folder");

		// A supplied id that is no longer registered stops the command: it must not
		// fall back to another folder, and a path is never treated as an id.
		assert.equal(folderArgument({ folderId: "folder:gone" }, list).kind, "stale");
		assert.equal(folderArgument(first, list).kind, "stale");
		assert.equal(folderArgument({ folderId: 7 }, list).kind, "absent");

		// An absent or malformed argument is what makes the caller ask the user.
		assert.equal(folderArgument(undefined, list).kind, "absent");
		assert.equal(folderArgument("", list).kind, "absent");
		assert.equal(folderArgument({}, list).kind, "absent");
		assert.equal(folderArgument({ folderId: "" }, list).kind, "absent");

		// After a removal the same argument reports stale, and the other folder is
		// still resolvable — neither becomes the other.
		await folders.remove(secondId);
		const afterRemoval = folders.list();
		assert.equal(folderArgument({ folderId: secondId }, afterRemoval).kind, "stale");
		assert.equal(folderArgument({ folderId: firstId }, afterRemoval).kind, "folder");
	});

	it("holds a folder's collapse state across a reload and keeps it presentation-only", async () => {
		const store = memoryStore();
		const folders = registry(store);
		const added = await folders.add(first);
		assert.equal(added.ok, true);
		const id = added.ok ? added.folder.id : "";
		assert.equal(await folders.setCollapsed(id, true), true);
		assert.equal(folders.get(id)?.collapsed, true);
		const reloaded = registry(store);
		assert.equal(reloaded.get(id)?.collapsed, true);
		assert.equal(reloaded.folderForCwd(first)?.collapsed, true);
		assert.equal(await reloaded.setCollapsed("folder:unknown", true), false);
		assert.equal(await reloaded.setCollapsed(id, false), true);
		assert.equal(registry(store).get(id)?.collapsed, false);
	});

	it("removes one folder by id and reports a stale id instead of falling back", async () => {
		const store = memoryStore();
		const folders = registry(store);
		const firstAdded = await folders.add(first);
		const secondAdded = await folders.add(second);
		const firstId = firstAdded.ok ? firstAdded.folder.id : "";
		const removed = await folders.remove(firstId);
		assert.equal(removed.removed, true);
		assert.deepEqual(
			folders.list().map(folder => folder.id),
			[secondAdded.ok ? secondAdded.folder.id : ""],
		);
		const stale = await folders.remove(firstId);
		assert.equal(stale.removed, false);
		assert.match(stale.removed ? "" : stale.reason, /no longer in the OMP launcher/);
	});

	it("matches a session folder only on exact canonical equality", async () => {
		const folders = registry(memoryStore());
		await folders.add(first);
		assert.equal(folders.folderForCwd(first)?.path, first);
		// The same directory through another spelling, and the separators a row may
		// have been stored with.
		assert.equal(folders.folderForCwd(first + path.sep)?.path, first);
		assert.equal(folders.folderForCwd(normalizeWorkspaceDirectory(first))?.path, first);
		// A child, a sibling and an empty value are not the folder.
		assert.equal(folders.folderForCwd(path.join(first, "nested")), null);
		assert.equal(folders.folderForCwd(second), null);
		assert.equal(folders.folderForCwd(""), null);
		assert.equal(folderMatchesCwd(first, path.join(temp, "other")), false);
		assert.equal(folderMatchesCwd(first, `${first}${path.sep}`), true);
	});

	it("keeps a drive or POSIX root a usable folder root", async () => {
		// The root of the temp volume: `C:\` on Windows, `/` on POSIX. It must stay a
		// non-empty root after normalization, and it must match itself.
		const root = path.parse(temp).root;
		assert.notEqual(normalizeWorkspaceDirectory(root).length, 0);
		const store = memoryStore();
		const folders = new WorkspaceFolderRegistry({
			store,
			inspector: stubInspector(raw => (raw === root ? { ok: true, path: root } : { ok: false, reason: "not a directory" })),
		});
		const added = await folders.add(root);
		assert.equal(added.ok, true);
		assert.equal(folders.folderForCwd(root)?.path, root);
		assert.equal(registry(store).list().length, 1);
	});

	it("discards a snapshot of another schema and keeps a usable empty list", async () => {
		const store = memoryStore();
		await store.update(WORKSPACE_FOLDERS_STORAGE_KEY, { version: 99, folders: [{ id: "folder:x", path: first, collapsed: false }] });
		const folders = registry(store);
		assert.deepEqual(folders.list(), []);
		assert.match(folders.loadError ?? "", /did not match the schema/);
		// The registry still works after discarding: the user can add again.
		assert.equal((await folders.add(first)).ok, true);
		assert.equal(registry(store).list().length, 1);
	});

	it("drops only the invalid and duplicated records of a partially broken snapshot", async () => {
		const store = memoryStore();
		await store.update(WORKSPACE_FOLDERS_STORAGE_KEY, {
			version: 1,
			folders: [
				{ id: "folder:keep", path: first, collapsed: true },
				{ id: "not-a-folder-id", path: second, collapsed: false },
				{ id: "folder:relative", path: path.join("relative", "folder"), collapsed: false },
				{ id: "folder:dup-of-first", path: first + path.sep, collapsed: false },
				{ id: "folder:second", path: second, collapsed: false },
			],
		});
		const folders = registry(store);
		assert.deepEqual(
			folders.list().map(folder => folder.id),
			["folder:keep", "folder:second"],
		);
		// The presentation flag of a surviving record is kept as stored.
		assert.equal(folders.get("folder:keep")?.collapsed, true);
		assert.match(folders.loadError ?? "", /invalid or duplicated/);
	});

	it("reports a failed save without dropping the change the user just made", async () => {
		const store = memoryStore();
		const folders = registry(store);
		store.failWrites = true;
		const added = await folders.add(first);
		assert.equal(added.ok, true);
		assert.equal(folders.list().length, 1);
		assert.match(folders.persistError ?? "", /could not be saved/);
		// A later successful save clears the reported failure.
		store.failWrites = false;
		assert.equal(await folders.setCollapsed(added.ok ? added.folder.id : "", true), true);
		assert.equal(folders.persistError, null);
		assert.equal(registry(store).list().length, 1);
	});

	it("registers a verified native conversation's own folder, deduplicated by alias", async () => {
		const store = memoryStore();
		let inspected: string[] = [];
		const folders = new WorkspaceFolderRegistry({
			store,
			inspector: stubInspector(raw => (raw === first ? { ok: true, path: first } : { ok: false, reason: `${raw} is not a directory.` }), inspected),
		});
		// The native session's header supplied this absolute directory; registering it
		// adds it to this launcher only, never to VS Code's workspace roots.
		const registered = await folders.registerValidated(first);
		assert.equal(registered.ok, true);
		assert.equal(registered.ok && registered.created, true);
		assert.deepEqual(inspected, [first], "an auto-registered path is validated before it is listed");

		// A second registration of the same directory selects the existing folder.
		const again = await folders.registerValidated(first);
		assert.equal(again.ok, true);
		assert.equal(again.ok && again.created, false);
		assert.equal(folders.list().length, 1);

		// A relative or empty value can never become a folder.
		assert.equal((await folders.registerValidated(path.join("some", "relative"))).ok, false);
		assert.equal((await folders.registerValidated("   ")).ok, false);
		assert.equal((await folders.registerValidated(second)).ok, false, "an unverified directory is refused");
		assert.deepEqual(
			folders.list().map(folder => folder.path),
			[first],
		);
	});

	it("removes a folder's metadata and persists it", async () => {
		const store = memoryStore();
		const folders = registry(store);
		const added = await folders.add(first);
		assert.equal(added.ok, true);
		const removed = await folders.remove(added.ok ? added.folder.id : "");
		assert.equal(removed.removed, true);
		assert.deepEqual(folders.list(), []);
		assert.equal(registry(store).list().length, 0);
	});

	it("keeps the committed folder's identity when another window adds the same directory", () => {
		const path = resolveFolderPath();
		const merged = mergeWorkspaceFolderRecords({
			base: { version: 1, folders: [{ id: "folder:a", path, collapsed: true }] },
			desired: {
				version: 1,
				folders: [
					{ id: "folder:a", path, collapsed: true },
					{ id: "folder:b", path, collapsed: false },
				],
			},
			latest: { version: 1, folders: [{ id: "folder:a", path, collapsed: true }] },
		});
		const folders = (merged.value as { folders: { id: string; collapsed: boolean }[] }).folders;
		assert.deepEqual(
			folders.map(folder => [folder.id, folder.collapsed]),
			[["folder:a", true]],
			"the established identity and its collapse state are kept, not the contender's",
		);
		assert.ok(
			merged.conflicts.some(conflict => /different id/.test(conflict.reason)),
			"the duplicate is reported rather than silently merged",
		);
	});

	it("mints the identity-derived id for a new record, whatever the spelling, and keeps a stored id", async () => {
		const spellings = [first, first + path.sep, path.join(temp, "detour", "..", "project-a")];
		const ids = new Set(spellings.map(spelling => windowFolderId(spelling)));
		assert.equal(ids.size, 1, "one directory is one id");
		assert.match([...ids][0]!, /^folder:[0-9a-f]{32}$/);
		assert.notEqual(windowFolderId(first), windowFolderId(second));

		const folders = registry(memoryStore());
		const added = await folders.add(first + path.sep, { collapsed: true });
		assert.equal(added.ok && added.folder.id, windowFolderId(first));
		assert.equal(added.ok && added.folder.collapsed, true, "a pinned folder can start collapsed");

		// A record an earlier build minted with a random id is matched by path and keeps its id.
		const store = memoryStore();
		store.update(WORKSPACE_FOLDERS_STORAGE_KEY, { version: 1, folders: [{ id: "folder:legacy", path: first, collapsed: false }] });
		const legacy = registry(store);
		const again = await legacy.add(first);
		assert.equal(again.ok && again.created, false);
		assert.equal(again.ok && again.folder.id, "folder:legacy");
	});

	it("merges two windows pinning the same folder into one record without a conflict", () => {
		const record = { id: windowFolderId(resolveFolderPath()), path: resolveFolderPath(), collapsed: false };
		const merged = mergeWorkspaceFolderRecords({
			base: { version: 1, folders: [] },
			desired: { version: 1, folders: [record] },
			latest: { version: 1, folders: [{ ...record }] },
		});
		assert.deepEqual((merged.value as { folders: unknown[] }).folders, [record]);
		assert.deepEqual(merged.conflicts, []);
	});
});

/** An absolute directory path for this platform, used as a folder identity. */
function resolveFolderPath(): string {
	return process.cwd();
}

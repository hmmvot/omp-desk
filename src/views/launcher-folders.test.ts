/**
 * Tests for the folders Sessions shows in one window.
 *
 * What is worth defending: that this window's VS Code folders and the pinned ones are
 * one deduplicated list (whatever the spelling of a path), that an unpinned folder keeps
 * the id it will have once pinned, that pin and unpin move a folder between the two
 * without losing it or its collapsed state, that a folder with a running session never
 * vanishes, that the setting hides only what is merely open, and that every command
 * argument resolves against the same list.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { LauncherFolders, WINDOW_FOLDER_COLLAPSED_KEY } from "./launcher-folders.ts";
import type { LauncherFolder } from "./launcher-folders.ts";
import {
	WORKSPACE_FOLDERS_STORAGE_KEY,
	WorkspaceFolderRegistry,
	folderArgument,
	windowFolderId,
} from "./workspace-folders.ts";
import type { FolderPathInspector, WorkspaceFolderStore } from "./workspace-folders.ts";

/** A memento stub holding every key in memory. */
function memoryStore(): WorkspaceFolderStore & { readonly values: Map<string, unknown> } {
	const values = new Map<string, unknown>();
	return {
		values,
		get<T>(key: string): T | undefined {
			return values.get(key) as T | undefined;
		},
		update(key: string, value: unknown): unknown {
			values.set(key, value);
			return undefined;
		},
	};
}

/** An inspector that accepts every existing directory, as VS Code's own file system does. */
const directoryInspector: FolderPathInspector = {
	async inspect(rawPath: string) {
		try {
			return (await fs.promises.stat(rawPath)).isDirectory()
				? ({ ok: true, path: rawPath } as const)
				: ({ ok: false, reason: `${rawPath} is not a directory.` } as const);
		} catch {
			return { ok: false, reason: `${rawPath} is not a directory.` } as const;
		}
	},
};

describe("launcher folders", () => {
	let temp: string;
	let alpha: string;
	let beta: string;
	let gamma: string;

	before(async () => {
		temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-launcher-folders-"));
		alpha = path.join(temp, "Alpha");
		beta = path.join(temp, "beta");
		gamma = path.join(temp, "gamma");
		for (const directory of [alpha, beta, gamma]) await fs.promises.mkdir(directory);
	});

	after(async () => {
		await fs.promises.rm(temp, { recursive: true, force: true });
	});

	/** One window: a pinned registry on a shared catalog store, a private workspace store and mutable window state. */
	function windowOver(catalog = memoryStore()) {
		const state = {
			windowPaths: [] as string[],
			show: true,
			live: [] as string[],
			workspace: memoryStore(),
		};
		const registry = new WorkspaceFolderRegistry({ store: catalog, inspector: directoryInspector });
		const folders = new LauncherFolders({
			pinned: registry,
			local: state.workspace,
			windowPaths: () => state.windowPaths,
			showWindowFolders: () => state.show,
			liveSessionCwds: () => state.live,
		});
		return { catalog, registry, folders, state };
	}

	const paths = (list: readonly LauncherFolder[]) => list.map(folder => folder.path);

	it("shows this window's folders first in VS Code order, then the other pinned folders in stored order", async () => {
		const w = windowOver();
		await w.registry.add(gamma);
		await w.registry.add(beta);
		w.state.windowPaths = [alpha, beta];
		assert.deepEqual(paths(w.folders.list()), [alpha, beta, gamma]);
		assert.deepEqual(w.folders.list().map(folder => [folder.pinned, folder.open]), [[false, true], [true, true], [true, false]]);
	});

	it("shows a folder that is both open and pinned once, as pinned, under its pinned id and collapsed state", async () => {
		const w = windowOver();
		const pinned = await w.registry.add(beta);
		assert.ok(pinned.ok);
		await w.registry.setCollapsed(pinned.folder.id, true);
		w.state.windowPaths = [beta];
		const [only, ...rest] = w.folders.list();
		assert.deepEqual(rest, []);
		assert.deepEqual(only, { id: pinned.folder.id, path: beta, collapsed: true, pinned: true, open: true });
	});

	it("treats case, trailing separator and detour spellings of one directory as one folder", async () => {
		const w = windowOver();
		await w.registry.add(beta);
		const spellings = [beta + path.sep, path.join(temp, "x", "..", "beta")];
		if (process.platform === "win32") spellings.push(beta.toUpperCase(), beta.replaceAll("\\", "/"));
		for (const spelling of spellings) {
			w.state.windowPaths = [spelling, beta];
			const list = w.folders.list();
			assert.equal(list.length, 1, spelling);
			assert.equal(list[0]!.pinned, true, spelling);
			assert.equal(list[0]!.open, true, spelling);
		}
		// Two open roots naming one directory are one folder as well.
		w.state.windowPaths = [alpha, alpha + path.sep];
		assert.equal(w.folders.list().filter(folder => folder.path.toLowerCase().includes("alpha")).length, 1);
	});

	it("gives a live session's detour spelling of a shown directory its own heading with a unique id", async () => {
		// A junction is another spelling of the same directory that string normalization cannot fold.
		const link = path.join(temp, "alpha-link");
		fs.symlinkSync(alpha, link, "junction");
		try {
			const w = windowOver();
			w.state.windowPaths = [alpha];
			w.state.live = [link];
			const list = w.folders.list();
			assert.deepEqual(paths(list), [alpha, link], "rows are filed under the spelling their cwd uses");
			assert.equal(list[0]!.id, windowFolderId(alpha));
			assert.notEqual(list[1]!.id, list[0]!.id, "the alias heading does not repeat the shown folder's id");
			assert.ok(list[1]!.id.startsWith("folder:"));
			assert.equal(w.folders.folderForCwd(link)?.id, list[1]!.id);
			assert.equal(w.folders.folderForCwd(alpha)?.id, list[0]!.id);
		} finally {
			fs.rmSync(link, { recursive: true, force: true });
		}
	});

	it("resolves a path once and forgets it when told, so a changed directory is seen after the open folders change", async () => {
		const link = path.join(temp, "memory-link");
		const one = path.join(temp, "memory-one");
		const two = path.join(temp, "memory-two");
		fs.mkdirSync(one);
		fs.mkdirSync(two);
		fs.symlinkSync(one, link, "junction");
		try {
			const w = windowOver();
			await w.registry.add(one);
			w.state.windowPaths = [link];
			assert.equal(w.folders.list().length, 1, "the junction and its target are one folder");
			fs.rmSync(link, { recursive: true, force: true });
			fs.symlinkSync(two, link, "junction");
			assert.equal(w.folders.list().length, 1, "the remembered resolution is not repeated per refresh");
			w.folders.forgetIdentities();
			assert.equal(w.folders.list().length, 2, "after forgetting, the junction resolves to its new target");
		} finally {
			fs.rmSync(link, { recursive: true, force: true });
		}
	});

	it("follows the window's folders live and never persists them", async () => {
		const w = windowOver();
		assert.deepEqual(w.folders.list(), []);
		w.state.windowPaths = [alpha];
		assert.deepEqual(paths(w.folders.list()), [alpha]);
		w.state.windowPaths = [alpha, beta];
		assert.deepEqual(paths(w.folders.list()), [alpha, beta]);
		w.state.windowPaths = [];
		assert.deepEqual(w.folders.list(), []);
		assert.equal(w.catalog.values.has(WORKSPACE_FOLDERS_STORAGE_KEY), false, "nothing durable was written");
		// Another window of the profile sees none of this window's folders.
		const other = windowOver(w.catalog);
		assert.deepEqual(other.folders.list(), []);
	});

	it("keeps a folder visible while a session runs in it, and drops it when that ends", async () => {
		const w = windowOver();
		w.state.windowPaths = [alpha];
		w.state.live = [gamma, gamma + path.sep, alpha];
		const list = w.folders.list();
		assert.deepEqual(paths(list), [alpha, gamma], "the live folder is listed once and an open one is not repeated");
		assert.deepEqual([list[1]!.pinned, list[1]!.open], [false, false]);
		assert.equal(list[1]!.id, windowFolderId(gamma));
		w.state.live = [];
		assert.deepEqual(paths(w.folders.list()), [alpha]);
	});

	it("hides only the merely open folders when the setting is off", async () => {
		const w = windowOver();
		await w.registry.add(beta);
		w.state.windowPaths = [alpha, beta];
		w.state.live = [gamma];
		w.state.show = false;
		const list = w.folders.list();
		assert.deepEqual(paths(list), [beta, gamma], "the pinned folder stays (still marked open) and so does a live-session folder");
		assert.equal(list[0]!.open, true);
		w.state.live = [];
		assert.deepEqual(paths(w.folders.list()), [beta]);
		w.state.show = true;
		assert.deepEqual(paths(w.folders.list()), [alpha, beta]);
	});

	it("gives an open folder the id it keeps once pinned, so commands and rows survive Pin", async () => {
		const w = windowOver();
		w.state.windowPaths = [alpha];
		const before = w.folders.list()[0]!;
		assert.equal(before.id, windowFolderId(alpha));
		assert.equal(folderArgument({ folderId: before.id }, w.folders.list()).kind, "folder");

		const pinned = await w.folders.pin(before.id);
		assert.ok(pinned.ok);
		assert.equal(pinned.created, true);
		assert.equal(pinned.folder.id, before.id);
		const after = w.folders.list();
		assert.equal(after.length, 1);
		assert.deepEqual([after[0]!.id, after[0]!.pinned, after[0]!.open], [before.id, true, true]);
		// The argument captured before Pin still resolves to the same folder.
		const resolved = folderArgument({ folderId: before.id }, after);
		assert.equal(resolved.kind === "folder" ? resolved.folder.path : null, alpha);
		// The identity-derived id is the same however the path is spelled, and in any window.
		assert.equal(windowFolderId(alpha + path.sep), before.id);
		if (process.platform === "win32") assert.equal(windowFolderId(alpha.toLowerCase()), before.id);
	});

	it("keeps a pinned folder after the workspace folder closes and shows it in every window", async () => {
		const w = windowOver();
		w.state.windowPaths = [alpha];
		await w.folders.pin(windowFolderId(alpha));
		w.state.windowPaths = [];
		const left = w.folders.list();
		assert.deepEqual(paths(left), [alpha]);
		assert.deepEqual([left[0]!.pinned, left[0]!.open], [true, false]);
		// A second window over the same catalog reloads the pin and shows it too.
		const other = windowOver(w.catalog);
		assert.deepEqual(paths(other.folders.list()), [alpha]);
		assert.equal(other.folders.list()[0]!.id, windowFolderId(alpha));
	});

	it("moves the collapsed state between the per-window store and the pinned record", async () => {
		const w = windowOver();
		w.state.windowPaths = [alpha];
		const id = windowFolderId(alpha);
		assert.equal(await w.folders.setCollapsed(id, true), true);
		assert.equal(w.folders.list()[0]!.collapsed, true);
		assert.equal(w.catalog.values.has(WORKSPACE_FOLDERS_STORAGE_KEY), false, "an unpinned folder's state is not shared");
		assert.deepEqual(w.state.workspace.get(WINDOW_FOLDER_COLLAPSED_KEY), { version: 1, collapsed: [id] });

		await w.folders.pin(id);
		assert.equal(w.folders.list()[0]!.collapsed, true, "pinning carries the collapsed state over");
		assert.deepEqual(w.state.workspace.get(WINDOW_FOLDER_COLLAPSED_KEY), { version: 1, collapsed: [] });
		assert.equal(w.registry.list()[0]!.collapsed, true);

		assert.equal(await w.folders.setCollapsed(id, false), true);
		assert.equal(w.registry.list()[0]!.collapsed, false, "a pinned folder's state is the durable one");
		await w.folders.setCollapsed(id, true);
		await w.folders.unpin(id);
		assert.equal(w.folders.list()[0]!.collapsed, true, "unpinning an open folder carries it back to this window");
		assert.equal(await w.folders.setCollapsed("folder:unknown", true), false);
	});

	it("unpins a folder that stays open, and drops one that is not open", async () => {
		const w = windowOver();
		w.state.windowPaths = [alpha];
		await w.folders.pin(windowFolderId(alpha));
		await w.folders.add(beta);
		const result = await w.folders.unpin(windowFolderId(alpha));
		assert.ok(result.unpinned);
		assert.equal(result.stillShown, true);
		assert.deepEqual(w.folders.list().map(folder => [folder.path, folder.pinned]), [[alpha, false], [beta, true]]);
		assert.deepEqual(w.registry.list().map(folder => folder.path), [beta], "only the pinned list changed");

		const gone = await w.folders.unpin(windowFolderId(beta));
		assert.ok(gone.unpinned);
		assert.equal(gone.stillShown, false);
		assert.deepEqual(paths(w.folders.list()), [alpha]);
	});

	it("keeps a folder pinned by an earlier build under its own id, and unpins it to the derived id", async () => {
		const catalog = memoryStore();
		catalog.values.set(WORKSPACE_FOLDERS_STORAGE_KEY, {
			version: 1,
			folders: [{ id: "folder:0d4f6c1e-legacy", path: beta, collapsed: true }],
		});
		const w = windowOver(catalog);
		w.state.windowPaths = [beta];
		const [shown] = w.folders.list();
		assert.deepEqual(shown, { id: "folder:0d4f6c1e-legacy", path: beta, collapsed: true, pinned: true, open: true });
		assert.equal(folderArgument({ folderId: "folder:0d4f6c1e-legacy" }, w.folders.list()).kind, "folder");

		const result = await w.folders.unpin("folder:0d4f6c1e-legacy");
		assert.ok(result.unpinned && result.stillShown);
		const [after] = w.folders.list();
		assert.deepEqual(after, { id: windowFolderId(beta), path: beta, collapsed: true, pinned: false, open: true });
	});

	it("unpins a folder that runs a session in this window and keeps it visible, unpinned", async () => {
		const w = windowOver();
		w.state.live = [alpha];
		await w.folders.add(alpha);
		const result = await w.folders.unpin(windowFolderId(alpha));
		assert.ok(result.unpinned && result.stillShown);
		assert.deepEqual(w.folders.list().map(folder => ({ path: folder.path, pinned: folder.pinned })), [{ path: alpha, pinned: false }]);
		assert.equal(w.registry.list().length, 0);
	});

	it("reports a stale id instead of acting on another folder", async () => {
		const w = windowOver();
		w.state.windowPaths = [alpha];
		const pinStale = await w.folders.pin("folder:gone");
		assert.equal(pinStale.ok, false);
		const unpinOpen = await w.folders.unpin(windowFolderId(alpha));
		assert.equal(unpinOpen.unpinned, false, "an unpinned folder has nothing to unpin");
		assert.equal(folderArgument({ folderId: "folder:gone" }, w.folders.list()).kind, "stale");
		assert.equal(folderArgument(alpha, w.folders.list()).kind, "stale", "a path is never an id");
		assert.equal(w.folders.get("folder:gone"), null);
	});

	it("pins by path through Add, selecting the folder the view already shows instead of duplicating it", async () => {
		const w = windowOver();
		w.state.windowPaths = [alpha];
		await w.folders.setCollapsed(windowFolderId(alpha), true);
		const added = await w.folders.add(alpha + path.sep);
		assert.ok(added.ok);
		assert.equal(added.created, true);
		assert.equal(added.folder.id, windowFolderId(alpha));
		assert.equal(added.folder.collapsed, true);
		const again = await w.folders.add(alpha);
		assert.ok(again.ok);
		assert.equal(again.created, false);
		assert.equal(w.registry.list().length, 1);
		const refused = await w.folders.add(path.join(temp, "missing"));
		assert.equal(refused.ok, false);
	});

	it("resolves the folder of a session by its working directory over the merged list", async () => {
		const w = windowOver();
		await w.registry.add(beta);
		w.state.windowPaths = [alpha];
		assert.equal(w.folders.folderForCwd(alpha + path.sep)?.id, windowFolderId(alpha));
		assert.equal(w.folders.folderForCwd(beta)?.pinned, true);
		assert.equal(w.folders.folderForCwd(gamma), null);
		assert.equal(w.folders.get(windowFolderId(alpha))?.path, alpha);
	});

	it("reports a failed save of an unpinned folder's collapsed state", async () => {
		const w = windowOver();
		w.state.windowPaths = [alpha];
		w.state.workspace.update = () => {
			throw new Error("disk is full");
		};
		await w.folders.setCollapsed(windowFolderId(alpha), true);
		assert.match(w.folders.persistError ?? "", /could not be saved/);
	});
});

/**
 * How the Sessions folder list shows the folder sessions run in: the checkout root of an opened folder, over a real temporary
 * directory tree, with the per-window `staysInFolder` list the setting publishes (it is resource-scoped).
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { probePathKind } from "../host/checkout-root.ts";
import type { PathKindProbe } from "../host/checkout-root.ts";
import { SessionFolderResolver } from "../host/session-folder.ts";
import { LauncherFolders } from "./launcher-folders.ts";
import type { OpenFolderWindow } from "./launcher-folders.ts";
import { WorkspaceFolderRegistry, folderOwnsCwd } from "./workspace-folders.ts";
import type { FolderPathInspector, WorkspaceFolderStore } from "./workspace-folders.ts";

function memoryStore(): WorkspaceFolderStore {
	const values = new Map<string, unknown>();
	return {
		get<T>(key: string): T | undefined {
			return values.get(key) as T | undefined;
		},
		update(key: string, value: unknown): unknown {
			values.set(key, value);
			return undefined;
		},
	};
}

const directoryInspector: FolderPathInspector = {
	async inspect(rawPath: string) {
		return { ok: true, path: rawPath } as const;
	},
};

describe("Sessions folders at the repository root", () => {
	let temp: string;
	const dir = (...parts: string[]) => path.join(temp, ...parts);
	const make = async (...parts: string[]) => { await fs.promises.mkdir(dir(...parts), { recursive: true }); };
	const confined: PathKindProbe = async target => (target.startsWith(temp + path.sep) ? probePathKind(target) : null);

	before(async () => {
		temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-session-folders-"));
		await make("home");
		// A Git checkout with a Unity project and a sibling below, and a subfolder with agent files of its own.
		await make("repo", ".git");
		await make("repo", "Unity", "Assets");
		await make("repo", "Unity2");
		await make("repo", "tools", ".agents");
		// A Plastic workspace and a plain folder.
		await make("plastic", ".plastic");
		await make("plastic", "Game");
		await make("loose", "project");
	});

	after(async () => { await fs.promises.rm(temp, { recursive: true, force: true }); });

	async function windowOver(options: { open: string[]; others?: string[][]; staying?: string[]; pinned?: string[]; live?: string[] }) {
		const resolver = new SessionFolderResolver({ probe: confined, home: dir("home"), p4config: null });
		await resolver.resolve([...options.open, ...(options.others ?? []).flat()]);
		const registry = new WorkspaceFolderRegistry({ store: memoryStore(), inspector: directoryInspector });
		for (const pinned of options.pinned ?? []) await registry.add(pinned);
		const stamp = { startedAt: "2026-01-01T00:00:00.000Z", focusedAt: null };
		const here: OpenFolderWindow = { holderId: "window-here", ...stamp, here: true, paths: options.open, ...(options.staying === undefined ? {} : { staysInFolder: options.staying }) };
		const others = (options.others ?? []).map((paths): OpenFolderWindow => ({ holderId: "window-other", ...stamp, here: false, paths }));
		return new LauncherFolders({
			pinned: registry,
			local: memoryStore(),
			windows: () => [here, ...others],
			sessionFolder: windowPath => resolver.lookup(windowPath),
			showWindowFolders: () => true,
			liveSessionCwds: () => options.live ?? [],
		});
	}

	it("collapses roots opened in different windows onto one shown root, open here and elsewhere", async () => {
		const folders = await windowOver({ open: [dir("repo", "Unity")], others: [[dir("repo", "Unity2"), dir("loose", "project")]] });
		const list = folders.list();
		assert.deepEqual(list.map(folder => folder.path), [dir("repo"), dir("loose", "project")]);
		assert.deepEqual(list[0]!.openedPaths, [dir("repo", "Unity"), dir("repo", "Unity2")]);
		assert.deepEqual([list[0]!.openHere, list[0]!.openElsewhere, list[1]!.openHere, list[1]!.openElsewhere], [true, true, false, true]);
		assert.equal(folders.folderForCwd(dir("repo", "Unity2"))?.id, list[0]!.id, "a session recorded in another window's subfolder is filed under the same root");
	});

	it("shows the root instead of the opened subfolder, keeping the subfolder for its sessions", async () => {
		const folders = await windowOver({ open: [dir("repo", "Unity")] });
		const [only, ...rest] = folders.list();
		assert.deepEqual(rest, []);
		assert.equal(only!.path, dir("repo"));
		assert.equal(only!.open, true);
		assert.deepEqual(only!.openedPaths, [dir("repo", "Unity")]);
		assert.equal(folders.folderForCwd(dir("repo", "Unity"))?.id, only!.id, "a new session in the subfolder's file starts at the root");
		assert.equal(folders.folderForCwd(dir("repo"))?.id, only!.id);
	});

	it("shows a Plastic workspace's Unity project as the workspace root", async () => {
		const [only] = (await windowOver({ open: [dir("plastic", "Game")] })).list();
		assert.equal(only!.path, dir("plastic"));
		assert.deepEqual(only!.openedPaths, [dir("plastic", "Game")]);
	});

	it("shows a subfolder with agent files of its own at the root too: only the checkout counts", async () => {
		const [only] = (await windowOver({ open: [dir("repo", "tools")] })).list();
		assert.equal(only!.path, dir("repo"));
		assert.deepEqual(only!.openedPaths, [dir("repo", "tools")]);
	});

	it("shows two roots under one checkout as one folder", async () => {
		const list = (await windowOver({ open: [dir("repo", "Unity"), dir("repo", "Unity2"), dir("repo")] })).list();
		assert.equal(list.length, 1);
		assert.deepEqual(list[0]!.openedPaths, [dir("repo", "Unity"), dir("repo", "Unity2")]);
	});

	it("deduplicates against a pinned root and keeps its pin and id", async () => {
		const list = (await windowOver({ open: [dir("repo", "Unity")], pinned: [dir("repo")] })).list();
		assert.equal(list.length, 1);
		assert.equal(list[0]!.pinned, true);
		assert.deepEqual(list[0]!.openedPaths, [dir("repo", "Unity")]);
	});

	it("leaves a folder outside any checkout as itself, without openedPaths", async () => {
		const list = (await windowOver({ open: [dir("loose", "project")] })).list();
		assert.deepEqual(list.map(folder => folder.path), [dir("loose", "project")]);
		assert.equal(list[0]!.openedPaths, undefined);
	});

	it("shows the opened folder where its window published that sessions stay in it, and the root for a folder of the same window that did not", async () => {
		const folders = await windowOver({ open: [dir("repo", "Unity"), dir("plastic", "Game")], staying: [dir("repo", "Unity")] });
		const list = folders.list();
		assert.deepEqual(list.map(folder => folder.path), [dir("repo", "Unity"), dir("plastic")]);
		assert.equal(list[0]!.openedPaths, undefined);
		assert.deepEqual(folders.windowsWithFolder(dir("repo", "Unity")).map(window => window.holderId), ["window-here"]);
		assert.deepEqual(folders.windowsWithFolder(dir("repo")).map(window => window.holderId), [], "the root is not this folder's own window's folder");
	});

	it("keeps a pinned subfolder as its own folder and marks it open, so its sessions stay under it", async () => {
		const folders = await windowOver({ open: [dir("repo", "Unity")], pinned: [dir("repo", "Unity")] });
		const list = folders.list();
		assert.deepEqual(list.map(folder => [folder.path, folder.pinned, folder.open]), [
			[dir("repo"), false, true],
			[dir("repo", "Unity"), true, true],
		]);
		assert.equal(folders.folderForCwd(dir("repo", "Unity"))?.path, dir("repo", "Unity"));
		assert.equal(folderOwnsCwd(list[0]!, list, dir("repo", "Unity")), false);
		assert.equal(folderOwnsCwd(list[1]!, list, dir("repo", "Unity")), true);
	});

	it("does not give a live session in the opened subfolder a heading of its own", async () => {
		const folders = await windowOver({ open: [dir("repo", "Unity")], live: [dir("repo", "Unity")] });
		assert.equal(folders.list().length, 1);
	});

	it("finds the windows that have a Unity project exactly, and those whose folder stands under the root", async () => {
		const folders = await windowOver({ open: [dir("repo", "Unity")], others: [[dir("repo")]] });
		assert.deepEqual(folders.windowsWithFolder(dir("repo", "Unity"), { exact: true }).map(window => window.holderId), ["window-here"], "the project itself must be a window's root");
		assert.deepEqual(folders.windowsWithFolder(dir("repo")).map(window => window.holderId).sort(), ["window-here", "window-other"]);
	});
});

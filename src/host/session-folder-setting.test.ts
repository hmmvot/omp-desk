/**
 * The Settings, Models and Agents editors bind the folder sessions run in: for an opened workspace folder (the one a command-opened
 * editor shows when no session is active) both read `ompDesk.runSessionsAtRepositoryRoot` and resolve through `sessionFolderFor`. Here
 * that answer (`editorProjectFolder`) is compared with the folder the Sessions list shows for the same opened folder, for several
 * systems and with the setting on and off. A session's own folder, a Sessions row and a folder the user chose are used as they are.
 * `vscode` is the stand-in of `src/wiring/vscode-test-stub.ts`, so this file must run under `node --test`.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import module from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, before, describe, it } from "node:test";

if (typeof module.registerHooks === "function") {
	const stubUrl = new URL("../wiring/vscode-test-stub.ts", import.meta.url).href;
	module.registerHooks({
		resolve(specifier, context, nextResolve) {
			return specifier === "vscode" ? { url: stubUrl, shortCircuit: true } : nextResolve(specifier, context);
		},
	});
}

const stub = await import("../wiring/vscode-test-stub.ts");
const { editorProjectFolder, runsAtRepositoryRoot } = await import("./session-folder-setting.ts");
const { SessionFolderResolver } = await import("./session-folder.ts");
const { probePathKind } = await import("./checkout-root.ts");
const { LauncherFolders } = await import("../views/launcher-folders.ts");
const { WorkspaceFolderRegistry } = await import("../views/workspace-folders.ts");

const SETTING = "ompDesk.runSessionsAtRepositoryRoot";
const store = () => {
	const values = new Map<string, unknown>();
	return { get: <T>(key: string) => values.get(key) as T | undefined, update: (key: string, value: unknown) => { values.set(key, value); return undefined; } };
};

describe("the folder the editors bind is the folder Sessions runs sessions in", () => {
	let temp: string;
	const dir = (...parts: string[]) => path.join(temp, ...parts);
	const make = async (...parts: string[]) => { await fs.promises.mkdir(dir(...parts), { recursive: true }); };

	before(async () => {
		temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-editor-folder-"));
		for (const [name, marker] of [["git", ".git"], ["plastic", ".plastic"], ["hg", ".hg"], ["svn", ".svn"], ["jj", ".jj"]] as const) {
			await make(name, marker);
			await make(name, "omp-vscode", "Assets");
			await make(name, "omp-vscode", "ProjectSettings");
			await fs.promises.writeFile(dir(name, "omp-vscode", "ProjectSettings", "ProjectVersion.txt"), "m_EditorVersion: 6000.0.1f1");
		}
	});
	after(async () => { await fs.promises.rm(temp, { recursive: true, force: true }); });
	afterEach(() => { delete stub.workspace.settings[SETTING]; });

	/** What Sessions shows for one opened folder, built as the extension builds it: the resolved root, and the window's published `staysInFolder`. */
	async function sessionsFolderFor(opened: string): Promise<string> {
		const resolver = new SessionFolderResolver({ probe: async target => (target.startsWith(temp + path.sep) ? probePathKind(target) : null), home: dir("nohome"), p4config: null });
		await resolver.resolve([opened]);
		const staysInFolder = runsAtRepositoryRoot(opened) ? [] : [opened];
		const folders = new LauncherFolders({
			pinned: new WorkspaceFolderRegistry({ store: store(), inspector: { async inspect(rawPath: string) { return { ok: true, path: rawPath } as const; } } }),
			local: store(),
			windows: () => [{ holderId: "here", here: true, startedAt: "2026-01-01T00:00:00.000Z", focusedAt: null, paths: [opened], staysInFolder }],
			sessionFolder: windowPath => resolver.lookup(windowPath),
			showWindowFolders: () => true,
			liveSessionCwds: () => [],
		});
		return folders.list()[0]!.path;
	}

	for (const name of ["git", "plastic", "hg", "svn", "jj"]) {
		it(`agree for a Unity project under ${name}: sessions and editors at the root, or both in the opened folder when the setting is off`, async () => {
			const unityProject = dir(name, "omp-vscode");
			assert.equal(await sessionsFolderFor(unityProject), dir(name));
			assert.equal(await editorProjectFolder(unityProject), dir(name));
			stub.workspace.settings[SETTING] = false;
			assert.equal(await sessionsFolderFor(unityProject), unityProject);
			assert.equal(await editorProjectFolder(unityProject), unityProject);
		});
	}

	it("reads the setting for the folder, so a monorepo folder can turn it off", () => {
		assert.equal(runsAtRepositoryRoot(dir("git", "omp-vscode")), true, "on by default");
		stub.workspace.settings[SETTING] = false;
		assert.equal(runsAtRepositoryRoot(dir("git", "omp-vscode")), false);
	});
});

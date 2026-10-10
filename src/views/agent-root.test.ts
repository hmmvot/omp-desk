/**
 * Tests for the agent-root derivation over a real temporary directory tree, and for how the
 * Sessions folder list shows what it resolved.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { AGENT_MARKERS, AgentRootResolver, resolveAgentRoot } from "./agent-root.ts";
import { LauncherFolders } from "./launcher-folders.ts";
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

describe("agent root derivation", () => {
	let temp: string;
	const dir = (...parts: string[]) => path.join(temp, ...parts);
	const make = async (...parts: string[]) => {
		await fs.promises.mkdir(dir(...parts), { recursive: true });
		return dir(...parts);
	};
	const write = async (parts: string[], content = "x") => {
		await fs.promises.mkdir(path.dirname(dir(...parts)), { recursive: true });
		await fs.promises.writeFile(dir(...parts), content);
	};

	before(async () => {
		temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-agent-root-"));
		// repo: .git + AGENTS.md + .omp at the root, a Unity project below without markers.
		await make("repo", ".git");
		await write(["repo", "AGENTS.md"]);
		await make("repo", ".omp");
		await make("repo", "Unity", "Assets");
		await make("repo", "Unity2");
		// A subfolder with its own marker keeps itself.
		await make("repo", "tools", ".agents");
		// A repository whose root has no marker, but whose ancestor does: the ancestor is above .git.
		await write(["outer", "AGENTS.md"]);
		await make("outer", "norepo-marker", ".git");
		await make("outer", "norepo-marker", "sub");
		// No .git at all anywhere on the way up; a marker above is not used.
		await write(["loose", "CLAUDE.md"]);
		await make("loose", "project", "deeper");
		// A marker between the folder and the repository root wins over the root's.
		await make("mono", ".git");
		await write(["mono", "AGENTS.md"]);
		await make("mono", "packages", "app", "src");
		await make("mono", "packages", ".pi");
		// .git as a file (worktree or submodule) bounds the walk too.
		await write(["wt", ".git"], "gitdir: elsewhere");
		await write(["wt", "CLAUDE.md"]);
		await make("wt", "game");
		// A repository root that is itself the opened folder, with no marker, stays.
		await make("bare", ".git");
		// A marker directory spelled as a file does not count.
		await make("odd", ".git");
		await write(["odd", ".omp"]);
		await make("odd", "sub");
	});

	after(async () => {
		await fs.promises.rm(temp, { recursive: true, force: true });
	});

	it("lists every agent marker in one constant", () => {
		assert.deepEqual(AGENT_MARKERS.map(marker => `${marker.kind}:${marker.name}`), [
			"file:AGENTS.md", "file:CLAUDE.md", "directory:.agents", "directory:.omp", "directory:.claude", "directory:.pi",
		]);
	});

	it("shows the repository root instead of a subfolder without markers", async () => {
		assert.equal(await resolveAgentRoot(dir("repo", "Unity")), dir("repo"));
		assert.equal(await resolveAgentRoot(dir("repo", "Unity", "Assets")), dir("repo"));
	});

	it("keeps a folder that has markers of its own, and the repository root itself", async () => {
		assert.equal(await resolveAgentRoot(dir("repo", "tools")), dir("repo", "tools"));
		assert.equal(await resolveAgentRoot(dir("repo")), dir("repo"));
	});

	it("keeps a folder when no Git repository encloses it, even with a marker above", async () => {
		assert.equal(await resolveAgentRoot(dir("loose", "project")), dir("loose", "project"));
		assert.equal(await resolveAgentRoot(dir("loose", "project", "deeper")), dir("loose", "project", "deeper"));
	});

	it("never looks above the repository root", async () => {
		assert.equal(await resolveAgentRoot(dir("outer", "norepo-marker", "sub")), dir("outer", "norepo-marker", "sub"));
		assert.equal(await resolveAgentRoot(dir("outer", "norepo-marker")), dir("outer", "norepo-marker"));
		assert.equal(await resolveAgentRoot(dir("bare")), dir("bare"));
	});

	it("takes the nearest ancestor with a marker, which may lie below the repository root", async () => {
		assert.equal(await resolveAgentRoot(dir("mono", "packages", "app", "src")), dir("mono", "packages"));
		assert.equal(await resolveAgentRoot(dir("mono", "packages", "app")), dir("mono", "packages"));
	});

	it("treats .git as a file as a repository root", async () => {
		assert.equal(await resolveAgentRoot(dir("wt", "game")), dir("wt"));
	});

	it("does not take a marker of the wrong kind", async () => {
		assert.equal(await resolveAgentRoot(dir("odd", "sub")), dir("odd", "sub"));
	});

	it("remembers answers, shows an unresolved folder as itself, and reports when an answer differs", async () => {
		const resolver = new AgentRootResolver();
		const roots = [dir("repo", "Unity"), dir("repo", "tools")];
		assert.equal(resolver.lookup(roots[0]!), roots[0], "unresolved folders stand for themselves");
		assert.equal(await resolver.resolve(roots), true);
		assert.equal(resolver.lookup(roots[0]!), dir("repo"));
		assert.equal(resolver.lookup(roots[1]!), roots[1]);
		assert.equal(await resolver.resolve(roots), false, "the same answers are not a change");
		assert.equal(await resolver.resolve([roots[1]!]), false);
		assert.equal(resolver.lookup(roots[0]!), roots[0], "a root no longer open is forgotten");
	});

	it("lets the newest of overlapping resolutions win", async () => {
		const gate = Promise.withResolvers<void>();
		let slow = true;
		const resolver = new AgentRootResolver(async target => {
			if (slow && target.startsWith(dir("repo", "Unity") + path.sep)) await gate.promise;
			try {
				const stat = await fs.promises.stat(target);
				return stat.isFile() ? "file" : "directory";
			} catch {
				return null;
			}
		});
		const first = resolver.resolve([dir("repo", "Unity")]);
		slow = false;
		assert.equal(await resolver.resolve([dir("repo", "Unity2")]), true);
		gate.resolve();
		assert.equal(await first, false, "the superseded call reports nothing");
		assert.equal(resolver.lookup(dir("repo", "Unity2")), dir("repo"));
		assert.equal(resolver.lookup(dir("repo", "Unity")), dir("repo", "Unity"));
	});

	describe("in the Sessions folder list", () => {
		async function windowOver(options: { open: string[]; useAgentRoot?: boolean; pinned?: string[]; live?: string[] }) {
			const resolver = new AgentRootResolver();
			await resolver.resolve(options.open);
			const registry = new WorkspaceFolderRegistry({ store: memoryStore(), inspector: directoryInspector });
			for (const pinned of options.pinned ?? []) await registry.add(pinned);
			const folders = new LauncherFolders({
				pinned: registry,
				local: memoryStore(),
				windowPaths: () => options.open,
				agentRoot: windowPath => (options.useAgentRoot === false ? windowPath : resolver.lookup(windowPath)),
				showWindowFolders: () => true,
				liveSessionCwds: () => options.live ?? [],
			});
			return folders;
		}

		it("shows the ancestor instead of the opened subfolder, keeping the subfolder for its sessions", async () => {
			const folders = await windowOver({ open: [dir("repo", "Unity")] });
			const [only, ...rest] = folders.list();
			assert.deepEqual(rest, []);
			assert.equal(only!.path, dir("repo"));
			assert.equal(only!.open, true);
			assert.deepEqual(only!.openedPaths, [dir("repo", "Unity")]);
			assert.equal(folders.folderForCwd(dir("repo", "Unity"))?.id, only!.id, "a new session in the subfolder's file starts at the ancestor");
			assert.equal(folders.folderForCwd(dir("repo"))?.id, only!.id);
		});

		it("shows two roots under one ancestor as one folder", async () => {
			const folders = await windowOver({ open: [dir("repo", "Unity"), dir("repo", "Unity2"), dir("repo")] });
			const list = folders.list();
			assert.equal(list.length, 1);
			assert.deepEqual(list[0]!.openedPaths, [dir("repo", "Unity"), dir("repo", "Unity2")]);
		});

		it("deduplicates against a pinned ancestor and keeps its pin and id", async () => {
			const folders = await windowOver({ open: [dir("repo", "Unity")], pinned: [dir("repo")] });
			const list = folders.list();
			assert.equal(list.length, 1);
			assert.equal(list[0]!.pinned, true);
			assert.deepEqual(list[0]!.openedPaths, [dir("repo", "Unity")]);
		});

		it("leaves a folder that keeps itself without openedPaths", async () => {
			const folders = await windowOver({ open: [dir("repo", "tools"), dir("loose", "project")] });
			const list = folders.list();
			assert.deepEqual(list.map(folder => folder.path), [dir("repo", "tools"), dir("loose", "project")]);
			assert.ok(list.every(folder => folder.openedPaths === undefined));
		});

		it("shows the opened folder when the setting is off", async () => {
			const folders = await windowOver({ open: [dir("repo", "Unity")], useAgentRoot: false });
			const [only] = folders.list();
			assert.equal(only!.path, dir("repo", "Unity"));
			assert.equal(only!.openedPaths, undefined);
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
	});
});

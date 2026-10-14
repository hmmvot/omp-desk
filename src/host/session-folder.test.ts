/**
 * The rule ("sessions run at the checkout root of the opened folder, else in the folder") over Unity-like layouts under
 * every system the marker table names, with the setting on and off, and the remembering resolver Sessions reads.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { probePathKind } from "./checkout-root.ts";
import type { PathKindProbe } from "./checkout-root.ts";
import { SessionFolderResolver, sessionFolderFor } from "./session-folder.ts";

describe("session folder", () => {
	let temp: string;
	const dir = (...parts: string[]) => path.join(temp, ...parts);
	const make = async (...parts: string[]) => { await fs.promises.mkdir(dir(...parts), { recursive: true }); };
	const write = async (parts: string[], content = "x") => {
		await fs.promises.mkdir(path.dirname(dir(...parts)), { recursive: true });
		await fs.promises.writeFile(dir(...parts), content);
	};
	const confined: PathKindProbe = async target => (target.startsWith(temp + path.sep) ? probePathKind(target) : null);
	const search = () => ({ probe: confined, home: dir("home"), p4config: null });

	/** `<name>/<marker>`, `<name>/omp-vscode/Assets`, `<name>/Game/ProjectSettings/ProjectVersion.txt`: VS Code opens `<name>/Game`. */
	async function unity(name: string, marker: (name: string) => Promise<void>): Promise<void> {
		await marker(name);
		await make(name, "Game", "Assets");
		await write([name, "Game", "ProjectSettings", "ProjectVersion.txt"], "m_EditorVersion: 6000.0.1f1");
	}

	before(async () => {
		temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-session-folder-"));
		await make("home");
	});
	after(async () => { await fs.promises.rm(temp, { recursive: true, force: true }); });

	const LAYOUTS: readonly [string, (name: string) => Promise<void>][] = [
		["Git", name => make(name, ".git")],
		["Plastic SCM", name => make(name, ".plastic")],
		["Mercurial", name => make(name, ".hg")],
		["Subversion", name => make(name, ".svn")],
		["Jujutsu", name => make(name, ".jj")],
		["Sapling", name => make(name, ".sl")],
		["Perforce", name => write([name, ".p4config"])],
		["Git worktree (.git file)", name => write([name, ".git"], "gitdir: ../main/.git/worktrees/wt")],
	];

	for (const [system, marker] of LAYOUTS) {
		it(`runs the sessions of a Unity project opened below a ${system} root at the root`, async () => {
			const name = `unity-${system.replace(/\W+/g, "-")}`;
			await unity(name, marker);
			assert.equal(await sessionFolderFor(dir(name, "Game"), true, search()), dir(name));
			assert.equal(await sessionFolderFor(dir(name, "Game", "Assets"), true, search()), dir(name));
			assert.equal(await sessionFolderFor(dir(name), true, search()), dir(name), "the root itself");
		});
	}

	it("is the opened folder itself when the setting is off, whatever encloses it", async () => {
		await unity("off", name => make(name, ".git"));
		assert.equal(await sessionFolderFor(dir("off", "Game"), false, search()), dir("off", "Game"));
	});

	it("is the opened folder itself when no checkout encloses it", async () => {
		await make("novcs", "project", "Assets");
		assert.equal(await sessionFolderFor(dir("novcs", "project"), true, search()), dir("novcs", "project"));
	});

	it("takes a submodule (a .git file) as the root of a folder inside it, and the repository's own root for a folder outside it", async () => {
		await make("super", ".git");
		await write(["super", "modules", "lib", ".git"], "gitdir: ../../.git/modules/lib");
		await make("super", "modules", "lib", "src");
		await make("super", "app");
		assert.equal(await sessionFolderFor(dir("super", "modules", "lib", "src"), true, search()), dir("super", "modules", "lib"));
		assert.equal(await sessionFolderFor(dir("super", "app"), true, search()), dir("super"));
	});

	it("takes the nearest root when markers nest", async () => {
		await make("nest", ".git");
		await make("nest", "inner", ".hg");
		await make("nest", "inner", "pkg");
		assert.equal(await sessionFolderFor(dir("nest", "inner", "pkg"), true, search()), dir("nest", "inner"));
	});

	it("never takes the home folder or a drive root for lack of a marker", async () => {
		await make("home", "work", "project");
		assert.equal(await sessionFolderFor(dir("home", "work", "project"), true, search()), dir("home", "work", "project"));
	});

	it("does not look at agent files: a subfolder with its own AGENTS.md still runs at the checkout root", async () => {
		await make("agents", ".git");
		await write(["agents", "tools", "AGENTS.md"]);
		await make("agents", "tools", ".omp");
		assert.equal(await sessionFolderFor(dir("agents", "tools"), true, search()), dir("agents"));
	});

	describe("the resolver Sessions reads", () => {
		const gatedProbe = (gate: Promise<void>, slowUnder: () => string | null): PathKindProbe => async target => {
			const slow = slowUnder();
			if (slow !== null && target.startsWith(slow + path.sep)) await gate;
			return confined(target);
		};

		it("remembers answers, shows an unresolved folder as itself, and reports when an answer differs", async () => {
			await make("remember", ".git");
			await make("remember", "Unity");
			await make("remember", "tools");
			await make("remember2", "plain");
			const resolver = new SessionFolderResolver(search());
			const roots = [dir("remember", "Unity"), dir("remember2", "plain")];
			assert.equal(resolver.lookup(roots[0]!), roots[0], "unresolved folders stand for themselves");
			assert.equal(await resolver.resolve(roots), true);
			assert.equal(resolver.lookup(roots[0]!), dir("remember"));
			assert.equal(resolver.lookup(roots[1]!), roots[1]);
			assert.equal(await resolver.resolve(roots), false, "the same answers are not a change");
			assert.equal(await resolver.resolve([roots[1]!]), false);
			assert.equal(resolver.lookup(roots[0]!), roots[0], "a root no longer open is forgotten");
		});

		it("notices a repository created after the folder was first resolved", async () => {
			await make("later", "Game");
			const resolver = new SessionFolderResolver(search());
			await resolver.resolve([dir("later", "Game")]);
			assert.equal(resolver.lookup(dir("later", "Game")), dir("later", "Game"));
			await make("later", ".git");
			assert.equal(await resolver.resolve([dir("later", "Game")]), true);
			assert.equal(resolver.lookup(dir("later", "Game")), dir("later"));
		});

		it("settles a superseded call only once the newest call has published, so awaiting it is a readiness barrier", async () => {
			await make("barrier", ".git");
			await make("barrier", "One");
			await make("barrier", "Two");
			const gate = Promise.withResolvers<void>();
			let slow: string | null = null;
			const resolver = new SessionFolderResolver({ ...search(), probe: gatedProbe(gate.promise, () => slow) });
			const first = resolver.resolve([dir("barrier", "One")]);
			slow = dir("barrier", "Two");
			const second = resolver.resolve([dir("barrier", "One"), dir("barrier", "Two")]);
			let firstSettled = false;
			void first.then(() => { firstSettled = true; });
			for (let turn = 0; turn < 20; turn++) await nextTurn();
			assert.equal(firstSettled, false, "the superseded call finished its own probes but waits for the newest to publish");
			gate.resolve();
			await first;
			assert.equal(resolver.lookup(dir("barrier", "Two")), dir("barrier"), "published by the time the superseded call settles");
			assert.equal(await second, true);
		});

		it("lets the newest of overlapping resolutions win", async () => {
			await make("newest", ".git");
			await make("newest", "One");
			await make("newest", "Two");
			const gate = Promise.withResolvers<void>();
			let slow: string | null = dir("newest", "One");
			const resolver = new SessionFolderResolver({ ...search(), probe: gatedProbe(gate.promise, () => slow) });
			const first = resolver.resolve([dir("newest", "One")]);
			slow = null;
			assert.equal(await resolver.resolve([dir("newest", "Two")]), true);
			gate.resolve();
			assert.equal(await first, false, "the superseded call reports nothing");
			assert.equal(resolver.lookup(dir("newest", "Two")), dir("newest"));
			assert.equal(resolver.lookup(dir("newest", "One")), dir("newest", "One"));
		});
	});
});

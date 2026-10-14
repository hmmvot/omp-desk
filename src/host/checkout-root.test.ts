/**
 * The checkout-root search over real temporary trees (one per version-control system) and over a fake probe where the
 * real file system cannot be used: a drive root, a home folder. The real home directory and the real ancestors of the
 * temporary directory are never consulted: every search is given an explicit `home` and a probe confined to the tree.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { CHECKOUT_MARKERS, findCheckoutRoot, probePathKind } from "./checkout-root.ts";
import type { CheckoutMemo, CheckoutSearch, PathKindProbe, VersionControl } from "./checkout-root.ts";

describe("checkout root", () => {
	let temp: string;
	const dir = (...parts: string[]) => path.join(temp, ...parts);
	const make = async (...parts: string[]) => { await fs.promises.mkdir(dir(...parts), { recursive: true }); };
	const write = async (parts: string[], content = "x") => {
		await fs.promises.mkdir(path.dirname(dir(...parts)), { recursive: true });
		await fs.promises.writeFile(dir(...parts), content);
	};
	/** Looks only inside the temporary tree: the real ancestors of the temporary directory never answer. */
	const confined = (calls?: string[]): PathKindProbe => async target => {
		if (!target.startsWith(temp + path.sep)) return null;
		calls?.push(target);
		return probePathKind(target);
	};
	const search = (extra: CheckoutSearch = {}): CheckoutSearch => ({ probe: confined(), home: dir("home"), p4config: null, ...extra });

	before(async () => {
		temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-checkout-root-"));
		await make("home");
	});
	after(async () => { await fs.promises.rm(temp, { recursive: true, force: true }); });

	const MARKERS: readonly { vcs: VersionControl; name: string; kind: "file" | "directory" }[] = [
		{ vcs: "git", name: ".git", kind: "directory" },
		{ vcs: "git", name: ".git", kind: "file" },
		{ vcs: "mercurial", name: ".hg", kind: "directory" },
		{ vcs: "sapling", name: ".sl", kind: "directory" },
		{ vcs: "jujutsu", name: ".jj", kind: "directory" },
		{ vcs: "subversion", name: ".svn", kind: "directory" },
		{ vcs: "plastic", name: ".plastic", kind: "directory" },
		{ vcs: "bazaar", name: ".bzr", kind: "directory" },
		{ vcs: "fossil", name: ".fslckout", kind: "file" },
		{ vcs: "fossil", name: "_FOSSIL_", kind: "file" },
		{ vcs: "pijul", name: ".pijul", kind: "directory" },
		{ vcs: "darcs", name: "_darcs", kind: "directory" },
	];

	it("lists every strong marker the table documents, and no other", () => {
		assert.deepEqual(CHECKOUT_MARKERS.map(marker => marker.name).sort(), MARKERS.map(marker => marker.name).filter((name, at, all) => all.indexOf(name) === at).sort());
	});

	for (const marker of MARKERS) {
		it(`finds a ${marker.vcs} checkout by ${marker.name} (${marker.kind}) from a Unity project below its root`, async () => {
			const base = `unity-${marker.vcs}-${marker.name}-${marker.kind}`;
			if (marker.kind === "directory") await make(base, marker.name);
			else await write([base, marker.name], "gitdir: elsewhere");
			await make(base, "Game", "Assets");
			await write([base, "Game", "ProjectSettings", "ProjectVersion.txt"]);
			for (const folder of [dir(base, "Game"), dir(base, "Game", "Assets"), dir(base)]) {
				assert.deepEqual(await findCheckoutRoot(folder, search()), { root: dir(base), vcs: marker.vcs }, folder);
			}
		});
	}

	it("does not take a marker of the wrong kind", async () => {
		await write(["wrong", ".hg"]);
		await make("wrong", ".fslckout");
		await make("wrong", "sub");
		assert.equal(await findCheckoutRoot(dir("wrong", "sub"), search()), null);
	});

	it("takes the nearest root: a submodule or worktree (.git file) inside a repository is the innermost root", async () => {
		await make("outer", ".git");
		await write(["outer", "libs", "sub", ".git"], "gitdir: ../../.git/modules/sub");
		await make("outer", "libs", "sub", "src");
		await make("outer", "app", "src");
		assert.deepEqual(await findCheckoutRoot(dir("outer", "libs", "sub", "src"), search()), { root: dir("outer", "libs", "sub"), vcs: "git" });
		assert.deepEqual(await findCheckoutRoot(dir("outer", "app", "src"), search()), { root: dir("outer"), vcs: "git" });
	});

	it("takes the nearest root whatever its system: a Mercurial checkout inside a Git one, a Plastic workspace inside a Subversion one", async () => {
		await make("mixed", ".git");
		await make("mixed", "hg", ".hg");
		await make("mixed", "hg", "pkg");
		await make("svn", ".svn");
		await make("svn", "ws", ".plastic");
		await make("svn", "ws", "Game");
		assert.deepEqual(await findCheckoutRoot(dir("mixed", "hg", "pkg"), search()), { root: dir("mixed", "hg"), vcs: "mercurial" });
		assert.deepEqual(await findCheckoutRoot(dir("svn", "ws", "Game"), search()), { root: dir("svn", "ws"), vcs: "plastic" });
	});

	it("is the folder itself when the folder holds the marker, and the same root for a colocated Jujutsu and Git root", async () => {
		await make("colocated", ".git");
		await make("colocated", ".jj");
		assert.deepEqual(await findCheckoutRoot(dir("colocated"), search()), { root: dir("colocated"), vcs: "git" });
	});

	it("is null when no checkout encloses the folder, whatever sits above it", async () => {
		await make("loose", "project", "deeper");
		await write(["loose", "AGENTS.md"]);
		assert.equal(await findCheckoutRoot(dir("loose", "project", "deeper"), search()), null);
	});

	describe("CVS", () => {
		it("takes the topmost directory of the consecutive run that has CVS/Root", async () => {
			for (const parts of [["cvs", "mod"], ["cvs", "mod", "src"], ["cvs", "mod", "src", "deep"]]) await write([...parts, "CVS", "Root"], ":pserver:x@host:/cvs");
			assert.deepEqual(await findCheckoutRoot(dir("cvs", "mod", "src", "deep"), search()), { root: dir("cvs", "mod"), vcs: "cvs" });
			assert.deepEqual(await findCheckoutRoot(dir("cvs", "mod", "src"), search()), { root: dir("cvs", "mod"), vcs: "cvs" });
			assert.deepEqual(await findCheckoutRoot(dir("cvs", "mod"), search()), { root: dir("cvs", "mod"), vcs: "cvs" });
		});

		it("ignores a CVS directory without Root, and a folder below the run that has none", async () => {
			await make("cvs2", "mod", "CVS");
			await make("cvs2", "mod", "plain");
			assert.equal(await findCheckoutRoot(dir("cvs2", "mod", "plain"), search()), null);
			await write(["cvs3", "mod", "CVS", "Root"]);
			await make("cvs3", "mod", "plain");
			assert.deepEqual(await findCheckoutRoot(dir("cvs3", "mod", "plain"), search()), { root: dir("cvs3", "mod"), vcs: "cvs" }, "a plain subfolder reaches the module root");
		});
	});

	describe("Perforce", () => {
		it("takes a .p4config file at the workspace root", async () => {
			await write(["p4", "ws", ".p4config"], "P4CLIENT=ws");
			await make("p4", "ws", "Game");
			assert.deepEqual(await findCheckoutRoot(dir("p4", "ws", "Game"), search()), { root: dir("p4", "ws"), vcs: "perforce" });
		});

		it("takes the file the P4CONFIG variable names, as well as .p4config", async () => {
			await write(["p4b", "ws", "p4settings.txt"]);
			await make("p4b", "ws", "Game");
			assert.equal(await findCheckoutRoot(dir("p4b", "ws", "Game"), search()), null, "without the variable the name means nothing");
			assert.deepEqual(await findCheckoutRoot(dir("p4b", "ws", "Game"), search({ p4config: "p4settings.txt" })), { root: dir("p4b", "ws"), vcs: "perforce" });
		});

		it("never follows a P4CONFIG value that is a path", async () => {
			await write(["p4c", "ws", "evil"]);
			await write(["p4c", "evil"]);
			await make("p4c", "ws", "Game");
			for (const value of ["../evil", "ws/evil", "..", ".", ""]) assert.equal(await findCheckoutRoot(dir("p4c", "ws", "Game"), search({ p4config: value })), null, JSON.stringify(value));
		});

		it("is nearer than a repository above it", async () => {
			await make("p4d", ".git");
			await write(["p4d", "ws", ".p4config"]);
			await make("p4d", "ws", "Game");
			assert.deepEqual(await findCheckoutRoot(dir("p4d", "ws", "Game"), search()), { root: dir("p4d", "ws"), vcs: "perforce" });
		});
	});

	describe("home folders and drive roots", () => {
		it("never takes the home folder for lack of a marker, and never climbs above it", async () => {
			await make("above", ".git");
			await make("above", "home", "work", "project");
			assert.equal(await findCheckoutRoot(dir("above", "home", "work", "project"), search({ home: dir("above", "home") })), null);
			assert.deepEqual(await findCheckoutRoot(dir("above", "elsewhere"), search({ home: dir("above", "home") })), { root: dir("above"), vcs: "git" }, "a folder outside home may lie in a repository above it");
		});

		it("takes the home folder when it truly is a checkout: a strong marker, as a dotfiles repository has", async () => {
			await make("dot", "home", ".git");
			await make("dot", "home", "work");
			assert.deepEqual(await findCheckoutRoot(dir("dot", "home", "work"), search({ home: dir("dot", "home") })), { root: dir("dot", "home"), vcs: "git" });
		});

		it("does not take a P4CONFIG file or a CVS directory in the home folder", async () => {
			await write(["weak", "home", ".p4config"]);
			await write(["weak", "home", "CVS", "Root"]);
			await make("weak", "home", "work");
			assert.equal(await findCheckoutRoot(dir("weak", "home", "work"), search({ home: dir("weak", "home") })), null);
			assert.equal(await findCheckoutRoot(dir("weak", "home"), search({ home: dir("weak", "home") })), null, "nor for the home folder itself");
		});

		it("takes a drive root only by a strong marker", async () => {
			const root = path.parse(temp).root;
			const present = (...names: string[]): PathKindProbe => async target => {
				const relative = path.relative(root, target);
				return names.includes(relative) ? (relative === ".git" ? "directory" : "file") : null;
			};
			const folder = path.join(root, "work", "project");
			assert.equal(await findCheckoutRoot(folder, { probe: present(".p4config", path.join("CVS", "Root")), home: null, p4config: null }), null);
			assert.deepEqual(await findCheckoutRoot(folder, { probe: present(".git"), home: null, p4config: null }), { root, vcs: "git" });
		});

		it("stops at the drive root", async () => {
			const root = path.parse(temp).root;
			const seen = new Set<string>();
			const probe: PathKindProbe = async target => { if (path.basename(target) === ".git") seen.add(path.dirname(target)); return null; };
			assert.equal(await findCheckoutRoot(path.join(root, "a", "b"), { probe, home: null, p4config: null }), null);
			assert.deepEqual([...seen].sort(), [path.join(root, "a", "b"), path.join(root, "a"), root].sort());
		});
	});

	describe("cost", () => {
		it("costs at most fifteen stats a directory", async () => {
			await make("deep", "a", "b", "c");
			const calls: string[] = [];
			assert.equal(await findCheckoutRoot(dir("deep", "a", "b", "c"), search({ probe: confined(calls), p4config: "p4settings" })), null);
			const perDirectory = new Map<string, number>();
			for (const call of calls) {
				const directory = path.basename(call) === "Root" && path.basename(path.dirname(call)) === "CVS" ? path.dirname(path.dirname(call)) : path.dirname(call);
				perDirectory.set(directory, (perDirectory.get(directory) ?? 0) + 1);
			}
			assert.ok(perDirectory.size > 0 && [...perDirectory.values()].every(count => count <= 15), JSON.stringify([...perDirectory]));
		});

		it("lets the folders of one pass share the directories they climb through", async () => {
			await make("shared", ".git");
			await make("shared", "one", "deep");
			await make("shared", "two", "deep");
			const alone: string[] = [];
			const pooled: string[] = [];
			const memo: CheckoutMemo = new Map();
			for (const folder of [dir("shared", "one", "deep"), dir("shared", "two", "deep")]) {
				await findCheckoutRoot(folder, search({ probe: confined(alone) }));
				await findCheckoutRoot(folder, search({ probe: confined(pooled), memo }));
			}
			assert.ok(pooled.length < alone.length, `${pooled.length} against ${alone.length}`);
		});
	});
});

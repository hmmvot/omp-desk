/**
 * Tests for which session roots a read-only history pass resolves.
 *
 * What is worth defending here: that running under a named profile never hides
 * the ordinary default profile's own history (resuming one of its files with an
 * inherited profile would claim the wrong profile), that the agent-dir override,
 * every named profile, applicable XDG storage and the exact directories the index
 * knows are all covered, that a directory reachable twice is scanned once, and
 * that a profile name which could not be a profile is reported instead of being
 * joined into a path outside the config root. The OMP path environment is
 * injected, so every branch is exercised on one machine without touching the
 * process environment.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { resolveNativeHistoryRoots } from "./native-history-roots.ts";
import type { NativeHistoryRoot } from "./native-history.ts";

describe("native history roots", () => {
	const tempDirs: string[] = [];

	async function tempHome(): Promise<string> {
		const home = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-history-roots-"));
		tempDirs.push(home);
		return home;
	}

	function rootsByPath(roots: readonly NativeHistoryRoot[]): Map<string, NativeHistoryRoot> {
		return new Map(roots.map(root => [root.root, root]));
	}

	after(async () => {
		for (const dir of tempDirs) await fs.promises.rm(dir, { recursive: true, force: true });
	});

	it("scans the ordinary default profile even while a named profile is inherited", async () => {
		const home = await tempHome();
		const sessions = path.join(home, ".omp", "agent", "sessions");
		const work = path.join(home, ".omp", "profiles", "work", "agent", "sessions");
		await fs.promises.mkdir(sessions, { recursive: true });
		await fs.promises.mkdir(work, { recursive: true });

		const resolved = await resolveNativeHistoryRoots([], [], {
			home,
			env: { OMP_PROFILE: "work" },
			platform: "win32",
		});

		assert.deepEqual(
			resolved.roots.map(root => root.root),
			[sessions, work],
			"the default profile first, then the inherited one",
		);
		assert.equal(resolved.roots[0]?.profile, null);
		assert.equal(resolved.roots[0]?.source, "default-profile");
		assert.equal(resolved.roots[1]?.profile, "work");
		assert.equal(resolved.roots[1]?.source, "active-profile");
		assert.deepEqual(resolved.diagnostics, []);
	});

	it("scans the agent-dir override as a default-profile root, under any active profile", async () => {
		const home = await tempHome();
		const override = path.join(home, "override-agent");
		await fs.promises.mkdir(path.join(override, "sessions"), { recursive: true });

		const resolved = await resolveNativeHistoryRoots([], [], {
			home,
			env: { PI_CODING_AGENT_DIR: override, OMP_PROFILE: "work" },
			platform: "win32",
		});

		const root = rootsByPath(resolved.roots).get(path.join(override, "sessions"));
		assert.equal(root?.profile, null);
		assert.equal(root?.source, "default-profile");
	});

	it("adds every named profile that exists, from the config root and the XDG root", async () => {
		const home = await tempHome();
		await fs.promises.mkdir(path.join(home, ".omp", "profiles", "alpha", "agent", "sessions"), { recursive: true });
		const xdg = path.join(home, "xdg");
		await fs.promises.mkdir(path.join(xdg, "omp", "sessions"), { recursive: true });
		await fs.promises.mkdir(path.join(xdg, "omp", "profiles", "beta", "sessions"), { recursive: true });

		const resolved = await resolveNativeHistoryRoots([], [], {
			home,
			env: { XDG_DATA_HOME: xdg },
			platform: "linux",
		});

		const byPath = rootsByPath(resolved.roots);
		assert.deepEqual(
			[...byPath.keys()].sort(),
			[
				path.join(home, ".omp", "agent", "sessions"),
				path.join(home, ".omp", "profiles", "alpha", "agent", "sessions"),
				path.join(xdg, "omp", "profiles", "beta", "sessions"),
				path.join(xdg, "omp", "sessions"),
			].sort(),
		);
		assert.equal(byPath.get(path.join(home, ".omp", "profiles", "alpha", "agent", "sessions"))?.source, "named-profile");
		assert.equal(byPath.get(path.join(xdg, "omp", "profiles", "beta", "sessions"))?.source, "named-profile");
		assert.equal(byPath.get(path.join(xdg, "omp", "profiles", "beta", "sessions"))?.profile, "beta");
		assert.equal(byPath.get(path.join(xdg, "omp", "sessions"))?.source, "default-profile");
		assert.equal(byPath.get(path.join(xdg, "omp", "sessions"))?.profile, null);
	});

	it("ignores XDG storage on a platform that does not use it", async () => {
		const home = await tempHome();
		const xdg = path.join(home, "xdg");
		await fs.promises.mkdir(path.join(xdg, "omp", "sessions"), { recursive: true });

		const resolved = await resolveNativeHistoryRoots([], [], {
			home,
			env: { XDG_DATA_HOME: xdg },
			platform: "win32",
		});

		assert.ok(resolved.roots.every(root => !root.root.startsWith(xdg)));
	});

	it("scans the exact directory of a session file the index knows, once", async () => {
		const home = await tempHome();
		const bucket = path.join(home, "custom", "--proj--");
		await fs.promises.mkdir(bucket, { recursive: true });
		const file = path.join(bucket, "2026-01-01T00-00-00-000Z_session.jsonl");
		await fs.promises.writeFile(file, "", "utf8");
		// The same bucket as a file's directory and as an explicit directory the
		// index recorded: one root, not two.
		const resolved = await resolveNativeHistoryRoots(
			[
				{ path: file, profile: null },
				{ path: bucket, profile: null },
			],
			[],
			{ home, env: {}, platform: "win32" },
		);

		assert.equal(resolved.roots.filter(root => root.root === bucket).length, 1);
		assert.equal(resolved.roots.find(root => root.root === bucket)?.source, "explicit");

		const absent = await resolveNativeHistoryRoots([{ path: path.join(home, "gone", "session.jsonl"), profile: null }], [], {
			home,
			env: {},
			platform: "win32",
		});
		assert.deepEqual(
			absent.roots.map(root => root.root),
			[path.join(home, ".omp", "agent", "sessions")],
			"an explicit path that does not exist adds no root",
		);
	});

	it("deduplicates a directory reached as an inherited profile and as a named profile", async () => {
		const home = await tempHome();
		const work = path.join(home, ".omp", "profiles", "work", "agent", "sessions");
		await fs.promises.mkdir(work, { recursive: true });

		const resolved = await resolveNativeHistoryRoots([], ["work"], {
			home,
			env: { OMP_PROFILE: "work" },
			platform: "win32",
		});

		assert.equal(resolved.roots.filter(root => root.root === work).length, 1);
		assert.equal(resolved.roots.find(root => root.root === work)?.source, "active-profile");
	});

	it("reports a profile name that could not be a profile instead of escaping the config root", async () => {
		const home = await tempHome();
		await fs.promises.mkdir(path.join(home, ".omp", "agent", "sessions"), { recursive: true });

		const resolved = await resolveNativeHistoryRoots([], ["../evil", "Not A Profile"], {
			home,
			env: { OMP_PROFILE: "..\\evil" },
			platform: "win32",
		});

		assert.deepEqual(
			resolved.diagnostics.map(diagnostic => diagnostic.kind),
			["invalid-profile", "invalid-profile", "invalid-profile"],
		);
		assert.ok(resolved.roots.every(root => !root.root.includes("evil")));
		assert.deepEqual(
			resolved.roots.map(root => root.root),
			[path.join(home, ".omp", "agent", "sessions")],
		);
	});

	it("ignores a profile directory whose name could not be a profile", async () => {
		const home = await tempHome();
		await fs.promises.mkdir(path.join(home, ".omp", "profiles", "Not A Profile", "agent", "sessions"), {
			recursive: true,
		});

		const resolved = await resolveNativeHistoryRoots([], [], { home, env: {}, platform: "win32" });

		assert.ok(resolved.roots.every(root => !root.root.includes("Not A Profile")));
	});

	it("names the default profile's root even when it does not exist yet", async () => {
		const home = await tempHome();

		const resolved = await resolveNativeHistoryRoots([], [], { home, env: {}, platform: "win32" });

		assert.deepEqual(
			resolved.roots.map(root => root.root),
			[path.join(home, ".omp", "agent", "sessions")],
		);
		assert.equal(resolved.roots[0]?.source, "default-profile");
	});
});

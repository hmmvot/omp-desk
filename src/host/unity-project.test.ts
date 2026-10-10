/**
 * Finding the Unity projects a launch stands for (ADR-0057), against a real temporary tree: a
 * project is a directory with `ProjectSettings/ProjectVersion.txt` and `Assets/`, searched two
 * levels down, never through dot-directories or the trees Unity and Node generate.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { UnityProjectCache, findUnityProjects, isUnityProject } from "./unity-project.ts";

describe("unity projects", () => {
	let root: string;
	let counter = 0;

	before(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-unity-projects-"));
	});
	after(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	/** A fresh folder under the temp root. */
	const folder = (name: string): string => {
		const directory = path.join(root, `${name}-${counter++}`);
		fs.mkdirSync(directory, { recursive: true });
		return directory;
	};
	/** Make `directory` a Unity project. */
	const project = (directory: string): string => {
		fs.mkdirSync(path.join(directory, "ProjectSettings"), { recursive: true });
		fs.mkdirSync(path.join(directory, "Assets"), { recursive: true });
		fs.writeFileSync(path.join(directory, "ProjectSettings", "ProjectVersion.txt"), "m_EditorVersion: 6000.0.0f1\n");
		return directory;
	};
	const at = (base: string, ...parts: string[]) => path.join(base, ...parts);

	it("recognizes a project by ProjectVersion.txt and Assets, and nothing less", async () => {
		const whole = project(folder("whole"));
		assert.equal(await isUnityProject(whole), true);
		const noAssets = folder("no-assets");
		fs.mkdirSync(at(noAssets, "ProjectSettings"));
		fs.writeFileSync(at(noAssets, "ProjectSettings", "ProjectVersion.txt"), "x");
		assert.equal(await isUnityProject(noAssets), false);
		const noVersion = folder("no-version");
		fs.mkdirSync(at(noVersion, "ProjectSettings"));
		fs.mkdirSync(at(noVersion, "Assets"));
		assert.equal(await isUnityProject(noVersion), false);
		const versionIsADirectory = folder("version-dir");
		fs.mkdirSync(at(versionIsADirectory, "ProjectSettings", "ProjectVersion.txt"), { recursive: true });
		fs.mkdirSync(at(versionIsADirectory, "Assets"));
		assert.equal(await isUnityProject(versionIsADirectory), false);
		assert.equal(await isUnityProject(at(root, "does-not-exist")), false);
	});

	it("stands for the folder itself when it is a project", async () => {
		const direct = project(folder("direct"));
		assert.deepEqual(await findUnityProjects(direct), [direct]);
	});

	it("finds the project below an agent root, as WH2 below wh2", async () => {
		const repo = folder("wh2");
		fs.writeFileSync(at(repo, "AGENTS.md"), "# agents\n");
		fs.mkdirSync(at(repo, ".git"));
		const unity = project(at(repo, "WH2"));
		fs.mkdirSync(at(repo, "docs"));
		assert.deepEqual(await findUnityProjects(repo), [unity]);
	});

	it("finds several projects, down to two levels, in a stable order", async () => {
		const repo = folder("many");
		const second = project(at(repo, "Games", "Beta"));
		const first = project(at(repo, "Alpha"));
		assert.deepEqual(await findUnityProjects(repo), [first, second]);
	});

	it("finds nothing in a folder without projects, or deeper than two levels", async () => {
		const plain = folder("plain");
		fs.mkdirSync(at(plain, "src"));
		fs.writeFileSync(at(plain, "src", "main.ts"), "");
		assert.deepEqual(await findUnityProjects(plain), []);
		const deep = folder("deep");
		project(at(deep, "a", "b", "Unity"));
		assert.deepEqual(await findUnityProjects(deep), []);
		assert.deepEqual(await findUnityProjects(at(root, "does-not-exist")), []);
	});

	it("never looks through dot-directories or the generated trees, whatever their case", async () => {
		const repo = folder("excluded");
		for (const skipped of [".hidden", "node_modules", "Library", "TEMP", "Logs"]) project(at(repo, skipped, "Proj"));
		project(at(repo, "node_modules", "pkg"));
		assert.deepEqual(await findUnityProjects(repo), []);
		const real = project(at(repo, "Real"));
		assert.deepEqual(await findUnityProjects(repo), [real]);
	});

	it("does not search inside a project it found", async () => {
		const repo = folder("nested");
		const outer = project(at(repo, "Outer"));
		project(at(outer, "Assets", "Inner"));
		assert.deepEqual(await findUnityProjects(repo), [outer]);
	});

	it("remembers an answer for a short time only", async () => {
		const repo = folder("cached");
		let clock = 1_000;
		const cache = new UnityProjectCache({ now: () => clock, ttlMs: 500 });
		assert.deepEqual(await cache.projects(repo), []);
		const unity = project(at(repo, "App"));
		clock += 100;
		assert.deepEqual(await cache.projects(repo), [], "the cached answer is reused");
		clock += 1_000;
		assert.deepEqual(await cache.projects(repo), [unity], "and renewed once it is old");
		project(at(repo, "Other"));
		cache.clear();
		assert.equal((await cache.projects(repo)).length, 2);
	});
});

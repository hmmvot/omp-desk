import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { findOmpDependencyRoot, ompDependencyCandidates, ompDependencyRoot } from "./omp-package-layout.ts";

/**
 * The staged workers import `@oh-my-pi/pi-utils`, `pi-tui`, `pi-ai` and `pi-catalog` from the selected OMP's own tree. Their place
 * depends on the package manager that installed OMP, so each layout is built on disk the way that manager lays it out.
 */
describe("where an OMP package's own dependencies are", () => {
	let temp: string;
	let layouts = 0;

	before(async () => {
		temp = await mkdtemp(path.join(tmpdir(), "omp-layout-"));
	});
	after(async () => {
		await rm(temp, { recursive: true, force: true });
	});

	async function pkg(directory: string, name: string): Promise<string> {
		await mkdir(directory, { recursive: true });
		await writeFile(path.join(directory, "package.json"), JSON.stringify({ name, version: "18.11.1" }));
		return directory;
	}

	/** `bun install -g`: `<bun>/install/global/node_modules/@oh-my-pi/{pi-coding-agent,pi-utils,...}`, every package a sibling. */
	async function bunGlobal(): Promise<{ readonly root: string; readonly utils: string }> {
		const scope = path.join(temp, `layout-${layouts++}`, "install", "global", "node_modules", "@oh-my-pi");
		const root = await pkg(path.join(scope, "pi-coding-agent"), "@oh-my-pi/pi-coding-agent");
		return { root, utils: await pkg(path.join(scope, "pi-utils"), "@oh-my-pi/pi-utils") };
	}

	/** `npm install -g` of OMP 18.11.1: the dependencies are inside the package, and nothing sits beside it. */
	async function npmGlobalNested(): Promise<{ readonly root: string; readonly utils: string }> {
		const scope = path.join(temp, `layout-${layouts++}`, "node_modules", "@oh-my-pi");
		const root = await pkg(path.join(scope, "pi-coding-agent"), "@oh-my-pi/pi-coding-agent");
		return { root, utils: await pkg(path.join(root, "node_modules", "@oh-my-pi", "pi-utils"), "@oh-my-pi/pi-utils") };
	}

	it("are siblings of the package under a Bun global install", async () => {
		const install = await bunGlobal();
		assert.equal(findOmpDependencyRoot(install.root, "pi-utils"), install.utils);
		assert.equal(ompDependencyRoot(install.root, "pi-utils"), install.utils);
	});

	it("are inside the package under an npm global install, where nothing sits beside it", async () => {
		const install = await npmGlobalNested();
		assert.equal(findOmpDependencyRoot(install.root, "pi-utils"), install.utils);
		assert.equal(findOmpDependencyRoot(path.join(path.dirname(install.root), "pi-utils"), "pi-utils"), null, "the old sibling guess names a folder that is not there");
	});

	it("are siblings again in a hoisted npm or pnpm tree", async () => {
		const scope = path.join(temp, `layout-${layouts++}`, "node_modules", "@oh-my-pi");
		const root = await pkg(path.join(scope, "pi-coding-agent"), "@oh-my-pi/pi-coding-agent");
		const utils = await pkg(path.join(scope, "pi-utils"), "@oh-my-pi/pi-utils");
		assert.equal(findOmpDependencyRoot(root, "pi-utils"), utils);
	});

	it("prefer the nearest copy, the way Node resolves, when a nested one and a sibling both exist", async () => {
		const install = await npmGlobalNested();
		await pkg(path.join(path.dirname(install.root), "pi-utils"), "@oh-my-pi/pi-utils");
		assert.equal(findOmpDependencyRoot(install.root, "pi-utils"), install.utils);
	});

	it("are taken only from a folder whose manifest names the package", async () => {
		const scope = path.join(temp, `layout-${layouts++}`, "node_modules", "@oh-my-pi");
		const root = await pkg(path.join(scope, "pi-coding-agent"), "@oh-my-pi/pi-coding-agent");
		await pkg(path.join(scope, "pi-utils"), "someone-elses-utils");
		assert.equal(findOmpDependencyRoot(root, "pi-utils"), null);
		await mkdir(path.join(scope, "pi-tui"), { recursive: true });
		assert.equal(findOmpDependencyRoot(root, "pi-tui"), null, "a folder with no manifest is not a package");
	});

	it("refuse with a sentence that names the package and where it was looked for, through the caller's own error", async () => {
		const scope = path.join(temp, `layout-${layouts++}`, "node_modules", "@oh-my-pi");
		const root = await pkg(path.join(scope, "pi-coding-agent"), "@oh-my-pi/pi-coding-agent");
		class Refusal extends Error {}
		assert.throws(() => ompDependencyRoot(root, "pi-tui", message => new Refusal(message)), (error: unknown) =>
			error instanceof Refusal && error.message.includes("@oh-my-pi/pi-tui") && error.message.includes(path.join(root, "node_modules", "@oh-my-pi", "pi-tui")));
	});

	it("lists the package's own node_modules, then the one it is installed into, and goes no further up", () => {
		const volume = path.parse(process.cwd()).root;
		const root = path.join(volume, "a", "node_modules", "@oh-my-pi", "pi-coding-agent");
		assert.deepEqual(ompDependencyCandidates(root, "pi-utils"), [
			path.join(root, "node_modules", "@oh-my-pi", "pi-utils"),
			path.join(volume, "a", "node_modules", "@oh-my-pi", "pi-utils"),
		]);
		const checkout = path.join(volume, "src", "oh-my-pi", "packages", "coding-agent");
		assert.deepEqual(ompDependencyCandidates(checkout, "pi-utils"), [path.join(checkout, "node_modules", "@oh-my-pi", "pi-utils")], "a checkout outside any node_modules has only its own");
	});
});

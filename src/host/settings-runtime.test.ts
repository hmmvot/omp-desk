import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkSettingsRuntime } from "./settings-runtime.ts";

const BUN = "C:\\Users\\me\\.bun\\bin\\bun.exe";
const ROOT = { root: "C:\\npm\\node_modules\\@oh-my-pi\\pi-coding-agent", version: "18.11.1", origin: "the package of the selected entry script" };
const base = { surface: "The Agents editor", instead: "Run /agents in this session's Terminal view instead." };

/** What each way of installing OMP resolves to, and what the editors can then do. */
describe("whether the Models, Agents and OMP Settings editors can read the selected OMP", () => {
	it("reads a package install, from Bun's global tree or npm's", () => {
		const entry = "C:\\npm\\node_modules\\@oh-my-pi\\pi-coding-agent\\dist\\cli.js";
		const found = checkSettingsRuntime({ ...base, executable: { command: BUN, prefixArgs: [entry], version: "18.11.1" }, bun: BUN, root: ROOT });
		assert.deepEqual(found, { ok: true, bun: BUN, root: ROOT });
	});

	it("says that a standalone program carries its code inside the executable, names it, and says what to do", () => {
		const found = checkSettingsRuntime({ ...base, executable: { command: "C:\\Users\\me\\AppData\\Local\\omp\\omp.exe", prefixArgs: [], version: "18.11.1" }, bun: null, root: null });
		assert.equal(found.ok, false);
		if (found.ok) return;
		assert.match(found.message, /^The Agents editor reads the installed OMP's TypeScript source/);
		assert.ok(found.message.includes("C:\\Users\\me\\AppData\\Local\\omp\\omp.exe, release 18.11.1"), found.message);
		assert.match(found.message, /standalone program, which carries its code inside the executable: there is no source on disk to read\./);
		assert.match(found.message, /Run \/agents in this session's Terminal view instead\./);
		assert.match(found.message, /bun install -g @oh-my-pi\/pi-coding-agent.*npm install -g @oh-my-pi\/pi-coding-agent/);
		assert.doesNotMatch(found.message, /no Bun runtime/, "a standalone program has no use for Bun, so its absence is not the reason");
	});

	it("names the entry when a package launch has no source of its release", () => {
		const entry = "C:\\npm\\node_modules\\@oh-my-pi\\pi-coding-agent\\dist\\cli.js";
		const found = checkSettingsRuntime({ ...base, executable: { command: BUN, prefixArgs: [entry], version: "18.11.1" }, bun: BUN, root: null });
		assert.equal(found.ok, false);
		if (found.ok) return;
		assert.ok(found.message.includes(`the package that holds ${entry} has no readable source of release 18.11.1`), found.message);
		assert.doesNotMatch(found.message, /standalone/);
	});

	it("says that Bun is missing, and only that, when the package is there", () => {
		const entry = "C:\\npm\\node_modules\\@oh-my-pi\\pi-coding-agent\\dist\\cli.js";
		const found = checkSettingsRuntime({ ...base, executable: { command: "C:\\npm\\bun.exe", prefixArgs: [entry], version: null }, bun: null, root: ROOT });
		assert.equal(found.ok, false);
		if (found.ok) return;
		assert.match(found.message, /no Bun runtime was found \(BUN_INSTALL, ~\/\.bun\/bin or PATH\)/);
		assert.doesNotMatch(found.message, /standalone/);
	});
});

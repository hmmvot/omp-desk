/**
 * Tests for `omp-vscode.ts`, the three places the OMP process code touches the VS Code API: the
 * explicit OMP path setting, the visible provider-login terminal and the terminal of a recorded
 * process. The module imports `vscode` (an API only the extension host provides), so it is compiled
 * here with the project's own bundler and a `vscode` stand-in, then driven through its exports.
 *
 * Runner: `node --test src/host/omp-vscode.test.ts`.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, before, beforeEach, describe, it } from "node:test";
import { build } from "esbuild";
import type {
	configuredOmpPath as configuredOmpPathType,
	findTerminalForPid as findTerminalForPidType,
	openProviderLoginTerminal as openProviderLoginTerminalType,
} from "./omp-vscode.ts";

/** The `vscode` surface this module uses, controlled through `globalThis.__vscodeStub`. */
const VSCODE_STUB = `
export const Uri = { file: (value) => ({ fsPath: value }) };
export class ThemeIcon {
  constructor(id) {
    this.id = id;
  }
}
export const window = {
  createTerminal: options => {
    const terminal = { options, shown: [], show: flag => { terminal.shown.push(flag); } };
    globalThis.__vscodeStub.created.push(terminal);
    return terminal;
  },
  get terminals() { return globalThis.__vscodeStub.terminals; },
};
export const workspace = {
  getConfiguration: section => ({ get: key => globalThis.__vscodeStub.settings[section + "." + key] }),
};
`;

interface Stub {
	settings: Record<string, unknown>;
	created: { options: Record<string, unknown>; shown: boolean[] }[];
	terminals: unknown[];
}

interface OmpVscodeModule {
	readonly configuredOmpPath: typeof configuredOmpPathType;
	readonly findTerminalForPid: typeof findTerminalForPidType;
	readonly openProviderLoginTerminal: typeof openProviderLoginTerminalType;
}

let mod: OmpVscodeModule;
let temp: string;

function stub(): Stub {
	return (globalThis as unknown as { __vscodeStub: Stub }).__vscodeStub;
}

before(async () => {
	temp = await mkdtemp(path.join(tmpdir(), "omp-vscode-"));
	const outfile = path.join(temp, "omp-vscode.mjs");
	await build({
		entryPoints: [fileURLToPath(new URL("./omp-vscode.ts", import.meta.url))],
		outfile,
		bundle: true,
		platform: "node",
		format: "esm",
		target: "node20",
		plugins: [
			{
				name: "vscode-stub",
				setup(pluginBuild) {
					pluginBuild.onResolve({ filter: /^vscode$/ }, () => ({ path: "vscode", namespace: "stub" }));
					pluginBuild.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: VSCODE_STUB, loader: "js" }));
				},
			},
		],
	});
	// The specifier is the bundle just written, so it cannot be a static import.
	mod = (await import(pathToFileURL(outfile).href)) as OmpVscodeModule;
});

beforeEach(() => {
	Reflect.set(globalThis, "__vscodeStub", { settings: {}, created: [], terminals: [] } satisfies Stub);
});

after(async () => {
	Reflect.deleteProperty(globalThis, "__vscodeStub");
	await rm(temp, { recursive: true, force: true });
});

describe("the explicit OMP path setting", () => {
	it("is the trimmed ompDesk.executablePath value", () => {
		stub().settings["ompDesk.executablePath"] = "  C:\\tools\\omp.exe  ";
		assert.equal(mod.configuredOmpPath(), "C:\\tools\\omp.exe");
	});

	it("is empty when the setting is unset or not a string, so PATH decides", () => {
		assert.equal(mod.configuredOmpPath(), "");
		stub().settings["ompDesk.executablePath"] = 7;
		assert.equal(mod.configuredOmpPath(), "");
	});

	it("is read afresh on every call", () => {
		stub().settings["ompDesk.executablePath"] = "a";
		assert.equal(mod.configuredOmpPath(), "a");
		stub().settings["ompDesk.executablePath"] = "b";
		assert.equal(mod.configuredOmpPath(), "b");
	});
});

describe("the provider-login terminal", () => {
	it("opens a visible transient terminal running the session's own OMP with the login arguments and environment", () => {
		const terminal = mod.openProviderLoginTerminal({
			args: ["login", "anthropic"],
			executable: { command: "bun", prefixArgs: ["omp.js"] },
			cwd: "C:\\work",
			env: { PI_CONFIG_FILES: "overlay" },
			name: "omp login",
		}) as unknown as { options: Record<string, unknown>; shown: boolean[] };

		assert.equal(stub().created.length, 1);
		assert.equal(terminal.options.name, "omp login");
		assert.equal(terminal.options.shellPath, "bun");
		assert.deepEqual(terminal.options.shellArgs, ["omp.js", "login", "anthropic"]);
		assert.deepEqual(terminal.options.cwd, { fsPath: "C:\\work" });
		assert.deepEqual(terminal.options.env, { PI_CONFIG_FILES: "overlay" });
		assert.equal(terminal.options.isTransient, true, "a reload must not resurrect a login command");
		assert.deepEqual(terminal.shown, [false], "shown, without taking focus");
	});
});

describe("the terminal of a recorded process", () => {
	const terminal = (processId: Promise<number | undefined>, exitStatus?: object) => ({ processId, exitStatus });

	it("is the live terminal whose pty process is exactly that pid", async () => {
		const wanted = terminal(Promise.resolve(200));
		stub().terminals = [terminal(Promise.resolve(100)), wanted, terminal(Promise.resolve(300))];
		assert.equal(await mod.findTerminalForPid(200), wanted);
	});

	it("never matches an exited terminal, an unreported pid or a rejected one, and never invents a terminal", async () => {
		stub().terminals = [
			terminal(Promise.resolve(200), { code: 0 }),
			terminal(Promise.resolve(undefined)),
			terminal(Promise.reject(new Error("no process"))),
		];
		assert.equal(await mod.findTerminalForPid(200), null);
		assert.equal(stub().created.length, 0);
	});
});

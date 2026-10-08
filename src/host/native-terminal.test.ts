/**
 * Tests for the parts of `native-terminal.ts` that need no real OMP: the
 * host-control bun flags and the stopped-session rename helper runner.
 *
 * The module imports `vscode` at runtime (an API only the extension host
 * provides) and resolves its relative imports the way esbuild does, so the test
 * runner cannot import it statically. It is compiled here with the project's own
 * bundler and a `vscode` stand-in, then driven through its exports.
 *
 * The ownership reconciler, broker probes and stop live in `rpc-reconcile.ts` and are
 * tested in `rpc-reconcile.test.ts`.
 *
 * Runner: `node --test src/host/native-terminal.test.ts`.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, before, describe, it } from "node:test";
import { build } from "esbuild";
import type {
	controlRuntimeFlags as controlRuntimeFlagsType,
	renameStoppedSessionTitle as renameStoppedSessionTitleType,
} from "./native-terminal.ts";

/** The `vscode` surface this module uses. */
const VSCODE_STUB = `
export const Uri = { file: (value) => ({ fsPath: value }) };
export class ThemeIcon {
  constructor(id) {
    this.id = id;
  }
}
export const window = {
  createTerminal: options => ({ options }),
  terminals: [],
};
`;

/** The part of the compiled module these tests drive. */
interface NativeTerminalModule {
	readonly controlRuntimeFlags: typeof controlRuntimeFlagsType;
	readonly renameStoppedSessionTitle: typeof renameStoppedSessionTitleType;
}

let native: NativeTerminalModule;
let temp: string;

before(async () => {
	temp = await mkdtemp(path.join(tmpdir(), "omp-terminal-"));
	const outfile = path.join(temp, "native-terminal.mjs");
	await build({
		entryPoints: [fileURLToPath(new URL("./native-terminal.ts", import.meta.url))],
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
	// The specifier is the bundle just written, so it cannot be a static import;
	// the module it exports is the one whose shape was compiled above.
	native = (await import(pathToFileURL(outfile).href)) as NativeTerminalModule;
});

after(async () => {
	await rm(temp, { recursive: true, force: true });
});

describe("host-control bun flags", () => {
	it("passes nothing when there is no control bootstrap", () => {
		assert.deepEqual(native.controlRuntimeFlags(null), []);
	});

	it("hands bun only the public recipient and the preload module, ahead of everything else", () => {
		const flags = native.controlRuntimeFlags({
			defineName: "OMP_CONTROL_RECIPIENT",
			publicRecipient: "recipient",
			modulePath: path.join(temp, "control.mjs"),
			directory: path.join(temp, "control"),
			slotId: "tab:one",
		});

		assert.deepEqual(flags, [
			"--define",
			'OMP_CONTROL_RECIPIENT:"recipient"',
			"--preload",
			path.join(temp, "control.mjs"),
		]);
	});
});


/**
 * The stopped-session rename runs a bounded helper under a runtime and reads one JSON
 * line back. The helper here is a Node script standing in for the Bun one: what is
 * defended is how its answer is read — a rename counts as done only when the helper
 * itself says it verified the stored title.
 */
describe("stopped-session rename helper", () => {
	async function helper(body: string): Promise<string> {
		const file = path.join(temp, `helper-${Math.random().toString(36).slice(2)}.mjs`);
		await writeFile(file, body, "utf8");
		return file;
	}

	function rename(helperPath: string, sessionId: string | null = "S-ONE") {
		return native.renameStoppedSessionTitle({
			bunPath: process.execPath,
			packageRoot: temp,
			helperPath,
			file: path.join(temp, "session.jsonl"),
			title: "New title",
			sessionId,
		});
	}

	it("reports a verified rename with the title and index state the helper read back", async () => {
		const helperPath = await helper(`
			const args = process.argv.slice(2);
			const title = args[args.indexOf("--title") + 1];
			console.log("noise before the result");
			console.log(JSON.stringify({ ok: true, verified: true, title, index: "synced", detail: "renamed" }));
		`);

		const outcome = await rename(helperPath);

		assert.deepEqual(outcome, { ok: true, verified: true, title: "New title", index: "synced", detail: "renamed" });
	});

	it("passes the expected session id to the helper only when there is one", async () => {
		const helperPath = await helper(`
			const args = process.argv.slice(2);
			const at = args.indexOf("--session-id");
			console.log(JSON.stringify({ ok: true, verified: true, title: at < 0 ? "no id" : args[at + 1], index: "unsynced" }));
		`);

		assert.equal((await rename(helperPath, "S-ONE")).title, "S-ONE");
		assert.equal((await rename(helperPath, null)).title, "no id");
	});

	it("never counts a rename the helper did not verify", async () => {
		const unverified = await rename(
			await helper(`console.log(JSON.stringify({ ok: true, verified: false, title: "New title", index: "synced" }));`),
		);
		assert.equal(unverified.ok, false);
		assert.equal(unverified.verified, false);
		assert.equal(unverified.title, null, "an unverified title is not reported as the stored one");
		assert.equal(unverified.index, "synced");

		const refused = await rename(
			await helper(`console.log(JSON.stringify({ ok: false, verified: false, detail: "the file changed" }));`),
		);
		assert.equal(refused.ok, false);
		assert.equal(refused.detail, "the file changed");
	});

	it("reports a helper that printed no result, or could not start, as unverified", async () => {
		const silent = await rename(await helper(`process.exit(3);`));
		assert.equal(silent.ok, false);
		assert.equal(silent.verified, false);
		assert.match(silent.detail ?? "", /printed no result \(exit 3\)/);

		const missing = await native.renameStoppedSessionTitle({
			bunPath: path.join(temp, "no-such-runtime"),
			packageRoot: temp,
			helperPath: path.join(temp, "unused.mjs"),
			file: path.join(temp, "session.jsonl"),
			title: "New title",
			sessionId: null,
		});
		assert.equal(missing.ok, false);
		assert.equal(missing.verified, false);
		assert.equal(missing.index, "unsynced");
	});
});

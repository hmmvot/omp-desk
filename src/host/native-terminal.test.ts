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
import { chmod, copyFile, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, before, describe, it } from "node:test";
import { build } from "esbuild";
import type {
	controlRuntimeFlags as controlRuntimeFlagsType,
	OmpBinary,
	renameStoppedSessionTitle as renameStoppedSessionTitleType,
	resolveOmpBinary as resolveOmpBinaryType,
	resolveOmpPackageRoot as resolveOmpPackageRootType,
	setOmpResolutionLog as setOmpResolutionLogType,
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
export const workspace = {
  getConfiguration: () => ({ get: () => globalThis.__ompExecutablePath }),
};
`;

/** The part of the compiled module these tests drive. */
interface NativeTerminalModule {
	readonly controlRuntimeFlags: typeof controlRuntimeFlagsType;
	readonly renameStoppedSessionTitle: typeof renameStoppedSessionTitleType;
	readonly resolveOmpBinary: typeof resolveOmpBinaryType;
	readonly resolveOmpPackageRoot: typeof resolveOmpPackageRootType;
	readonly setOmpResolutionLog: typeof setOmpResolutionLogType;
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

/**
 * Resolution walks PATH in order and keeps the first install that answers `--version`. What these
 * tests defend is what happens when a candidate does *not* answer. Each fake install is a recognised bun
 * shim (a file carrying the shim marker plus its `.bunx` metadata) that forwards to a script run by a
 * copy of Node standing in for bun, so the script decides how `--version` behaves: print a release,
 * exit non-zero, never finish, or be killed.
 */
describe("OMP resolution when a candidate cannot answer", () => {
	const isWindows = process.platform === "win32";
	const PROBE_TIMEOUT_MS = 3000;
	let tools: string;
	let installs = 0;

	before(async () => {
		tools = path.join(temp, "tools");
		await mkdir(tools, { recursive: true });
		const bun = path.join(tools, isWindows ? "bun.exe" : "bun");
		await copyFile(process.execPath, bun);
		await chmod(bun, 0o755);
	});

	/** A bun shim in its own `bin` directory whose entry script is `entrySource`. */
	async function fakeInstall(entrySource: string): Promise<{ readonly bin: string; readonly shim: string; readonly entry: string }> {
		const root = path.join(temp, `install-${installs++}`);
		const bin = path.join(root, "bin");
		await mkdir(bin, { recursive: true });
		const shim = path.join(bin, isWindows ? "omp.exe" : "omp");
		await writeFile(shim, "bun_shim_impl");
		await chmod(shim, 0o755);
		await writeFile(path.join(bin, "omp.bunx"), Buffer.from('"entry.js"', "utf16le"));
		const entry = path.join(root, "entry.js");
		await writeFile(entry, entrySource);
		return { bin, shim, entry };
	}

	/** A PATH entry holding an `omp` that is neither OMP's program nor a bun shim. */
	async function foreignLauncher(): Promise<{ readonly bin: string; readonly file: string }> {
		const bin = path.join(temp, `foreign-${installs++}`);
		await mkdir(bin, { recursive: true });
		const file = path.join(bin, isWindows ? "omp.exe" : "omp");
		await writeFile(file, "an unrelated launcher");
		await chmod(file, 0o755);
		return { bin, file };
	}

	const prints = (release: string): string => `console.log("omp/${release}");`;
	const NEVER_ANSWERS = "setInterval(() => {}, 1000);";

	/** Run `action` with exactly `dirs` (then the bun copy) on PATH and no launcher directory. */
	async function onPath<T>(dirs: readonly string[], action: () => Promise<T>): Promise<T> {
		const saved = { PATH: process.env.PATH, LOCALAPPDATA: process.env.LOCALAPPDATA };
		process.env.PATH = [...dirs, tools].join(path.delimiter);
		process.env.LOCALAPPDATA = path.join(temp, "no-local-app-data");
		try {
			return await action();
		} finally {
			for (const [name, value] of Object.entries(saved)) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
		}
	}

	const resolve = (): Promise<OmpBinary> => native.resolveOmpBinary({ probeTimeoutMs: PROBE_TIMEOUT_MS });

	/** The error a refused resolution throws, with the field the classification reads. */
	type ResolutionError = Error & { readonly transientCause?: string };

	async function refused(): Promise<ResolutionError> {
		try {
			await resolve();
		} catch (error) {
			assert.ok(error instanceof Error, "a refused resolution throws an Error");
			return error as ResolutionError;
		}
		return assert.fail("the resolution was expected to be refused");
	}

	it("does not fall through to a lower candidate when the first one's probe times out", async () => {
		const lower = path.join(temp, `lower-ran-${installs}`);
		const slow = await fakeInstall(NEVER_ANSWERS);
		const older = await fakeInstall(`require("node:fs").writeFileSync(${JSON.stringify(lower)}, "ran"); ${prints("18.0.4")}`);

		const error = await onPath([slow.bin, older.bin], refused);

		assert.equal(error.transientCause, "did not finish within 3 s");
		assert.ok(error.message.includes(`\`omp --version\` of ${slow.shim} did not finish within 3 s; Desk does not fall back to another OMP`), error.message);
		await assert.rejects(stat(lower), "the lower-priority install must not even be probed");
	});

	it("takes the first install that answers, and never looks at a later one for the answer", async () => {
		const first = await fakeInstall(prints("18.8.5"));
		const second = await fakeInstall(prints("18.0.4"));

		const resolved = await onPath([first.bin, second.bin], resolve);

		assert.deepEqual(resolved.prefixArgs, [first.entry]);
		assert.equal(resolved.version, "18.8.5");
	});

	it("falls through to the next install when a candidate exits non-zero (a definitive refusal)", async () => {
		const broken = await fakeInstall(`process.stderr.write("cannot start\\n"); process.exit(3);`);
		const working = await fakeInstall(prints("18.8.5"));

		const resolved = await onPath([broken.bin, working.bin], resolve);

		assert.deepEqual(resolved.prefixArgs, [working.entry]);
		assert.equal(resolved.version, "18.8.5");
	});

	it("falls through a foreign launcher, which is refused without being started", async () => {
		const foreign = await foreignLauncher();
		const working = await fakeInstall(prints("18.8.5"));

		const resolved = await onPath([foreign.bin, working.bin], resolve);

		assert.deepEqual(resolved.prefixArgs, [working.entry]);
	});

	it("reports a resolution where every candidate was refused as definitive, with each reason", async () => {
		const foreign = await foreignLauncher();
		const broken = await fakeInstall(`process.exit(2);`);

		const error = await onPath([foreign.bin, broken.bin], refused);

		assert.equal(error.transientCause, undefined);
		assert.match(error.message, /No usable OMP launcher was found\./);
		assert.ok(error.message.includes(foreign.file), error.message);
		assert.match(error.message, /exited with code 2/);
	});

	it("stops at a transient failure even after an earlier definitive refusal, and still lists that refusal", async () => {
		const foreign = await foreignLauncher();
		const slow = await fakeInstall(NEVER_ANSWERS);
		const older = await fakeInstall(prints("18.0.4"));

		const error = await onPath([foreign.bin, slow.bin, older.bin], refused);

		assert.equal(error.transientCause, "did not finish within 3 s");
		assert.ok(error.message.includes(slow.shim), error.message);
		assert.ok(error.message.includes(foreign.file), "the earlier refusal is still listed");
	});

	it("treats a probe killed by a signal as transient", { skip: isWindows && "Windows reports no signal for a killed process" }, async () => {
		const killed = await fakeInstall(`process.kill(process.pid, "SIGKILL"); setInterval(() => {}, 1000);`);
		const older = await fakeInstall(prints("18.0.4"));

		const error = await onPath([killed.bin, older.bin], refused);

		assert.equal(error.transientCause, "was killed by SIGKILL before it answered");
	});

	it("logs once per window, with both paths and releases, that two installs are on PATH", async () => {
		const current = await fakeInstall(prints("18.8.5"));
		const older = await fakeInstall(prints("18.0.4"));
		const lines: string[] = [];
		const logged = Promise.withResolvers<string>();
		native.setOmpResolutionLog(line => {
			lines.push(line);
			logged.resolve(line);
		});
		try {
			await onPath([current.bin, older.bin], async () => {
				// A Test of the PATH search (the Settings view's Test button) must not spend the window's one report: if it did,
				// the real resolution below would log nothing and this test would never see its line.
				assert.equal((await resolveExplicit("")).version, "18.8.5");
				const first = await resolve();
				assert.equal(first.version, "18.8.5", "the log changes nothing about what is selected");
				const line = await logged.promise;
				assert.ok(line.includes(`${current.shim} (release 18.8.5, in use)`), line);
				assert.ok(line.includes(`${older.shim} (release 18.0.4, not used)`), line);
				await resolve();
			});
			// A second line could only come from a probe that is still running in the background, so a
			// deterministic signal for "never" does not exist; a short real wait is the test.
			await new Promise(done => setTimeout(done, 300));
			assert.equal(lines.length, 1);
		} finally {
			native.setOmpResolutionLog(null);
		}
	});

	const resolveExplicit = (explicitPath: string): Promise<OmpBinary> =>
		native.resolveOmpBinary({ probeTimeoutMs: PROBE_TIMEOUT_MS, explicitPath });

	async function refusedExplicit(explicitPath: string): Promise<ResolutionError> {
		try {
			await resolveExplicit(explicitPath);
		} catch (error) {
			assert.ok(error instanceof Error, "a refused resolution throws an Error");
			return error as ResolutionError;
		}
		return assert.fail("the resolution was expected to be refused");
	}

	it("runs the OMP named by the explicit path even when PATH offers another one first", async () => {
		const onPathFirst = await fakeInstall(prints("18.0.4"));
		const named = await fakeInstall(prints("18.8.5"));

		const resolved = await onPath([onPathFirst.bin], () => resolveExplicit(named.shim));

		assert.deepEqual(resolved.prefixArgs, [named.entry]);
		assert.equal(resolved.version, "18.8.5");
		assert.ok(resolved.origin.includes(named.shim), resolved.origin);
	});

	it("reads the explicit path from the omp.executablePath setting when none is passed, and an empty one means PATH", async () => {
		const onPathFirst = await fakeInstall(prints("18.0.4"));
		const named = await fakeInstall(prints("18.8.5"));
		Reflect.set(globalThis, "__ompExecutablePath", `  ${named.shim}  `);
		try {
			const viaSetting = await onPath([onPathFirst.bin], resolve);
			assert.equal(viaSetting.version, "18.8.5", "the setting names the OMP, trimmed");
			const viaEmpty = await onPath([onPathFirst.bin], () => resolveExplicit(""));
			assert.equal(viaEmpty.version, "18.0.4", "an empty path is the PATH search");
		} finally {
			Reflect.deleteProperty(globalThis, "__ompExecutablePath");
		}
	});

	it("never falls back to PATH when the explicit OMP is refused, and says which setting named it", async () => {
		const ran = path.join(temp, `path-install-ran-${installs}`);
		const onPathInstall = await fakeInstall(`require("node:fs").writeFileSync(${JSON.stringify(ran)}, "ran"); ${prints("18.0.4")}`);
		const broken = await fakeInstall(`process.exit(3);`);

		const error = await onPath([onPathInstall.bin], () => refusedExplicit(broken.shim));

		assert.equal(error.transientCause, undefined);
		assert.ok(error.message.includes(`The OMP named by the omp.executablePath setting (${broken.shim}) cannot be used.`), error.message);
		assert.match(error.message, /exited with code 3/);
		assert.match(error.message, /Desk does not search PATH while that setting is set/);
		await assert.rejects(stat(ran), "the PATH install must not even be probed");
	});

	it("does not fall back to PATH when the explicit OMP's probe times out either", async () => {
		const onPathInstall = await fakeInstall(prints("18.0.4"));
		const slow = await fakeInstall(NEVER_ANSWERS);

		const error = await onPath([onPathInstall.bin], () => refusedExplicit(slow.shim));

		assert.equal(error.transientCause, "did not finish within 3 s");
		assert.ok(error.message.includes(`\`omp --version\` of ${slow.shim} did not finish within 3 s; Desk does not fall back to another OMP`), error.message);
	});

	it("refuses an explicit path that is not absolute, does not exist, or is a foreign launcher", async () => {
		const onPathInstall = await fakeInstall(prints("18.0.4"));
		const foreign = await foreignLauncher();

		await onPath([onPathInstall.bin], async () => {
			assert.match((await refusedExplicit("omp")).message, /omp is not an absolute path/);
			const missing = path.join(temp, "nowhere", isWindows ? "omp.exe" : "omp");
			assert.ok((await refusedExplicit(missing)).message.includes(`${missing} does not exist or is not a runnable file`));
			const foreignError = await refusedExplicit(foreign.file);
			assert.ok(foreignError.message.includes(`${foreign.file} is neither OMP's own program nor a recognised bun shim`), foreignError.message);
		});
	});
});

/**
 * The package source of the selected OMP is the package that holds the entry script the launch runs.
 * A lookup that cannot find it says so; it never borrows another install's package from a global
 * location, which is what lets the inventory, the settings editors and the rename read another OMP's code.
 */
describe("package source of the selected OMP", () => {
	let packages = 0;

	/** `<root>/install/global/node_modules/@oh-my-pi/pi-coding-agent` with a manifest and the storage module. */
	async function installPackage(version: string): Promise<{ readonly root: string; readonly entry: string }> {
		const root = path.join(temp, `pkg-${packages++}`, "install", "global", "node_modules", "@oh-my-pi", "pi-coding-agent");
		await mkdir(path.join(root, "src", "session"), { recursive: true });
		await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-coding-agent", version }));
		await writeFile(path.join(root, "src", "session", "session-storage.ts"), "export {};");
		const entry = path.join(root, "src", "cli.ts");
		await writeFile(entry, "export {};");
		return { root, entry };
	}

	const launch = (entry: string, version: string | null) => ({ command: path.join(temp, "bun.exe"), prefixArgs: [entry], version });

	it("is the package that holds the entry the launch runs", async () => {
		const own = await installPackage("18.8.5");

		const found = await native.resolveOmpPackageRoot(launch(own.entry, "18.8.5"));

		assert.equal(found?.root, own.root);
		assert.equal(found?.version, "18.8.5");
	});

	it("is not borrowed from a global location when the entry's own package cannot be found", async () => {
		const elsewhere = await installPackage("18.8.5");
		const orphanEntry = path.join(temp, "orphan", "src", "cli.ts");
		await mkdir(path.dirname(orphanEntry), { recursive: true });
		await writeFile(orphanEntry, "export {};");
		const saved = process.env.BUN_INSTALL;
		process.env.BUN_INSTALL = path.resolve(elsewhere.root, "..", "..", "..", "..");
		try {
			assert.equal(await native.resolveOmpPackageRoot(launch(orphanEntry, "18.8.5")), null);
		} finally {
			if (saved === undefined) delete process.env.BUN_INSTALL;
			else process.env.BUN_INSTALL = saved;
		}
	});

	it("is null for a compiled executable, even when a global install of the same release exists", async () => {
		const elsewhere = await installPackage("18.8.5");
		const saved = process.env.BUN_INSTALL;
		process.env.BUN_INSTALL = path.resolve(elsewhere.root, "..", "..", "..", "..");
		try {
			const compiled = { command: path.join(temp, "omp.exe"), prefixArgs: [], version: "18.8.5" };
			assert.equal(await native.resolveOmpPackageRoot(compiled), null, "a compiled program has no importable source of its own");
		} finally {
			if (saved === undefined) delete process.env.BUN_INSTALL;
			else process.env.BUN_INSTALL = saved;
		}
	});

	it("refuses a package whose release is not the release the selected launch reported", async () => {
		const own = await installPackage("18.0.4");

		assert.equal(await native.resolveOmpPackageRoot(launch(own.entry, "18.8.5")), null);
		assert.equal((await native.resolveOmpPackageRoot(launch(own.entry, null)))?.root, own.root, "no reported release, nothing to compare");
	});
});

/**
 * Tests for the parts of `native-terminal.ts` that need no real OMP: the
 * host-control bun flags and the stopped-session rename helper runner.
 *
 * The module resolves its relative imports the way esbuild does (extensionless specifiers), so
 * the test runner cannot import it statically: it is compiled here with the project's own
 * bundler and driven through its exports. It imports no `vscode`.
 *
 * The ownership reconciler, broker probes and stop live in `rpc-reconcile.ts` and are
 * tested in `rpc-reconcile.test.ts`.
 *
 * Runner: `node --test src/host/native-terminal.test.ts`.
 */
import assert from "node:assert/strict";
import { appendFile, chmod, copyFile, mkdir, mkdtemp, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, before, describe, it } from "node:test";
import { build } from "esbuild";
import { recordingLogger, type LoggedLine } from "../shared/logger.ts";
import type {
	OmpBinary,
	renameStoppedSessionTitle as renameStoppedSessionTitleType,
	resolveOmpBinary as resolveOmpBinaryType,
	resolveOmpPackageRoot as resolveOmpPackageRootType,
	setOmpPathReader as setOmpPathReaderType,
	setOmpResolutionLog as setOmpResolutionLogType,
} from "./native-terminal.ts";

/** The part of the compiled module these tests drive. */
interface NativeTerminalModule {
	readonly renameStoppedSessionTitle: typeof renameStoppedSessionTitleType;
	readonly resolveOmpBinary: typeof resolveOmpBinaryType;
	readonly resolveOmpPackageRoot: typeof resolveOmpPackageRootType;
	readonly setOmpPathReader: typeof setOmpPathReaderType;
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
	});
	// The specifier is the bundle just written, so it cannot be a static import;
	// the module it exports is the one whose shape was compiled above.
	native = (await import(pathToFileURL(outfile).href)) as NativeTerminalModule;
});

after(async () => {
	await rm(temp, { recursive: true, force: true });
});

/**
 * A stand-in for Bun's own runtime: a copy of the test runner with the strings a real Bun carries (its JavaScript engine) appended,
 * which is what the resolver judges a runtime by. It starts and answers like the runner, so the entry scripts below decide the output.
 */
async function fakeBun(file: string): Promise<void> {
	await copyFile(process.execPath, file);
	await chmod(file, 0o755);
	await appendFile(file, "\nJavaScriptCore oven-sh/bun\n");
}


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
	/**
	 * Two bounds, because the tests ask two different things. A candidate that never answers is waited for this long: any bound
	 * would do, a longer one only slows the test, and the message under test names it ("3 s").
	 */
	const HANG_BOUND_MS = 3000;
	/**
	 * A candidate that answers, or exits with a refusal, is waited for as long as a busy machine needs to start a process and
	 * has it say so; the bound only has to be reached by a candidate that is stuck, so how fast the machine is cannot decide a test.
	 */
	const ANSWER_BOUND_MS = 120_000;
	let tools: string;
	let installs = 0;

	before(async () => {
		tools = path.join(temp, "tools");
		await mkdir(tools, { recursive: true });
		const bun = path.join(tools, isWindows ? "bun.exe" : "bun");
		await fakeBun(bun);
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

	const resolve = (probeTimeoutMs = ANSWER_BOUND_MS): Promise<OmpBinary> => native.resolveOmpBinary({ probeTimeoutMs });

	/** The error a refused resolution throws, with the field the classification reads. */
	type ResolutionError = Error & { readonly transientCause?: string };

	async function refused(probeTimeoutMs = ANSWER_BOUND_MS): Promise<ResolutionError> {
		try {
			await resolve(probeTimeoutMs);
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

		const error = await onPath([slow.bin, older.bin], () => refused(HANG_BOUND_MS));

		assert.equal(error.transientCause, "did not finish within 3 s");
		assert.ok(error.message.includes(`\`omp --version\` of ${slow.shim} did not finish within 3 s; Desk does not fall back to another OMP`), error.message);
		await assert.rejects(stat(lower), "the lower-priority install must not even be probed");
	});

	/** The package manifest of an install's own OMP package, beside its entry script. */
	async function withManifest(install: { readonly entry: string }, manifest: Record<string, unknown>): Promise<void> {
		await writeFile(path.join(path.dirname(install.entry), "package.json"), JSON.stringify(manifest));
	}

	it("reads a bun shim's release from its package and starts no process to ask, so a busy machine cannot time it out", async () => {
		const marker = path.join(temp, `shim-probed-${installs}`);
		const install = await fakeInstall(`require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran"); ${NEVER_ANSWERS}`);
		await withManifest(install, { name: "@oh-my-pi/pi-coding-agent", version: "18.8.5" });

		const binary = await onPath([install.bin], resolve);

		assert.equal(binary.version, "18.8.5");
		assert.equal(binary.launcher, "bun-shim");
		assert.equal(binary.prefixArgs.at(-1), install.entry);
		await assert.rejects(stat(marker), "the entry script was never run to ask for its version");
	});

	it("keeps asking a bun shim whose package gives no release, and takes the program's own answer for a standalone launcher", async () => {
		const noRelease = await fakeInstall(prints("18.7.1"));
		await withManifest(noRelease, { name: "@oh-my-pi/pi-coding-agent" });
		assert.equal((await onPath([noRelease.bin], resolve)).version, "18.7.1");

		const otherPackage = await fakeInstall(prints("18.6.0"));
		await withManifest(otherPackage, { name: "some-other-package", version: "1.0.0" });
		assert.equal((await onPath([otherPackage.bin], resolve)).version, "18.6.0", "a manifest that is not OMP's names nothing");

		const slow = await fakeInstall(NEVER_ANSWERS);
		await withManifest(slow, { name: "@oh-my-pi/pi-coding-agent" });
		const error = await onPath([slow.bin], () => refused(HANG_BOUND_MS));
		assert.equal(error.transientCause, "did not finish within 3 s", "the question, when it is still asked, keeps its transient timeout");
	});

	it("takes the first install that answers, and never looks at a later one for the answer", async () => {
		const first = await fakeInstall(prints("18.8.5"));
		const second = await fakeInstall(prints("18.0.4"));

		const resolved = await onPath([first.bin, second.bin], resolve);

		assert.deepEqual(resolved.prefixArgs, [first.entry]);
		assert.equal(resolved.launcher, "bun-shim", "a bun shim runs as Bun's own CLI, which takes Bun's flags on its command line");
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

	it("classifies OMP's own compiled program as `program`, which has no command line for Bun's flags", async () => {
		// What the file carries, not what it is called, makes it OMP's program: OMP's identity plus an embedded
		// JavaScript engine. A copy of the test runner with both markers appended answers `--version` like one.
		const bin = path.join(temp, `program-${installs++}`);
		await mkdir(bin, { recursive: true });
		const program = path.join(bin, isWindows ? "omp.exe" : "omp");
		await copyFile(path.join(tools, isWindows ? "bun.exe" : "bun"), program);
		await chmod(program, 0o755);
		await appendFile(program, "\n@oh-my-pi/pi-coding-agent JavaScriptCore oven-sh/bun\n");

		const resolved = await onPath([bin], resolve);

		assert.equal(resolved.command, program);
		assert.deepEqual(resolved.prefixArgs, []);
		assert.equal(resolved.launcher, "program");
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

		const error = await onPath([foreign.bin, slow.bin, older.bin], () => refused(HANG_BOUND_MS));

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
		const lines: LoggedLine[] = [];
		const logged = Promise.withResolvers<LoggedLine>();
		const recorder = recordingLogger(lines);
		native.setOmpResolutionLog({
			...recorder,
			info: message => {
				recorder.info(message);
				logged.resolve(lines.at(-1)!);
			},
		});
		try {
			await onPath([current.bin, older.bin], async () => {
				// A Test of the PATH search (the Settings view's Test button) must not spend the window's one report: if it did,
				// the real resolution below would log nothing and this test would never see its line.
				assert.equal((await resolveExplicit("")).version, "18.8.5");
				const first = await resolve();
				assert.equal(first.version, "18.8.5", "the log changes nothing about what is selected");
				const line = await logged.promise;
				assert.equal(line.level, "info");
				assert.ok(line.message.includes(`${current.shim} (release 18.8.5, in use)`), line.message);
				assert.ok(line.message.includes(`${older.shim} (release 18.0.4, not used)`), line.message);
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

	const resolveExplicit = (explicitPath: string, probeTimeoutMs = ANSWER_BOUND_MS): Promise<OmpBinary> =>
		native.resolveOmpBinary({ probeTimeoutMs, explicitPath });

	async function refusedExplicit(explicitPath: string, probeTimeoutMs = ANSWER_BOUND_MS): Promise<ResolutionError> {
		try {
			await resolveExplicit(explicitPath, probeTimeoutMs);
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

	it("reads the explicit path from the registered reader on every resolution, and an empty one means PATH", async () => {
		const onPathFirst = await fakeInstall(prints("18.0.4"));
		const named = await fakeInstall(prints("18.8.5"));
		const other = await fakeInstall(prints("18.9.0"));
		let setting = `  ${named.shim}  `;
		native.setOmpPathReader(() => setting);
		try {
			const viaSetting = await onPath([onPathFirst.bin], resolve);
			assert.equal(viaSetting.version, "18.8.5", "the setting names the OMP, trimmed");
			setting = other.shim;
			const changed = await onPath([onPathFirst.bin], resolve);
			assert.equal(changed.version, "18.9.0", "a changed setting is read by the next resolution");
			const viaEmpty = await onPath([onPathFirst.bin], () => resolveExplicit(""));
			assert.equal(viaEmpty.version, "18.0.4", "an empty path is the PATH search");
			setting = "";
			const cleared = await onPath([onPathFirst.bin], resolve);
			assert.equal(cleared.version, "18.0.4", "a cleared setting is the PATH search");
		} finally {
			native.setOmpPathReader(null);
		}
		const withoutReader = await onPath([onPathFirst.bin], resolve);
		assert.equal(withoutReader.version, "18.0.4", "without a registered reader PATH decides");
	});

	it("never falls back to PATH when the explicit OMP is refused, and says which setting named it", async () => {
		const ran = path.join(temp, `path-install-ran-${installs}`);
		const onPathInstall = await fakeInstall(`require("node:fs").writeFileSync(${JSON.stringify(ran)}, "ran"); ${prints("18.0.4")}`);
		const broken = await fakeInstall(`process.exit(3);`);

		const error = await onPath([onPathInstall.bin], () => refusedExplicit(broken.shim));

		assert.equal(error.transientCause, undefined);
		assert.ok(error.message.includes(`The OMP named by the ompDesk.executablePath setting (${broken.shim}) cannot be used.`), error.message);
		assert.match(error.message, /exited with code 3/);
		assert.match(error.message, /Desk does not search PATH while that setting is set/);
		await assert.rejects(stat(ran), "the PATH install must not even be probed");
	});

	it("does not fall back to PATH when the explicit OMP's probe times out either", async () => {
		const onPathInstall = await fakeInstall(prints("18.0.4"));
		const slow = await fakeInstall(NEVER_ANSWERS);

		const error = await onPath([onPathInstall.bin], () => refusedExplicit(slow.shim, HANG_BOUND_MS));

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

/**
 * `npm install -g @oh-my-pi/pi-coding-agent` lays the package out under the npm prefix and writes `omp.cmd` beside the
 * global `node_modules` (the file text below is what npm 11 wrote for OMP 18.11.1; the entry's `#!/usr/bin/env bun` line
 * makes it start `bun`). The package's own dependencies are nested inside it, not beside it as Bun's global install has them.
 */
describe("an npm global install of OMP", { skip: process.platform !== "win32" && "npm's .cmd launcher is a Windows file" }, () => {
	const NPM_CMD = [
		"@ECHO off", "GOTO start", ":find_dp0", "SET dp0=%~dp0", "EXIT /b", ":start", "SETLOCAL", "CALL :find_dp0", "",
		'IF EXIST "%dp0%\\bun.exe" (', '  SET "_prog=%dp0%\\bun.exe"', ") ELSE (", '  SET "_prog=bun"', "  SET PATHEXT=%PATHEXT:;.JS;=;%", ")", "",
		'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@oh-my-pi\\pi-coding-agent\\dist\\cli.js" %*', "",
	].join("\r\n");
	let installs = 0;
	let tools: string;

	before(async () => {
		tools = path.join(temp, "npm-tools");
		await mkdir(tools, { recursive: true });
		await fakeBun(path.join(tools, "bun.exe"));
	});

	/** An npm prefix: `omp.cmd`, `omp`, and the package with the manifest, entry, storage module and nested dependencies. */
	async function npmPrefix(options: { readonly cmd?: string; readonly name?: string; readonly version?: string } = {}): Promise<{ readonly prefix: string; readonly root: string; readonly entry: string }> {
		const prefix = path.join(temp, `npm-${installs++}`);
		const root = path.join(prefix, "node_modules", "@oh-my-pi", "pi-coding-agent");
		await mkdir(path.join(root, "dist"), { recursive: true });
		await mkdir(path.join(root, "src", "session"), { recursive: true });
		await writeFile(path.join(root, "package.json"), JSON.stringify({ name: options.name ?? "@oh-my-pi/pi-coding-agent", version: options.version ?? "18.11.1" }));
		await writeFile(path.join(root, "src", "session", "session-storage.ts"), "export {};");
		const entry = path.join(root, "dist", "cli.js");
		await writeFile(entry, "#!/usr/bin/env bun\nconsole.log('omp/18.11.1');\n");
		await writeFile(path.join(prefix, "omp.cmd"), options.cmd ?? NPM_CMD);
		await writeFile(path.join(prefix, "omp"), "#!/bin/sh\nexec bun \"$basedir/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js\" \"$@\"\n");
		return { prefix, root, entry };
	}

	async function withPath<T>(dirs: readonly string[], action: () => Promise<T>): Promise<T> {
		const saved = { PATH: process.env.PATH, LOCALAPPDATA: process.env.LOCALAPPDATA };
		process.env.PATH = dirs.join(path.delimiter);
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

	it("resolves omp.cmd to Bun running the package's entry, as Bun's own CLI, with the release from the manifest", async () => {
		const install = await npmPrefix();

		const resolved = await withPath([install.prefix, tools], () => native.resolveOmpBinary());

		assert.equal(resolved.command, path.join(tools, "bun.exe"), "bun.exe from PATH, as the launcher itself picks it when none sits beside it");
		assert.deepEqual(resolved.prefixArgs, [install.entry]);
		assert.equal(resolved.launcher, "bun-shim", "no shell and no process layer: the launch is Bun running the entry");
		assert.equal(resolved.version, "18.11.1");
		assert.match(resolved.origin, /the package-manager shim .*omp\.cmd, resolved to /);
	});

	it("prefers the bun.exe the launcher finds beside itself", async () => {
		const install = await npmPrefix();
		await fakeBun(path.join(install.prefix, "bun.exe"));

		const resolved = await withPath([install.prefix, tools], () => native.resolveOmpBinary());

		assert.equal(resolved.command, path.join(install.prefix, "bun.exe"));
	});

	it("finds the package source of that launch, which is the package inside the npm prefix", async () => {
		const install = await npmPrefix();

		const resolved = await withPath([install.prefix, tools], () => native.resolveOmpBinary());
		const found = await native.resolveOmpPackageRoot(resolved);

		assert.equal(found?.root, install.root);
		assert.equal(found?.version, "18.11.1");
	});

	it("still refuses a .cmd that is not OMP's launcher, with the reason, and never starts it", async () => {
		const node = await npmPrefix({ cmd: NPM_CMD.replace(/_prog=(%dp0%\\)?bun(\.exe)?/g, "_prog=$1node$2") });
		const other = await npmPrefix({ name: "some-other-package" });

		for (const install of [node, other]) {
			await withPath([install.prefix, tools], async () => {
				await assert.rejects(native.resolveOmpBinary(), /omp\.cmd is a script launcher|omp\.cmd is a package-manager shim/);
			});
		}
	});

	it("says so when Bun is nowhere to be found, instead of starting the launcher's shell", async () => {
		const install = await npmPrefix();

		await withPath([install.prefix], async () => {
			await assert.rejects(native.resolveOmpBinary(), /omp\.cmd is a package-manager shim, but no bun runtime was found beside it in .* or on PATH/);
		});
	});
});

/**
 * `pnpm add -g` (pnpm 12.14), `yarn global add` (Yarn 1.22) and `volta install` (Volta 2.0.2) of OMP 18.11.1, laid out as they wrote it.
 * Their `.cmd` launchers differ from npm's in text (they name the entry as `%~dp0\<entry>` and pick `bun.exe` beside them, else `bun`),
 * and each has its own layout: pnpm names a link in its global folder that points into `.pnpm`; Yarn's launcher in the prefix folder
 * only forwards to the one in `global\node_modules\.bin`; Volta's launcher in `bin` only runs `volta run`, and the package is in its image.
 */
describe("a pnpm, Yarn or Volta global install of OMP", { skip: process.platform !== "win32" && "the .cmd launchers are Windows files" }, () => {
	const entryLine = (entry: string): string => [
		'@IF EXIST "%~dp0\\bun.exe" (', `  "%~dp0\\bun.exe"  "%~dp0\\${entry}" %*`, ") ELSE (", "  @SET PATHEXT=%PATHEXT:;.JS;=;%", `  bun  "%~dp0\\${entry}" %*`, ")",
	].join("\r\n");
	let installs = 0;
	let tools: string;

	before(async () => {
		tools = path.join(temp, "pm-tools");
		await mkdir(tools, { recursive: true });
		await fakeBun(path.join(tools, "bun.exe"));
	});

	async function withPath<T>(dirs: readonly string[], action: () => Promise<T>): Promise<T> {
		const saved = { PATH: process.env.PATH, LOCALAPPDATA: process.env.LOCALAPPDATA };
		process.env.PATH = dirs.join(path.delimiter);
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

	async function ompPackage(root: string, name = "@oh-my-pi/pi-coding-agent"): Promise<string> {
		await mkdir(path.join(root, "dist"), { recursive: true });
		await mkdir(path.join(root, "src", "session"), { recursive: true });
		await writeFile(path.join(root, "package.json"), JSON.stringify({ name, version: "18.11.1" }));
		await writeFile(path.join(root, "src", "session", "session-storage.ts"), "export {};");
		await writeFile(path.join(root, "dist", "cli.js"), "#!/usr/bin/env bun\nconsole.log('omp/18.11.1');\n");
		return path.join(root, "dist", "cli.js");
	}

	/** pnpm: `<home>\bin\omp.cmd`, the link `<home>\global\v11\<hash>\node_modules\@oh-my-pi\pi-coding-agent` into the `.pnpm` store. */
	async function pnpmInstall(): Promise<{ readonly bin: string; readonly linked: string }> {
		const home = path.join(temp, `pnpm-${installs++}`);
		const hash = "3e5fe99b04406cd92878c275b37358555616dbfcc1b71cc932943dd1e40da552";
		const real = path.join(home, "global", "v11", "cec8-18df1fcd5ba644ac-0", "node_modules", ".pnpm", "@oh-my-pi+pi-coding-agent@18.11.1_@types+node@26.6.5", "node_modules", "@oh-my-pi", "pi-coding-agent");
		await ompPackage(real);
		const linked = path.join(home, "global", "v11", hash, "node_modules", "@oh-my-pi", "pi-coding-agent");
		await mkdir(path.dirname(linked), { recursive: true });
		await symlink(real, linked, "junction");
		const bin = path.join(home, "bin");
		await mkdir(bin, { recursive: true });
		await writeFile(path.join(bin, "omp.cmd"), `@SETLOCAL\r\n${entryLine(`..\\global\\v11\\${hash}\\node_modules\\@oh-my-pi\\pi-coding-agent\\dist\\cli.js`)}\r\n`);
		return { bin, linked };
	}

	/** Yarn: `<prefix>\bin\omp.cmd` forwards to `<global>\node_modules\.bin\omp.cmd`, which names the entry in the flat tree. */
	async function yarnInstall(): Promise<{ readonly prefixBin: string; readonly dotBin: string; readonly root: string }> {
		const home = path.join(temp, `yarn-${installs++}`);
		const root = path.join(home, "global", "node_modules", "@oh-my-pi", "pi-coding-agent");
		await ompPackage(root);
		const dotBin = path.join(home, "global", "node_modules", ".bin");
		await mkdir(dotBin, { recursive: true });
		await writeFile(path.join(dotBin, "omp.cmd"), entryLine("..\\@oh-my-pi\\pi-coding-agent\\dist\\cli.js"));
		const prefixBin = path.join(home, "prefix", "bin");
		await mkdir(prefixBin, { recursive: true });
		await writeFile(path.join(prefixBin, "omp.cmd"), '@"%~dp0\\..\\..\\global\\node_modules\\.bin\\omp.cmd"   %*\r\n');
		return { prefixBin, dotBin, root };
	}

	it("resolves pnpm's omp.cmd to Bun running the entry through its link, with the release from the manifest", async () => {
		const install = await pnpmInstall();

		const resolved = await withPath([install.bin, tools], () => native.resolveOmpBinary());

		assert.equal(resolved.launcher, "bun-shim");
		assert.deepEqual(resolved.prefixArgs, [path.join(install.linked, "dist", "cli.js")]);
		assert.equal(resolved.version, "18.11.1");
		assert.equal((await native.resolveOmpPackageRoot(resolved))?.root, install.linked);
	});

	it("resolves Yarn's launcher in the prefix folder by following its forward, and its own .bin launcher directly", async () => {
		const install = await yarnInstall();
		const entry = path.join(install.root, "dist", "cli.js");

		for (const dir of [install.prefixBin, install.dotBin]) {
			const resolved = await withPath([dir, tools], () => native.resolveOmpBinary());
			assert.deepEqual(resolved.prefixArgs, [entry], dir);
			assert.equal(resolved.launcher, "bun-shim", dir);
		}
		assert.equal((await native.resolveOmpPackageRoot(await withPath([install.prefixBin, tools], () => native.resolveOmpBinary())))?.root, install.root);
	});

	/**
	 * Volta 2.0.2: `<home>\bin\omp.cmd` is `volta run omp`; the package is in `<home>\tools\image\packages\@oh-my-pi\pi-coding-agent`
	 * with an npm-style launcher beside a nested npm layout; `<home>\tools\user\bins\omp.json` names the package.
	 */
	async function voltaInstall(packageName = "@oh-my-pi/pi-coding-agent"): Promise<{ readonly bin: string; readonly entry: string }> {
		const home = path.join(temp, `volta-${installs++}`);
		const image = path.join(home, "tools", "image", "packages", "@oh-my-pi", "pi-coding-agent");
		const entry = await ompPackage(path.join(image, "node_modules", "@oh-my-pi", "pi-coding-agent"));
		await writeFile(path.join(image, "omp.cmd"), [
			"@ECHO off", "GOTO start", ":find_dp0", "SET dp0=%~dp0", "EXIT /b", ":start", "SETLOCAL", "CALL :find_dp0", "",
			'IF EXIST "%dp0%\\bun.exe" (', '  SET "_prog=%dp0%\\bun.exe"', ") ELSE (", '  SET "_prog=bun"', "  SET PATHEXT=%PATHEXT:;.JS;=;%", ")", "",
			'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@oh-my-pi\\pi-coding-agent\\dist\\cli.js" %*', "",
		].join("\r\n"));
		await mkdir(path.join(home, "tools", "user", "bins"), { recursive: true });
		await writeFile(path.join(home, "tools", "user", "bins", "omp.json"), JSON.stringify({ name: "omp", package: packageName, version: "18.11.1", manager: "Npm" }));
		const bin = path.join(home, "bin");
		await mkdir(bin, { recursive: true });
		await writeFile(path.join(bin, "omp.cmd"), "@echo off\r\nvolta run %~n0 %*\r\n");
		return { bin, entry };
	}

	it("resolves Volta's omp.cmd, which only runs `volta run`, to Bun running the package in Volta's image", async () => {
		const install = await voltaInstall();

		const resolved = await withPath([install.bin, tools], () => native.resolveOmpBinary());

		assert.equal(resolved.launcher, "bun-shim");
		assert.deepEqual(resolved.prefixArgs, [install.entry]);
		assert.equal(resolved.version, "18.11.1");
		assert.equal((await native.resolveOmpPackageRoot(resolved))?.root, path.dirname(path.dirname(install.entry)));
	});

	it("refuses a Volta launcher whose binary belongs to some other package, and never starts `volta run`", async () => {
		const install = await voltaInstall("some-other-package");

		await withPath([install.bin, tools], async () => {
			await assert.rejects(native.resolveOmpBinary(), /omp\.cmd is a script launcher|omp\.cmd is a package-manager shim/);
		});
	});

	it("refuses a forward that names no launcher of OMP's, and does not follow forwards without end", async () => {
		const home = path.join(temp, `yarn-${installs++}`);
		const bin = path.join(home, "bin");
		await mkdir(bin, { recursive: true });
		await writeFile(path.join(bin, "omp.cmd"), '@"%~dp0\\omp.cmd" %*\r\n');
		const other = await ompPackage(path.join(home, "other"), "some-other-package");
		await writeFile(path.join(bin, "other.cmd"), entryLine(path.relative(bin, other)));
		const forwarding = path.join(home, "bin2");
		await mkdir(forwarding, { recursive: true });
		await writeFile(path.join(forwarding, "omp.cmd"), '@"%~dp0\\..\\bin\\other.cmd" %*\r\n');

		for (const dir of [bin, forwarding]) {
			await withPath([dir, tools], async () => {
				await assert.rejects(native.resolveOmpBinary(), /omp\.cmd is a script launcher|omp\.cmd is a package-manager shim/, dir);
			});
		}
	});
});

/**
 * `mise use -g github:can1357/oh-my-pi` (mise 2026.10.12 on Windows, observed): OMP's own compiled program is
 * `<data>/installs/github-can1357-oh-my-pi/<release>/omp.exe`, with `latest`, `18`, `18.11` and `global` links beside the release;
 * the `omp.exe` that PATH reaches through `<data>/shims` is mise's launcher, a copy of `mise-shim.exe` that starts `mise x -- omp`.
 */
describe("a mise install of OMP", { skip: process.platform !== "win32" && "mise's Windows layout" }, () => {
	const SHIM_BYTES = "MZ\u0000\u0000mise-shim: recursive shim invocation detected for omp\u0000mise-shim: failed to execute mise: ";
	let installs = 0;
	let program: string;

	before(async () => {
		// What the file carries makes it OMP's program: OMP's identity plus an embedded JavaScript engine (as in the classification test above).
		program = path.join(temp, "mise-program.exe");
		await copyFile(process.execPath, program);
		await appendFile(program, "\n@oh-my-pi/pi-coding-agent JavaScriptCore oven-sh/bun\n");
	});

	/** A mise data directory with the given releases installed (each a copy of `source`) and the shim directory mise writes. */
	async function miseData(releases: readonly string[], source = program): Promise<{ readonly data: string; readonly shims: string; readonly installed: (release: string) => string }> {
		const data = path.join(temp, `mise-${installs++}`);
		const shims = path.join(data, "shims");
		const tool = path.join(data, "installs", "github-can1357-oh-my-pi");
		await mkdir(shims, { recursive: true });
		await writeFile(path.join(shims, "omp.exe"), SHIM_BYTES);
		await writeFile(path.join(shims, ".mode"), "exe");
		for (const release of releases) {
			await mkdir(path.join(tool, release), { recursive: true });
			await copyFile(source, path.join(tool, release, "omp.exe"));
		}
		// The links mise adds beside a release: aliases, not releases.
		if (releases.length > 0) {
			for (const alias of ["latest", "global", "18", "18.11"]) await symlink(path.join(tool, releases[0]), path.join(tool, alias), "junction");
		}
		return { data, shims, installed: release => path.join(tool, release, "omp.exe") };
	}

	async function withPath<T>(dirs: readonly string[], action: () => Promise<T>): Promise<T> {
		const saved = { PATH: process.env.PATH, LOCALAPPDATA: process.env.LOCALAPPDATA };
		process.env.PATH = dirs.join(path.delimiter);
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

	it("starts the installed program itself, not mise's shim, when the shim directory is what PATH offers and one release is installed", async () => {
		const mise = await miseData(["18.11.1"]);

		const resolved = await withPath([mise.shims], () => native.resolveOmpBinary());

		assert.equal(resolved.command, mise.installed("18.11.1"));
		assert.deepEqual(resolved.prefixArgs, []);
		assert.equal(resolved.launcher, "program", "OMP's own program: no Bun flags on its command line, the BUN_OPTIONS probe decides");
		assert.match(resolved.origin, /the mise install behind the shim .*shims.omp\.exe/);
	});

	it("takes the same program when it is the install folder that PATH offers (mise activate) or the explicit path", async () => {
		const mise = await miseData(["18.11.1"]);
		const installed = mise.installed("18.11.1");

		assert.equal((await withPath([path.dirname(installed)], () => native.resolveOmpBinary())).command, installed);
		assert.equal((await withPath([], () => native.resolveOmpBinary({ explicitPath: installed }))).command, installed);
		assert.equal((await withPath([], () => native.resolveOmpBinary({ explicitPath: path.join(mise.shims, "omp.exe") }))).command, installed, "the shim named by the setting is resolved the same way");
	});

	it("refuses a shim whose folder holds several releases, naming each and the way out, and starts nothing", async () => {
		const mise = await miseData(["18.10.3", "18.11.1"]);

		const error = await withPath([mise.shims], async () => {
			try {
				await native.resolveOmpBinary();
			} catch (caught) {
				return caught as Error;
			}
			return assert.fail("an ambiguous mise shim must be refused");
		});

		assert.match(error.message, /is mise's shim, which starts mise and mise then starts OMP/);
		assert.ok(error.message.includes(mise.installed("18.10.3")) && error.message.includes(mise.installed("18.11.1")), error.message);
		assert.match(error.message, /2 releases are installed/);
		assert.match(error.message, /set ompDesk\.executablePath to the one to use/);
	});

	it("refuses a shim with no release installed beside it, and says how to install one", async () => {
		const mise = await miseData([]);

		await withPath([mise.shims], async () => {
			await assert.rejects(native.resolveOmpBinary(), /is mise's shim.*no release of OMP is installed in .*github-can1357-oh-my-pi; install one with `mise use -g github:can1357\/oh-my-pi`/);
		});
	});

	it("refuses a release that is not OMP's program, by its content", async () => {
		const impostor = path.join(temp, "mise-impostor.exe");
		await writeFile(impostor, "an unrelated launcher");
		const mise = await miseData(["18.11.1"], impostor);

		await withPath([mise.shims], async () => {
			await assert.rejects(native.resolveOmpBinary(), /the only release installed beside it, is neither OMP's own program nor a recognised bun shim/);
		});
	});

	it("still refuses an omp.exe in some other folder named shims that is not mise's", async () => {
		const other = path.join(temp, `not-mise-${installs++}`, "shims");
		await mkdir(other, { recursive: true });
		await writeFile(path.join(other, "omp.exe"), "a launcher of another package manager");

		await withPath([other], async () => {
			await assert.rejects(native.resolveOmpBinary(), /is a package-manager shim, which never runs as a single process/);
		});
	});
});

/**
 * The Bun a bun shim's launch runs on must be Bun itself (ADR-0083). A `bun.exe` in a package manager's shim folder (Scoop, Chocolatey)
 * hands its command line to the real Bun as a second process, so the launched process is not the one OMP runs in and host control fails
 * its pid check on every launch. What tells the two apart is the file's content: Bun carries its JavaScript engine, a launcher a path.
 * These files are small stand-ins that carry (or lack) that content; resolving a bun shim whose release the package manifest gives starts
 * no process, so nothing here needs a runnable Bun.
 */
describe("the bun.exe a bun shim runs on", () => {
	const isWindows = process.platform === "win32";
	const BUN_NAME = isWindows ? "bun.exe" : "bun";
	const ENGINE = "JavaScriptCore oven-sh/bun";
	let installs = 0;

	/** A PATH entry holding a bun shim of OMP with its entry and manifest, so resolving it starts nothing. */
	async function installOmp(): Promise<{ readonly bin: string; readonly entry: string }> {
		const root = path.join(temp, `bun-runtime-${installs++}`);
		const bin = path.join(root, "bin");
		await mkdir(bin, { recursive: true });
		const shim = path.join(bin, isWindows ? "omp.exe" : "omp");
		await writeFile(shim, "bun_shim_impl");
		await chmod(shim, 0o755);
		await writeFile(path.join(bin, "omp.bunx"), Buffer.from('"entry.js"', "utf16le"));
		const entry = path.join(root, "entry.js");
		await writeFile(entry, "console.log('omp/18.8.5');");
		await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-coding-agent", version: "18.8.5" }));
		return { bin, entry };
	}

	/** A folder holding a file named like Bun with `content`: the real runtime's engine, or a launcher's path. */
	async function bunFolder(content: string, name = BUN_NAME): Promise<{ readonly dir: string; readonly file: string }> {
		const dir = path.join(temp, `bun-folder-${installs++}`);
		await mkdir(dir, { recursive: true });
		const file = path.join(dir, name);
		await writeFile(file, content);
		await chmod(file, 0o755);
		return { dir, file };
	}

	const FORWARDER = "a package manager's launcher: path = C:\\packages\\bun\\current\\bun.exe";

	async function withPath<T>(dirs: readonly string[], action: () => Promise<T>): Promise<T> {
		const saved = { PATH: process.env.PATH, LOCALAPPDATA: process.env.LOCALAPPDATA };
		process.env.PATH = dirs.join(path.delimiter);
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

	it("is the real Bun beside the shim", async () => {
		const install = await installOmp();
		await writeFile(path.join(install.bin, BUN_NAME), ENGINE);
		await chmod(path.join(install.bin, BUN_NAME), 0o755);

		const resolved = await withPath([install.bin], () => native.resolveOmpBinary());

		assert.equal(resolved.command, path.join(install.bin, BUN_NAME));
		assert.deepEqual(resolved.prefixArgs, [install.entry]);
		assert.equal(resolved.launcher, "bun-shim");
	});

	it("is the real Bun on PATH when none sits beside the shim", async () => {
		const install = await installOmp();
		const real = await bunFolder(ENGINE);

		const resolved = await withPath([install.bin, real.dir], () => native.resolveOmpBinary());

		assert.equal(resolved.command, real.file);
		assert.deepEqual(resolved.prefixArgs, [install.entry]);
		assert.equal(resolved.launcher, "bun-shim");
	});

	it("passes over a forwarding bun.exe that sits first on PATH and takes the real Bun behind it, saying so once", async () => {
		const install = await installOmp();
		const forwarding = await bunFolder(FORWARDER);
		const real = await bunFolder(ENGINE);
		const lines: LoggedLine[] = [];
		native.setOmpResolutionLog(recordingLogger(lines));
		try {
			const first = await withPath([install.bin, forwarding.dir, real.dir], () => native.resolveOmpBinary());
			const second = await withPath([install.bin, forwarding.dir, real.dir], () => native.resolveOmpBinary());

			assert.equal(first.command, real.file, "the launched program is the real Bun, not the launcher that forwards to it");
			assert.equal(second.command, real.file);
		} finally {
			native.setOmpResolutionLog(null);
		}

		const passedOver = lines.filter(line => line.message.includes(forwarding.file));
		assert.equal(passedOver.length, 1, JSON.stringify(lines));
		assert.equal(passedOver[0]?.level, "info");
		assert.match(passedOver[0]?.message ?? "", /not Bun's own runtime .*starts the real Bun as a second process/);
		assert.ok((passedOver[0]?.message ?? "").includes(real.file), "the line names the Bun that is used instead");
	});

	it("passes over a forwarding bun.exe that sits beside the shim, for the real Bun on PATH", async () => {
		const install = await installOmp();
		await writeFile(path.join(install.bin, BUN_NAME), FORWARDER);
		await chmod(path.join(install.bin, BUN_NAME), 0o755);
		const real = await bunFolder(ENGINE);

		const resolved = await withPath([install.bin, real.dir], () => native.resolveOmpBinary());

		assert.equal(resolved.command, real.file);
	});

	it("says nothing about a passed-over launcher when the launch is refused for another reason", async () => {
		const install = await installOmp();
		await rm(path.join(install.bin, "omp.bunx"));
		const forwarding = await bunFolder(FORWARDER);
		const real = await bunFolder(ENGINE);
		const lines: LoggedLine[] = [];
		native.setOmpResolutionLog(recordingLogger(lines));
		try {
			await withPath([install.bin, forwarding.dir, real.dir], async () => {
				await assert.rejects(native.resolveOmpBinary(), /its target entry could not be resolved/);
			});
		} finally {
			native.setOmpResolutionLog(null);
		}

		assert.deepEqual(lines.filter(line => line.message.includes(forwarding.file)), [], "no Bun was used, so none is said to be");
	});

	it("refuses with the reason, naming the launcher, when the only bun.exe on the machine is a forwarding one", async () => {
		const install = await installOmp();
		const forwarding = await bunFolder(FORWARDER);

		await withPath([install.bin, forwarding.dir], async () => {
			await assert.rejects(native.resolveOmpBinary(), (error: Error) => {
				assert.match(error.message, /No usable OMP launcher was found\./);
				assert.ok(error.message.includes(forwarding.file), error.message);
				assert.match(error.message, /no bun runtime was found beside it/);
				assert.match(error.message, /is not Bun's own runtime \(no JavaScript engine found in the file\)/);
				assert.match(error.message, /Put Bun's own bun\.exe .* on PATH/);
				assert.ok(!/pid-mismatch/.test(error.message), "the refusal is the diagnostic, not the symptom");
				return true;
			});
		});
	});

	it("reads a file once per identity: a replaced file is read again, an untouched one is not", async () => {
		const install = await installOmp();
		const size = 256;
		const bun = await bunFolder(ENGINE.padEnd(size, " "));
		// A whole-millisecond time, so that setting it again reproduces the identity exactly.
		const stamp = new Date(1_700_000_000_000);
		await utimes(bun.file, stamp, stamp);

		assert.equal((await withPath([install.bin, bun.dir], () => native.resolveOmpBinary())).command, bun.file);

		// Other bytes of the same size and modification time are the same file as far as identity goes: the earlier answer stands.
		await writeFile(bun.file, "x".repeat(size));
		await utimes(bun.file, stamp, stamp);
		assert.equal((await withPath([install.bin, bun.dir], () => native.resolveOmpBinary())).command, bun.file, "answered from memory");

		// A file the user replaced differs in size or in modification time and is read again.
		await utimes(bun.file, new Date(1_700_000_100_000), new Date(1_700_000_100_000));
		await assert.rejects(withPath([install.bin, bun.dir], () => native.resolveOmpBinary()), /is not Bun's own runtime/);
	});

	it("does not take an extensionless bun on Windows, where Bun's program file is bun.exe", { skip: !isWindows && "a Windows naming rule" }, async () => {
		const install = await installOmp();
		const script = await bunFolder(ENGINE, "bun");

		await withPath([install.bin, script.dir], async () => {
			await assert.rejects(native.resolveOmpBinary(), /no bun runtime was found beside it/);
		});
	});
});

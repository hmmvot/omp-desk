/**
 * The command line and working directory a host chat process starts with.
 *
 * `rpcOmpLaunchSpec` is the single builder of the `omp --mode rpc-ui` command line, so what is
 * pinned here is the contract every launch depends on: the mode, the exact session a resume
 * names against the directory a new conversation is stored in, an always-explicit profile, and
 * host control that appears only when a bootstrap was given. `resumeWorkingDirectory` decides
 * where a resume runs, against real directories.
 *
 * The launcher itself talks to a broker and is proved end to end by `rpc-handle.test.ts`.
 *
 * `rpc-launch.ts` imports `vscode` through `native-terminal.ts` and its siblings without file
 * extensions, so it is compiled here with the project's bundler and a `vscode` stand-in.
 *
 * Runner: `node --test src/host/rpc-launch.test.ts`.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, before, describe, it } from "node:test";
import { build } from "esbuild";
import { CONTROL_DIR_ENV, CONTROL_SLOT_ENV } from "./control-protocol.ts";
import type { NativeControlBootstrap } from "./native-terminal.ts";
import type {
	resumeWorkingDirectory as resumeWorkingDirectoryType,
	RpcOmpLaunchSpec,
	retireStoppedRpcBroker as retireStoppedRpcBrokerType,
	rpcOmpLaunchSpec as rpcOmpLaunchSpecType,
} from "./rpc-launch.ts";

const VSCODE_STUB = `
export const Uri = { file: (value) => ({ fsPath: value }) };
export class ThemeIcon { constructor(id) { this.id = id; } }
export const window = { createTerminal: options => ({ options }), terminals: [] };
`;

interface LaunchModule {
	rpcOmpLaunchSpec: typeof rpcOmpLaunchSpecType;
	resumeWorkingDirectory: typeof resumeWorkingDirectoryType;
	retireStoppedRpcBroker: typeof retireStoppedRpcBrokerType;
}

let temp: string;
let launch: LaunchModule;

before(async () => {
	temp = await mkdtemp(path.join(tmpdir(), "omp-rpc-launch-"));
	const outfile = path.join(temp, "rpc-launch.mjs");
	await build({
		entryPoints: [fileURLToPath(new URL("./rpc-launch.ts", import.meta.url))],
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
	launch = (await import(pathToFileURL(outfile).href)) as LaunchModule;
});

after(async () => {
	await rm(temp, { recursive: true, force: true });
});

describe("the rpc-ui launch command line", () => {
	const cwd = () => path.join(temp, "project");
	const sessionFile = () => path.join(temp, "2026-09-29T10-00-00_S-ONE.jsonl");
	const sessionDir = () => path.join(temp, "isolated");

	const controlOf = (): NativeControlBootstrap => ({
		defineName: "__OMP_VSCODE_RECIPIENT__",
		publicRecipient: "cHVibGljLXJlY2lwaWVudA",
		modulePath: path.join(temp, "host-control.js"),
		directory: path.join(temp, "control"),
		slotId: "slot-1",
	});

	function spec(
		overrides: {
			readonly profile?: string | null;
			readonly sessionFile?: string | null;
			readonly sessionDir?: string | null;
			readonly control?: NativeControlBootstrap | null;
			readonly prefixArgs?: readonly string[];
		} = {},
	): RpcOmpLaunchSpec {
		return launch.rpcOmpLaunchSpec({
			binary: { command: "omp", prefixArgs: overrides.prefixArgs ?? [] },
			control: overrides.control === undefined ? null : overrides.control,
			cwd: cwd(),
			sessionFile: overrides.sessionFile === undefined ? null : overrides.sessionFile,
			sessionDir: overrides.sessionDir === undefined ? null : overrides.sessionDir,
			profile: overrides.profile === undefined ? null : overrides.profile,
		});
	}

	/** The value following a flag, or `undefined` when the flag is absent. */
	function valueOf(args: readonly string[], flag: string): string | undefined {
		const index = args.indexOf(flag);
		return index < 0 ? undefined : args[index + 1];
	}

	it("runs the binary in rpc-ui mode in the given directory", () => {
		const result = spec();
		assert.equal(result.file, "omp");
		assert.equal(result.cwd, cwd());
		assert.equal(valueOf(result.args, "--mode"), "rpc-ui");
		assert.equal(valueOf(result.args, "--cwd"), cwd());
	});

	it("never selects a session by any flag but the exact file or the explicit directory", () => {
		for (const result of [
			spec({ sessionFile: sessionFile(), sessionDir: sessionDir() }),
			spec({ sessionDir: sessionDir() }),
			spec(),
		]) {
			for (const forbidden of ["--resume", "-r", "--continue", "-c", "--fork"]) {
				assert.equal(result.args.includes(forbidden), false, forbidden);
			}
			assert.equal(result.args.some(argument => argument.startsWith("@")), false);
		}
	});

	it("resumes the exact file and ignores the directory of a new conversation", () => {
		const result = spec({ sessionFile: sessionFile(), sessionDir: sessionDir() });
		assert.equal(valueOf(result.args, "--session"), sessionFile());
		assert.equal(result.args.includes("--session-dir"), false);
	});

	it("stores a new conversation under the explicit directory, and names no session file", () => {
		const result = spec({ sessionDir: sessionDir() });
		assert.equal(valueOf(result.args, "--session-dir"), sessionDir());
		assert.equal(result.args.includes("--session"), false);
	});

	it("passes no session flag at all for a new conversation in the default directory", () => {
		const result = spec();
		assert.equal(result.args.includes("--session"), false);
		assert.equal(result.args.includes("--session-dir"), false);
	});

	it("always names the profile, falling back to OMP's default sentinel so an inherited OMP_PROFILE cannot decide it", () => {
		assert.equal(valueOf(spec().args, "--profile"), "default");
		assert.equal(valueOf(spec({ profile: "work" }).args, "--profile"), "work");
	});

	it("carries no host-control flag or environment without a bootstrap", () => {
		const result = spec();
		assert.deepEqual(result.env, {});
		for (const flag of ["--define", "--preload", "-e"]) assert.equal(result.args.includes(flag), false, flag);
	});

	it("loads host control and publishes its rendezvous only when a bootstrap is given", () => {
		const control = controlOf();
		const result = spec({ control });
		assert.deepEqual(result.env, {
			[CONTROL_DIR_ENV]: control.directory,
			[CONTROL_SLOT_ENV]: control.slotId,
		});
		assert.equal(valueOf(result.args, "--preload"), control.modulePath);
		assert.equal(valueOf(result.args, "-e"), control.modulePath);
		const define = valueOf(result.args, "--define");
		assert.ok(define !== undefined && define.startsWith(`${control.defineName}:`), "the public recipient is handed over as a bun define");
		assert.equal(JSON.parse(define.slice(control.defineName.length + 1)), control.publicRecipient);
	});

	it("keeps bun's flags before the launcher's prefix arguments, and those before OMP's own", () => {
		// A bun shim's prefix names the entry script: a bun flag after it would reach OMP instead.
		const result = spec({ control: controlOf(), prefixArgs: ["entry.ts"] });
		const prefix = result.args.indexOf("entry.ts");
		assert.ok(prefix > result.args.indexOf("--define"));
		assert.ok(prefix > result.args.indexOf("--preload"));
		assert.ok(prefix < result.args.indexOf("--mode"));
		assert.ok(result.args.indexOf("-e") > result.args.indexOf("--mode"), "OMP's -e follows OMP's own arguments");
	});
});

describe("the directory a resume runs in", () => {
	const fallback = () => path.join(temp, "row-folder");

	it("is the session header's directory when it can be entered, with no notice", async () => {
		const own = path.join(temp, "own-cwd");
		await mkdir(own, { recursive: true });
		assert.deepEqual(await launch.resumeWorkingDirectory(own, fallback()), { cwd: own, notice: null });
	});

	it("is the row's folder, silently, when the header records no directory", async () => {
		assert.deepEqual(await launch.resumeWorkingDirectory(null, fallback()), { cwd: fallback(), notice: null });
	});

	it("falls back with a notice naming the unusable directory when it is missing", async () => {
		const missing = path.join(temp, "deleted-cwd");
		const result = await launch.resumeWorkingDirectory(missing, fallback());
		assert.equal(result.cwd, fallback());
		assert.ok(result.notice?.includes(missing), "the notice names the directory that could not be entered");
		assert.ok(result.notice?.includes(fallback()), "the notice names where the session runs instead");
	});

	it("falls back when the header's path is a file, not a directory", async () => {
		const file = path.join(temp, "a-file");
		await writeFile(file, "x");
		const result = await launch.resumeWorkingDirectory(file, fallback());
		assert.equal(result.cwd, fallback());
		assert.notEqual(result.notice, null);
	});

	it("falls back when the header's path is not absolute, even if it resolves from the process directory", async () => {
		const result = await launch.resumeWorkingDirectory(".", fallback());
		assert.equal(result.cwd, fallback());
		assert.notEqual(result.notice, null);
	});
});

describe("letting a stopped host's broker go", () => {
	const runtimeOf = (shutdown: () => Promise<unknown>, events: string[]) =>
		({
			identity: { slot: "host:test-slot" },
			handle: {
				shutdown: async () => {
					events.push("shutdown");
					return shutdown();
				},
				disconnect: () => events.push("disconnect"),
			},
		}) as unknown as Parameters<LaunchModule["retireStoppedRpcBroker"]>[0];

	it("shuts the broker down, then drops this window's connection", async () => {
		const events: string[] = [];
		const result = await launch.retireStoppedRpcBroker(runtimeOf(async () => ({ stopped: true }), events));
		assert.equal(result.retired, true);
		assert.deepEqual(events, ["shutdown", "disconnect"]);
	});

	it("reports a refusal without retiring, and still drops the connection", async () => {
		const events: string[] = [];
		const result = await launch.retireStoppedRpcBroker(
			runtimeOf(async () => {
				throw new Error("the native process is not proven gone");
			}, events),
		);
		assert.equal(result.retired, false);
		assert.match(result.detail, /not proven gone/);
		assert.deepEqual(events, ["shutdown", "disconnect"]);
	});
});

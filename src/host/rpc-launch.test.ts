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
import { CONTROL_DIR_ENV, CONTROL_SLOT_ENV, LINK_REMINDER_ENV } from "./control-protocol.ts";
import type { NativeControlBootstrap } from "./native-terminal.ts";
import { controlRuntimeFlagSet, NO_RUNTIME_FLAGS, planRuntimeFlags } from "./runtime-flags.ts";
import type { RuntimeFlagPlan } from "./runtime-flags.ts";
import type { OmpBinary, resolveOmpBinary as resolveOmpBinaryType } from "./native-terminal.ts";
import type {
	describeRecordedRuntime as describeRecordedRuntimeType,
	launchRpcHost as launchRpcHostType,
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
	describeRecordedRuntime: typeof describeRecordedRuntimeType;
}

interface LaunchWithResolverModule extends LaunchModule {
	launchRpcHost: typeof launchRpcHostType;
	resolveOmpBinary: typeof resolveOmpBinaryType;
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
		probeModulePath: path.join(temp, "runtime-probe.mjs"),
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
			/** How the flags reach the launcher; the default is a bun shim's command line. */
			readonly carrier?: RuntimeFlagPlan["carrier"];
			readonly inheritedBunOptions?: string;
			readonly linkReminder?: boolean;
		} = {},
	): RpcOmpLaunchSpec {
		const control = overrides.control === undefined ? null : overrides.control;
		const runtime = control === null ? NO_RUNTIME_FLAGS : planRuntimeFlags(controlRuntimeFlagSet(control), overrides.carrier ?? "argv", overrides.inheritedBunOptions);
		return launch.rpcOmpLaunchSpec({
			binary: { command: "omp", prefixArgs: overrides.prefixArgs ?? [] },
			control,
			runtime,
			cwd: cwd(),
			sessionFile: overrides.sessionFile === undefined ? null : overrides.sessionFile,
			sessionDir: overrides.sessionDir === undefined ? null : overrides.sessionDir,
			profile: overrides.profile === undefined ? null : overrides.profile,
			linkReminder: overrides.linkReminder ?? true,
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

	it("carries no host-control flag or rendezvous environment without a bootstrap", () => {
		const result = spec();
		assert.deepEqual(result.env, { [LINK_REMINDER_ENV]: "1" });
		for (const flag of ["--define", "--preload", "-e"]) assert.equal(result.args.includes(flag), false, flag);
	});

	it("passes the ompDesk.linkReminder setting to the Chat prompt module as an environment value", () => {
		assert.equal(spec({ linkReminder: true }).env[LINK_REMINDER_ENV], "1");
		assert.equal(spec({ linkReminder: false }).env[LINK_REMINDER_ENV], "0");
	});

	it("loads host control and publishes its rendezvous only when a bootstrap is given", () => {
		const control = controlOf();
		const result = spec({ control });
		assert.deepEqual(result.env, {
			[LINK_REMINDER_ENV]: "1",
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

	it("never puts Bun's flags on the command line of a launcher that carries them in BUN_OPTIONS", () => {
		// OMP's own compiled program has a command line that is OMP's alone: `--define` and `--preload` there are
		// OMP's unknown flags (`OMP exited with code 2`).
		const control = controlOf();
		const result = spec({ control, carrier: "bun-options" });
		for (const flag of ["--define", "--preload"]) assert.equal(result.args.includes(flag), false, flag);
		assert.deepEqual(result.args.slice(0, 2), ["--mode", "rpc-ui"], "nothing precedes OMP's own arguments");
		assert.equal(valueOf(result.args, "-e"), control.modulePath, "OMP's own -e still loads the module");
		assert.equal(result.env.BUN_OPTIONS?.includes("--preload"), true);
		assert.equal(result.env.BUN_OPTIONS?.includes(control.defineName), true);
		assert.equal(result.env[CONTROL_DIR_ENV], control.directory);
		assert.equal(result.env.OMP_VSCODE_BUN_OPTIONS_BASE, "", "the unset BUN_OPTIONS is what the module restores");
	});

	it("keeps a BUN_OPTIONS the user already has in front of Desk's", () => {
		const result = spec({ control: controlOf(), carrier: "bun-options", inheritedBunOptions: "--smol" });
		assert.ok(result.env.BUN_OPTIONS?.startsWith("--smol --define "), result.env.BUN_OPTIONS ?? "unset");
		assert.equal(result.env.OMP_VSCODE_BUN_OPTIONS_BASE, "--smol");
	});

	it("passes no Bun flag and no BUN_OPTIONS to a launcher that honours neither, and still loads Chat's own commands", () => {
		const control = controlOf();
		const result = spec({ control, carrier: "none" });
		for (const flag of ["--define", "--preload"]) assert.equal(result.args.includes(flag), false, flag);
		assert.equal("BUN_OPTIONS" in result.env, false);
		assert.equal(valueOf(result.args, "-e"), control.modulePath, "rewind, clear and the Chat prompt need no control channel");
		assert.equal(result.env[CONTROL_SLOT_ENV], control.slotId);
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
				// A broker that still exists: a failed shutdown is then a refusal, not a retirement.
				brokerPid: process.pid,
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

	it("counts a broker whose process no longer exists as retired (killed from outside): there is nothing left to shut down", async () => {
		const events: string[] = [];
		const runtime = runtimeOf(async () => {
			throw new Error("the broker connection closed");
		}, events) as unknown as { handle: { brokerPid: number } };
		runtime.handle.brokerPid = 2147483000;
		const result = await launch.retireStoppedRpcBroker(runtime as unknown as Parameters<LaunchModule["retireStoppedRpcBroker"]>[0]);
		assert.equal(result.retired, true);
		assert.match(result.detail, /no longer exists/);
		assert.deepEqual(events, ["shutdown", "disconnect"]);

		const alive = runtimeOf(async () => {
			throw new Error("the broker connection closed");
		}, []) as unknown as { handle: { brokerPid: number } };
		alive.handle.brokerPid = process.pid;
		assert.equal((await launch.retireStoppedRpcBroker(alive as unknown as Parameters<LaunchModule["retireStoppedRpcBroker"]>[0])).retired, false, "a broker that still exists and did not shut down is not retired");
	});
});

describe("what a record says about its broker's runtime", () => {
	it("names Bun, the extension host's Electron and Node by their versions", () => {
		assert.equal(launch.describeRecordedRuntime({ engine: "bun", version: "1.4.3" }), "Bun 1.4.3");
		assert.equal(launch.describeRecordedRuntime({ engine: "electron", version: "39.2.7" }), "VS Code (Electron 39.2.7)");
		assert.equal(launch.describeRecordedRuntime({ engine: "node", version: "24.1.0" }), "Node 24.1.0");
	});

	it("takes a record without a statement for an earlier build's Code.exe broker", () => {
		assert.equal(launch.describeRecordedRuntime(undefined), "VS Code (Code.exe), from before brokers named their runtime");
	});
});

describe("the runtime facts a launch hands the client", () => {
	let withResolver: LaunchWithResolverModule;
	let resolved: OmpBinary | null = null;
	let unavailable = "";

	before(async () => {
		const outfile = path.join(temp, "rpc-launch-with-resolver.mjs");
		await build({
			stdin: {
				contents: 'export * from "./rpc-launch.ts"; export { resolveOmpBinary } from "./native-terminal.ts";',
				resolveDir: path.dirname(fileURLToPath(new URL("./rpc-launch.ts", import.meta.url))),
				sourcefile: "rpc-launch-with-resolver.ts",
				loader: "ts",
			},
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
		withResolver = (await import(pathToFileURL(outfile).href)) as LaunchWithResolverModule;
		try {
			resolved = await withResolver.resolveOmpBinary();
		} catch (error) {
			unavailable = error instanceof Error ? error.message : String(error);
		}
	});

	it("passes the resolved OMP binary as the second argument of launchRpc", async (context) => {
		if (resolved === null) {
			context.skip(`no OMP install resolves on this machine: ${unavailable.split("\n")[0]}`);
			return;
		}
		const calls: { spec: Record<string, unknown>; options: unknown }[] = [];
		const client = {
			launchRpc: async (spec: Record<string, unknown>, options: unknown) => {
				calls.push({ spec, options });
				return { state: "not-started", reason: "stand-in client", handle: null, adopted: false, brokerPid: null };
			},
		};
		const outcome = await withResolver.launchRpcHost(
			{ slot: "host:binary-facts", cwd: temp, sessionFile: null, profile: null, sessionDir: null, control: null, linkReminder: false },
			client as unknown as Parameters<LaunchWithResolverModule["launchRpcHost"]>[1],
		);
		assert.equal(outcome.state, "not-started");
		assert.equal(outcome.reason, "stand-in client");
		assert.equal(calls.length, 1);
		const options = calls[0]?.options as { ompBinary?: { command: string; prefixArgs: readonly string[]; launcher?: string } } | undefined;
		assert.ok(options?.ompBinary, "the launch's binary was not passed");
		assert.deepEqual(options.ompBinary, resolved);
		assert.equal(calls[0]?.spec.kind, "managed-rpc");
		assert.equal(calls[0]?.spec.slot, "host:binary-facts");
		// The broker is told about the very command the session runs.
		assert.equal(calls[0]?.spec.file, resolved.command);
		assert.ok(options.ompBinary.launcher === "bun-shim" || options.ompBinary.launcher === "program", `launcher ${String(options.ompBinary.launcher)}`);
	});
});

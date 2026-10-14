/**
 * Which carrier host control's Bun flags use for each kind of launcher (ADR-0075), and the probe that decides it.
 *
 * Three launcher kinds are pinned: a bun shim (Bun's own CLI: the flags stay on the command line, unchanged, and
 * nothing is probed), OMP's compiled program and an unknown launcher (never given Bun's flags on the command
 * line; `BUN_OPTIONS` only after an observed probe, remembered per executable identity, and no flags at all
 * when the probe does not show them honoured). A last test drives a real Bun with a path holding spaces and
 * non-ASCII letters, to pin the encoding against the parser that reads it.
 *
 * `launch-capability.ts` imports `native-terminal.ts` and its siblings without file extensions, so it is
 * compiled here with the project's bundler. Runner: `node --test src/host/launch-capability.test.ts`.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, before, describe, it } from "node:test";
import { build } from "esbuild";
import type { CarrierDeps, CarrierMemory as CarrierMemoryType, planControlLaunch as planControlLaunchType } from "./launch-capability.ts";
import type { NativeControlBootstrap, OmpCliResult } from "./native-terminal.ts";
import { planRuntimeFlags } from "./runtime-flags.ts";

interface CapabilityModule {
	readonly planControlLaunch: typeof planControlLaunchType;
	readonly CarrierMemory: typeof CarrierMemoryType;
}

let temp: string;
let capability: CapabilityModule;

before(async () => {
	temp = await mkdtemp(path.join(tmpdir(), "omp-launch-capability-"));
	const outfile = path.join(temp, "launch-capability.mjs");
	await build({
		entryPoints: [fileURLToPath(new URL("./launch-capability.ts", import.meta.url))],
		outfile,
		bundle: true,
		platform: "node",
		format: "esm",
		target: "node20",
	});
	capability = (await import(pathToFileURL(outfile).href)) as CapabilityModule;
});

after(async () => {
	await rm(temp, { recursive: true, force: true });
});

const control = (overrides: Partial<NativeControlBootstrap> = {}): NativeControlBootstrap => ({
	defineName: "__OMP_VSCODE_RECIPIENT_PUBLIC_KEY",
	publicRecipient: "cHVibGljLXJlY2lwaWVudA",
	modulePath: "C:/runtime/aaa/host-control.mjs",
	probeModulePath: "C:/runtime/bbb/runtime-probe.mjs",
	directory: "C:/control",
	slotId: "slot-1",
	...overrides,
});

interface Run {
	readonly command: string;
	readonly args: readonly string[];
	readonly env: Readonly<Record<string, string>> | undefined;
}

/** A launcher stand-in: runs are recorded, and the answer says what the real one would have printed. */
function harness(answer: (run: Run, nonce: string | null) => OmpCliResult | Promise<OmpCliResult> | Error, inherited?: string) {
	const runs: Run[] = [];
	let identity = "omp.exe|1|1";
	const deps: CarrierDeps = {
		inheritedBunOptions: () => inherited,
		identity: async () => identity,
		run: async (executable, args, _timeoutMs, options) => {
			const run: Run = { command: executable.command, args: [...executable.prefixArgs, ...args], env: options.env };
			runs.push(run);
			// The probe's nonce is the one value only a launcher that honoured the define could repeat.
			const nonce = /__OMP_VSCODE_PROBE_NONCE:\\"([0-9a-f]+)\\"/.exec(options.env?.BUN_OPTIONS ?? "")?.[1] ?? null;
			const result = await answer(run, nonce);
			if (result instanceof Error) throw result;
			return result;
		},
	};
	return { deps, runs, memory: new capability.CarrierMemory(), changeIdentity: (next: string) => { identity = next; } };
}

/** What a launcher that honoured BUN_OPTIONS prints for `--version`. */
const honours = (_run: Run, nonce: string | null): OmpCliResult => ({ exitCode: 0, stdout: "omp/18.10.3\n", stderr: `OMP_DESK_RUNTIME_PROBE ${nonce}\n`, });
const ignores = (): OmpCliResult => ({ exitCode: 0, stdout: "omp/18.0.4\n", stderr: "" });

describe("a bun shim", () => {
	it("keeps Bun's flags on its command line, as they always were, without probing", async () => {
		const h = harness(honours);
		const plan = await capability.planControlLaunch({ command: "bun.exe", prefixArgs: ["entry.js"], version: "18.10.3", origin: "shim", launcher: "bun-shim" }, control(), h.memory, h.deps);
		assert.equal(h.runs.length, 0, "Bun's own CLI is known to take them");
		assert.equal(plan.delivered, true);
		assert.equal(plan.notice, null);
		assert.deepEqual(plan.runtime, {
			carrier: "argv",
			args: ["--define", '__OMP_VSCODE_RECIPIENT_PUBLIC_KEY:"cHVibGljLXJlY2lwaWVudA"', "--preload", "C:/runtime/aaa/host-control.mjs"],
			env: {},
		});
	});
});

for (const [label, launcher] of [["OMP's compiled program", "program"], ["an unknown launcher", undefined]] as const) {
	describe(label, () => {
		const binary = { command: "C:/omp/omp.exe", prefixArgs: [] as string[], ...(launcher === undefined ? {} : { launcher, version: "18.10.3", origin: "PATH" }) };

		it("asks for nothing and probes nothing when host control is off", async () => {
			const h = harness(honours);
			const plan = await capability.planControlLaunch(binary, null, h.memory, h.deps);
			assert.equal(h.runs.length, 0);
			assert.deepEqual(plan, { runtime: { carrier: "none", args: [], env: {} }, delivered: false, notice: null, log: null });
		});

		it("gets the flags in BUN_OPTIONS after a probe shows this executable honoured them, and never on its command line", async () => {
			const h = harness(honours);
			const plan = await capability.planControlLaunch(binary, control(), h.memory, h.deps);
			assert.equal(plan.delivered, true);
			assert.equal(plan.notice, null);
			assert.deepEqual(plan.runtime.args, [], "an unsupported `--preload` would be OMP's unknown flag, exit code 2");
			assert.equal(plan.runtime.carrier, "bun-options");
			assert.equal(plan.runtime.env.BUN_OPTIONS, "--define __OMP_VSCODE_RECIPIENT_PUBLIC_KEY:\\\"cHVibGljLXJlY2lwaWVudA\\\" --preload C:/runtime/aaa/host-control.mjs");
			assert.equal(plan.runtime.env.OMP_VSCODE_BUN_OPTIONS_BASE, "");

			assert.equal(h.runs.length, 1);
			assert.deepEqual(h.runs[0]?.args, ["--version"], "the probe is a harmless version run");
			assert.match(h.runs[0]?.env?.BUN_OPTIONS ?? "", /--preload C:\/runtime\/bbb\/runtime-probe\.mjs/, "the probe module stands in for the real one");
			assert.ok(!(h.runs[0]?.env?.BUN_OPTIONS ?? "").includes("cHVibGljLXJlY2lwaWVudA"), "the real recipient is not sent to a launcher that has not proven itself");
		});

		it("remembers the answer per executable identity and probes a replaced file again", async () => {
			const h = harness(honours);
			await capability.planControlLaunch(binary, control(), h.memory, h.deps);
			await capability.planControlLaunch(binary, control(), h.memory, h.deps);
			assert.equal(h.runs.length, 1, "a second launch of the same file reuses the answer");
			h.changeIdentity("omp.exe|2|2");
			await capability.planControlLaunch(binary, control(), h.memory, h.deps);
			assert.equal(h.runs.length, 2, "an updated executable is probed again");
		});

		it("probes once when two launches of the same executable start together", async () => {
			const h = harness(honours);
			const [first, second] = await Promise.all([
				capability.planControlLaunch(binary, control(), h.memory, h.deps),
				capability.planControlLaunch(binary, control(), h.memory, h.deps),
			]);
			assert.equal(h.runs.length, 1);
			assert.equal(first.delivered && second.delivered, true);
		});

		it("never accepts a nonce it was not given", async () => {
			const h = harness(() => ({ exitCode: 0, stdout: "", stderr: "OMP_DESK_RUNTIME_PROBE 000000000000000000000000\n" }));
			const plan = await capability.planControlLaunch(binary, control(), h.memory, h.deps);
			assert.equal(plan.delivered, false);
		});

		it("runs without any Bun flag and says so once when the launcher did not honour them", async () => {
			const h = harness(ignores);
			const first = await capability.planControlLaunch(binary, control(), h.memory, h.deps);
			assert.deepEqual(first.runtime, { carrier: "none", args: [], env: {} });
			assert.equal(first.delivered, false);
			assert.match(first.notice ?? "", /C:\/omp\/omp\.exe does not accept the startup options OMP Desk uses for host control/);
			assert.match(first.notice ?? "", /Chat works/);
			assert.match(first.notice ?? "", /did not report the preloaded module/);
			assert.match(first.log ?? "", /host control not delivered/);

			const second = await capability.planControlLaunch(binary, control(), h.memory, h.deps);
			assert.equal(second.notice, null, "the notice is shown once per executable");
			assert.equal(second.delivered, false);
			assert.equal(h.runs.length, 1, "a negative answer is remembered too");
		});

		it("does not remember a probe that ended with a non-zero exit code: on Windows a kill or a crash by something else is one", async () => {
			let attempts = 0;
			const h = harness((run, nonce) => (++attempts === 1 ? { exitCode: -1073741502, stdout: "", stderr: "" } : honours(run, nonce)));
			const first = await capability.planControlLaunch(binary, control(), h.memory, h.deps);
			assert.equal(first.delivered, false);
			assert.match(first.log ?? "", /exited with code -1073741502/);
			assert.match(first.notice ?? "", /could not check whether C:\/omp\/omp\.exe accepts the startup options/);
			assert.doesNotMatch(first.notice ?? "", /does not accept/, "an unchecked launcher is not called unsupporting");
			const second = await capability.planControlLaunch(binary, control(), h.memory, h.deps);
			assert.equal(second.delivered, true, "the next launch asks again and gets its answer");
			assert.equal(h.runs.length, 2);
		});

		it("forgets a probe that could not run, so the next launch asks again", async () => {
			let attempts = 0;
			const h = harness((run, nonce) => (++attempts === 1 ? new Error("did not finish within 15000ms") : honours(run, nonce)));
			const first = await capability.planControlLaunch(binary, control(), h.memory, h.deps);
			assert.equal(first.delivered, false);
			assert.match(first.log ?? "", /could not be checked \(did not finish within 15000ms\)/);
			assert.match(first.notice ?? "", /could not check whether/);
			const second = await capability.planControlLaunch(binary, control(), h.memory, h.deps);
			assert.equal(second.delivered, true, "a timeout says nothing about the executable");
			assert.equal(h.runs.length, 2);
		});

		it("keeps a BUN_OPTIONS the user already has, in the probe and in the launch", async () => {
			const h = harness(honours, "--smol");
			const plan = await capability.planControlLaunch(binary, control(), h.memory, h.deps);
			assert.ok(h.runs[0]?.env?.BUN_OPTIONS?.startsWith("--smol --define "));
			assert.ok(plan.runtime.env.BUN_OPTIONS?.startsWith("--smol --define "));
			assert.equal(plan.runtime.env.OMP_VSCODE_BUN_OPTIONS_BASE, "--smol");
		});
	});
}

/** A Bun on PATH, or null; the encoding is only meaningful against a parser that reads it. */
function findBun(): string | null {
	const probe = spawnSync(process.platform === "win32" ? "where" : "which", ["bun"], { encoding: "utf8" });
	const first = probe.status === 0 ? probe.stdout.split(/\r?\n/)[0]?.trim() : "";
	return first ? first : null;
}

describe("against a real Bun", { skip: findBun() === null && "no bun on PATH" }, () => {
	it("honours a preload path with spaces and non-ASCII letters and a define, and the module puts BUN_OPTIONS back", async () => {
		const bun = findBun()!;
		const directory = path.join(temp, "Jane Dö 日本", "runtime dir");
		await mkdir(directory, { recursive: true });
		const probeModule = path.join(directory, "runtime-probe.mjs");
		await copyFile(fileURLToPath(new URL("../../media/runtime-probe.mjs", import.meta.url)), probeModule);
		// A launcher stand-in: a Bun running an entry that answers `--version` like OMP, and reports what it and a
		// child process it starts see in BUN_OPTIONS once the probe module has run.
		const entry = path.join(directory, "entry.mjs");
		await writeFile(entry, [
			'import { spawnSync } from "node:child_process";',
			'const child = spawnSync(process.execPath, ["-e", "console.log(process.env.BUN_OPTIONS ?? \'unset\')"], { encoding: "utf8" });',
			'console.log("omp/1.0.0 own:" + (process.env.BUN_OPTIONS ?? "unset") + " child:" + child.stdout.trim());',
		].join("\n"));
		const hostControl = path.join(directory, "host-control.mjs");
		await writeFile(hostControl, "export {};\n");

		const plan = await capability.planControlLaunch(
			{ command: bun, prefixArgs: [entry] },
			control({ modulePath: hostControl, probeModulePath: probeModule }),
			new capability.CarrierMemory(),
		);
		assert.equal(plan.delivered, true, plan.log ?? "the probe did not show the flags honoured");
		assert.equal(plan.runtime.carrier, "bun-options");

		const probeEnv = planRuntimeFlags({ define: { name: "__OMP_VSCODE_PROBE_NONCE", value: "abc123" }, preload: probeModule }, "bun-options", undefined).env;
		const run = spawnSync(bun, [entry, "--version"], { env: { ...process.env, ...probeEnv }, encoding: "utf8" });
		assert.match(run.stderr, /^OMP_DESK_RUNTIME_PROBE abc123\r?\n/m, "the preload and the define reached Bun through BUN_OPTIONS");
		assert.match(run.stdout, /own:unset child:unset/, "the module put the original (unset) BUN_OPTIONS back for the process and its children");
	});
});

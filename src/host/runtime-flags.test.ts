/**
 * How Desk's Bun flags are carried (ADR-0075): on the command line for Bun's own CLI, through `BUN_OPTIONS` for a
 * launcher that is not, and not at all when neither works. The encoding is pinned against what Bun 1.4's
 * `BUN_OPTIONS` parser does with it (white space splits, a backslash escapes, a quoted `--preload` value is
 * silently ignored); the real-Bun end of that is exercised by `launch-capability.test.ts`.
 *
 * Runner: `node --test src/host/runtime-flags.test.ts`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BUN_OPTIONS_BASE_ENV, restoreInheritedBunOptions } from "./control-protocol.ts";
import { encodeBunOption, NO_RUNTIME_FLAGS, planRuntimeFlags } from "./runtime-flags.ts";

const FLAGS = { define: { name: "__OMP_VSCODE_RECIPIENT_PUBLIC_KEY", value: "cHVibGljLXJlY2lwaWVudA" }, preload: "C:\\Users\\Jane Doe\\AppData\\host control.mjs" } as const;

describe("encodeBunOption", () => {
	it("leaves plainly safe text alone", () => {
		assert.equal(encodeBunOption("C:/work/host-control_1.mjs"), "C:/work/host-control_1.mjs");
	});
	it("escapes white space, backslashes, quotes and non-ASCII letters with a backslash", () => {
		assert.equal(encodeBunOption("C:\\Jane Doe\\a.mjs"), "C:\\\\Jane\\ Doe\\\\a.mjs");
		assert.equal(encodeBunOption('N:"v"'), 'N:\\"v\\"');
		assert.equal(encodeBunOption("ü日"), "\\ü\\日");
	});
});

describe("planRuntimeFlags", () => {
	it("delivers nothing when there is nothing to deliver or no carrier", () => {
		assert.equal(planRuntimeFlags(null, "argv", undefined), NO_RUNTIME_FLAGS);
		assert.equal(planRuntimeFlags(FLAGS, "none", "--smol"), NO_RUNTIME_FLAGS);
		assert.deepEqual(NO_RUNTIME_FLAGS, { carrier: "none", args: [], env: {} });
	});

	it("puts the define and the preload on the command line for argv, with no environment", () => {
		assert.deepEqual(planRuntimeFlags(FLAGS, "argv", "--smol"), {
			carrier: "argv",
			args: ["--define", '__OMP_VSCODE_RECIPIENT_PUBLIC_KEY:"cHVibGljLXJlY2lwaWVudA"', "--preload", FLAGS.preload],
			env: {},
		});
	});

	it("leaves out the define for a preload-only request", () => {
		assert.deepEqual(planRuntimeFlags({ define: null, preload: "C:/a.mjs" }, "argv", undefined).args, ["--preload", "C:/a.mjs"]);
	});

	it("carries the same flags in BUN_OPTIONS, escaped, with no command-line arguments", () => {
		const plan = planRuntimeFlags(FLAGS, "bun-options", undefined);
		assert.equal(plan.carrier, "bun-options");
		assert.deepEqual(plan.args, []);
		assert.equal(
			plan.env.BUN_OPTIONS,
			"--define __OMP_VSCODE_RECIPIENT_PUBLIC_KEY:\\\"cHVibGljLXJlY2lwaWVudA\\\" --preload C:\\\\Users\\\\Jane\\ Doe\\\\AppData\\\\host\\ control.mjs",
		);
		assert.equal(plan.env[BUN_OPTIONS_BASE_ENV], "", "an unset BUN_OPTIONS is what the preloaded module puts back");
	});

	it("keeps a BUN_OPTIONS the user already has, in front, and remembers it exactly", () => {
		const plan = planRuntimeFlags({ define: null, preload: "C:/a.mjs" }, "bun-options", "--smol --hot");
		assert.equal(plan.env.BUN_OPTIONS, "--smol --hot --preload C:/a.mjs");
		assert.equal(plan.env[BUN_OPTIONS_BASE_ENV], "--smol --hot");
	});

	it("never carries the control key or the private recipient: only what the request holds", () => {
		const text = JSON.stringify(planRuntimeFlags(FLAGS, "bun-options", undefined));
		assert.ok(!/PRIVATE|BEGIN/.test(text));
	});
});

describe("restoreInheritedBunOptions", () => {
	it("puts the user's BUN_OPTIONS back and removes the marker", () => {
		const env: Record<string, string | undefined> = { BUN_OPTIONS: "--smol --preload x", [BUN_OPTIONS_BASE_ENV]: "--smol" };
		restoreInheritedBunOptions(env);
		assert.deepEqual(env, { BUN_OPTIONS: "--smol" });
	});
	it("removes BUN_OPTIONS when it was unset before the launch", () => {
		const env: Record<string, string | undefined> = { BUN_OPTIONS: "--preload x", [BUN_OPTIONS_BASE_ENV]: "" };
		restoreInheritedBunOptions(env);
		assert.deepEqual(env, {});
	});
	it("does nothing for a launch that did not use BUN_OPTIONS", () => {
		const env: Record<string, string | undefined> = { BUN_OPTIONS: "--smol" };
		restoreInheritedBunOptions(env);
		assert.deepEqual(env, { BUN_OPTIONS: "--smol" });
	});
});

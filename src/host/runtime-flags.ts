/**
 * How Desk's Bun runtime flags (`--define` for the public recipient, `--preload` for a Desk module) reach the
 * OMP process (ADR-0075).
 *
 * Bun's flags are Bun's, not OMP's. A launcher that *is* Bun's CLI (`bun.exe <entry>`, the bun-global shim)
 * takes them on its command line, ahead of the entry. OMP's own compiled executable (the winget portable
 * package, the `omp.sh` binary install, a mise install) has a command line that is OMP's alone: Bun's flags
 * there are OMP's unknown flags and OMP exits with code 2. Bun reads the same flags from `BUN_OPTIONS` at
 * startup, which a compiled executable may or may not honour, so a carrier other than argv is only ever used
 * after `launch-capability.ts` has observed it work on that exact executable.
 *
 * The recipient is public by construction (ADR-0006), so the define may sit in argv or in the environment; the
 * control key and the private recipient never do.
 */
import { BUN_OPTIONS_BASE_ENV } from "./control-protocol.ts";
import type { NativeControlBootstrap } from "./native-terminal";

/** `argv`: on the command line, before the launcher's own prefix. `bun-options`: in `BUN_OPTIONS`. `none`: not delivered. */
export type RuntimeFlagCarrier = "argv" | "bun-options" | "none";

/** What Bun should do at startup: preload one module, optionally with one string define. */
export interface RuntimeFlagSet {
	readonly define: { readonly name: string; readonly value: string } | null;
	readonly preload: string;
}

/** The command-line prefix and environment deltas one launch carries the flags in. */
export interface RuntimeFlagPlan {
	readonly carrier: RuntimeFlagCarrier;
	/** Arguments that precede the launcher's own prefix arguments. */
	readonly args: readonly string[];
	/** Environment deltas for the child. */
	readonly env: Readonly<Record<string, string>>;
}

/** Nothing delivered: the launch runs as OMP alone. */
export const NO_RUNTIME_FLAGS: RuntimeFlagPlan = { carrier: "none", args: [], env: {} };

/** The flags the host-control module needs: its own module preloaded, the recipient defined. */
export function controlRuntimeFlagSet(control: NativeControlBootstrap): RuntimeFlagSet {
	return { define: { name: control.defineName, value: control.publicRecipient }, preload: control.modulePath };
}

/**
 * One `BUN_OPTIONS` token. Bun splits the variable on white space and treats a backslash as an escape, so
 * every character that is not plainly safe is escaped: a path with spaces, non-ASCII letters or Windows
 * separators, and the quotes of a string literal, each reach Bun as exactly that text. (A quoted token is not
 * safe here: `--preload "C:\x"` is silently ignored by Bun 1.4.)
 */
export function encodeBunOption(value: string): string {
	return value.replace(/[^A-Za-z0-9_\-./:]/gu, character => `\\${character}`);
}

/** The `--define` argument for a string literal. */
function defineArgument(define: { readonly name: string; readonly value: string }): string {
	return `${define.name}:${JSON.stringify(define.value)}`;
}

/**
 * The plan that delivers `flags` through `carrier`. `inheritedBunOptions` is the `BUN_OPTIONS` this process has;
 * an existing value is kept in front of Desk's, and the module Bun preloads puts it back for every process OMP
 * starts (`restoreInheritedBunOptions`).
 */
export function planRuntimeFlags(
	flags: RuntimeFlagSet | null,
	carrier: RuntimeFlagCarrier,
	inheritedBunOptions: string | undefined,
): RuntimeFlagPlan {
	if (flags === null || carrier === "none") return NO_RUNTIME_FLAGS;
	if (carrier === "argv") {
		return {
			carrier,
			args: [...(flags.define === null ? [] : ["--define", defineArgument(flags.define)]), "--preload", flags.preload],
			env: {},
		};
	}
	const tokens = [
		...(flags.define === null ? [] : ["--define", encodeBunOption(defineArgument(flags.define))]),
		"--preload",
		encodeBunOption(flags.preload),
	];
	const base = inheritedBunOptions ?? "";
	return {
		carrier,
		args: [],
		env: {
			BUN_OPTIONS: base.trim() === "" ? tokens.join(" ") : `${base} ${tokens.join(" ")}`,
			[BUN_OPTIONS_BASE_ENV]: base,
		},
	};
}

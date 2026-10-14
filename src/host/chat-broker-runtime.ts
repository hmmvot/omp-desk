/**
 * Which runtime a Chat broker starts on
 * ([ADR-0074](../../docs/decisions/0074-run-chat-brokers-on-the-sessions-own-bun-runtime-with-code-exe-as-fallback.md),
 * [design](../../docs/designs/2026-10-14-chat-brokers-on-the-session-bun-runtime.md)).
 *
 * A Chat (`managed-rpc`) broker starts on the `bun.exe` the session's own OMP launch uses, so VS Code's updater, which
 * ends every `Code.exe` of the install, leaves the Chat running. Everything that decides eligibility without running
 * anything lives here and is pure or takes its file-system reads as parameters; the proof, the trust read and the
 * spawn are `PtyBrokerClient`'s.
 */

import { realpath } from "node:fs/promises";
import path from "node:path";

/** The setting that chooses the runtime. `auto` uses Bun when eligible; `vscode` always uses `Code.exe`. */
export const CHAT_BROKER_RUNTIME_SETTING = "ompDesk.chatBrokerRuntime";

export type ChatBrokerRuntimeSetting = "auto" | "vscode";

/** What a resolved launch target is; see `OmpBinary.launcher` in `native-terminal.ts`, which re-exports it. */
export type OmpLauncherKind = "bun-shim" | "program";

/** The part of a resolved OMP launch ({@link OmpBinary} in `native-terminal.ts`) that decides the broker runtime. */
export interface OmpLaunchFacts {
	readonly command: string;
	readonly launcher?: OmpLauncherKind;
}

/** The oldest Bun a Chat broker is started on. */
export const MIN_BUN_VERSION = "1.4.0";

/** Why a Chat broker is not started on Bun. The text is for the log; the code is for tests and counting. */
export type ChatBrokerFallbackCode = "setting" | "platform" | "launcher" | "executable" | "trust" | "proof" | "version" | "changed" | "start";

export interface ChatBrokerFallback {
	readonly code: ChatBrokerFallbackCode;
	readonly detail: string;
}

/** The runtime one Chat broker start decided on. */
export type ChatBrokerRuntimeChoice =
	| { readonly kind: "bun"; readonly executable: string; readonly version: string }
	| { readonly kind: "vscode"; readonly fallback: ChatBrokerFallback };

/** The sentence the log carries for one Chat launch. */
export function describeChatBrokerChoice(choice: ChatBrokerRuntimeChoice): string {
	return choice.kind === "bun"
		? `Chat broker runtime: Bun ${choice.version} (${choice.executable}); a VS Code update does not end it.`
		: `Chat broker runtime: VS Code (Code.exe), because ${choice.fallback.detail}; a VS Code update ends it.`;
}

/**
 * The log level of that sentence. A launch that is not on Bun because of what the user set or how OMP was installed
 * (`setting`, `platform`, `launcher`, `executable`: a standalone `omp.exe` has no Bun of its own to share) is the
 * expected outcome and `info`; one that lost Bun to something that was eligible in principle (`trust`, `proof`,
 * `version`, `changed`, `start`) is degraded-but-continuing and `warn`.
 */
export function chatBrokerChoiceLevel(choice: ChatBrokerRuntimeChoice): "info" | "warn" {
	if (choice.kind === "bun") return "info";
	switch (choice.fallback.code) {
		case "setting":
		case "platform":
		case "launcher":
		case "executable":
			return "info";
		default:
			return "warn";
	}
}

/** `1.4.3`, `1.4.10` and `1.5.0-canary` parse; anything else does not. */
function parseVersion(version: string): { readonly numbers: readonly [number, number, number]; readonly prerelease: boolean } | null {
	const match = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.exec(version);
	if (match === null) return null;
	return { numbers: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease: match[4] !== undefined };
}

/** Whether `version` is at least {@link MIN_BUN_VERSION}. A pre-release of the minimum itself is older than it. */
export function isSupportedBunVersion(version: string): boolean {
	const found = parseVersion(version);
	const minimum = parseVersion(MIN_BUN_VERSION);
	if (found === null || minimum === null) return false;
	for (let index = 0; index < 3; index += 1) {
		const difference = (found.numbers[index] as number) - (minimum.numbers[index] as number);
		if (difference !== 0) return difference > 0;
	}
	return !found.prerelease;
}

export interface BunLaunchDeps {
	readonly platform?: NodeJS.Platform;
	readonly arch?: string;
	readonly realpath?: (file: string) => Promise<string>;
}

/**
 * The `bun.exe` of a session's OMP launch, at its real path, or why this launch is not on Bun. Only a bun shim
 * qualifies: its `command` is the `bun.exe` that already runs the OMP entry. A compiled OMP program is not a Bun
 * for this purpose, and a launch built by hand (no `launcher`) is never one.
 */
export async function inspectBunLaunch(
	binary: OmpLaunchFacts,
	deps: BunLaunchDeps = {},
): Promise<{ readonly ok: true; readonly executable: string } | { readonly ok: false; readonly fallback: ChatBrokerFallback }> {
	const platform = deps.platform ?? process.platform;
	const arch = deps.arch ?? process.arch;
	if (platform !== "win32" || arch !== "x64") {
		return { ok: false, fallback: { code: "platform", detail: `Bun brokers are verified on Windows x64 only; this host is ${platform} ${arch}` } };
	}
	if (binary.launcher !== "bun-shim") {
		const standalone =
			binary.launcher === "program"
				? "this session's OMP is OMP's own compiled program (a standalone install; the Bun inside it is private to it), not launched through a bun shim, so there is no Bun to host the broker"
				: "this session's OMP is not launched through a bun shim, so there is no Bun to host the broker";
		return { ok: false, fallback: { code: "launcher", detail: standalone } };
	}
	if (!path.isAbsolute(binary.command) || path.basename(binary.command).toLowerCase() !== "bun.exe") {
		return { ok: false, fallback: { code: "executable", detail: `the launch command ${binary.command} is not an absolute path to bun.exe` } };
	}
	let real: string;
	try {
		real = await (deps.realpath ?? realpath)(binary.command);
	} catch (error) {
		return { ok: false, fallback: { code: "executable", detail: `${binary.command} could not be resolved (${error instanceof Error ? error.message : String(error)})` } };
	}
	if (path.basename(real).toLowerCase() !== "bun.exe") {
		return { ok: false, fallback: { code: "executable", detail: `${binary.command} resolves to ${real}, which is not bun.exe` } };
	}
	return { ok: true, executable: real };
}

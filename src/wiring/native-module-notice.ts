/**
 * OMP Desk — tell the user, once per window, that the native module could not be loaded and what to do about it.
 *
 * There is no PowerShell fallback (ADR-0076, decision 6): without `koffi.node` every Windows check reads as unknown, so launching
 * a session and re-attaching a running Chat refuse. A person who sees only "the broker state directory is not usable" cannot act
 * on that, so the window shows this message when the one load settles as unavailable. It classifies the cause where Windows
 * lets us, keeps the raw error in the log, and offers the three things an administrator needs: the facts for an allow rule,
 * the user-guide section that explains it, and a Reload Window that stages and loads again.
 *
 * Retry is a window reload, not an in-place reload of the module: other readers of this window already hold the unavailable
 * answer (the broker client's cached state-directory verdict, this window's claim without its creation time), and a module
 * that appears under them would leave those stale until the next reload anyway.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "../shared/logger.ts";
import { RUNTIME_ASSET_DIRECTORY } from "../host/runtime-assets.ts";
import { classifyNativeFailure, nativeDiagnosticsText, nativeFailureMessage, type NativeFailure } from "../host/native-module-failure.ts";

/** The buttons, in the order they are offered. */
export const NATIVE_NOTICE_COPY = "Copy diagnostics";
export const NATIVE_NOTICE_TROUBLESHOOTING = "Open troubleshooting";
export const NATIVE_NOTICE_RELOAD = "Reload Window";

/** What VS Code and the machine give the notice. */
export interface NativeNoticePort {
	/** The raw message of the load's failure, as recorded by the loader; `null` when it did not fail. */
	readonly failure: () => string | null;
	/** Show an error with buttons; resolves to the one chosen, `undefined` when it was dismissed. */
	readonly showError: (message: string, buttons: readonly string[]) => PromiseLike<string | undefined>;
	readonly copy: (text: string) => PromiseLike<void>;
	readonly openTroubleshooting: () => PromiseLike<unknown>;
	readonly reloadWindow: () => PromiseLike<unknown>;
	/** The text "Copy diagnostics" copies; see {@link nativeDiagnosticsFor}. */
	readonly diagnostics: (failure: NativeFailure) => Promise<string>;
	readonly log: Logger;
}

/**
 * Show the message for a load that settled as unavailable. Call it once, when the load settles; a load that did not fail shows
 * nothing. Resolves when the person has answered or dismissed it, and never throws.
 */
export async function announceNativeFailure(port: NativeNoticePort): Promise<void> {
	const raw = port.failure();
	if (raw === null) return;
	const failure = classifyNativeFailure(raw);
	port.log.warn(`the native module is unavailable (${failure.kind}${failure.code === null ? "" : `, Windows error ${failure.code}`}): ${raw}`);
	try {
		const picked = await port.showError(nativeFailureMessage(failure), [NATIVE_NOTICE_COPY, NATIVE_NOTICE_TROUBLESHOOTING, NATIVE_NOTICE_RELOAD]);
		if (picked === NATIVE_NOTICE_COPY) await port.copy(await port.diagnostics(failure));
		else if (picked === NATIVE_NOTICE_TROUBLESHOOTING) await port.openTroubleshooting();
		else if (picked === NATIVE_NOTICE_RELOAD) await port.reloadWindow();
	} catch (error) {
		port.log.warn(`the native module notice failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}

async function digestOf(file: string): Promise<string | null> {
	try {
		return createHash("sha256").update(await readFile(file)).digest("hex");
	} catch {
		return null;
	}
}

/**
 * The diagnostics text for a failure: the shipped module and its digest, and where its staged copy is (the staging directory is
 * named by the shipped digest, so it is known even when staging never produced the file).
 */
export async function nativeDiagnosticsFor(input: {
	readonly failure: NativeFailure;
	readonly shippedPath: string;
	readonly storageDir: string;
	readonly vscodeVersion: string;
	readonly deskVersion: string;
	readonly arch: string;
}): Promise<string> {
	const shippedSha = await digestOf(input.shippedPath);
	const stagedPath = shippedSha === null ? null : path.join(input.storageDir, RUNTIME_ASSET_DIRECTORY, shippedSha, path.basename(input.shippedPath));
	return nativeDiagnosticsText({
		failure: input.failure,
		shipped: { path: input.shippedPath, sha256: shippedSha },
		staged: stagedPath === null ? null : { path: stagedPath, sha256: await digestOf(stagedPath) },
		vscodeVersion: input.vscodeVersion,
		deskVersion: input.deskVersion,
		arch: input.arch,
	});
}

/**
 * Test-only: the loader's failure a run of the extension is told to simulate, so the message can be seen where the real cause
 * (an application-control policy) cannot be produced on a test machine. `OMPDESK_TEST_NATIVE_FAILURE` names a Windows error
 * (`1260`, `577`, `225`), `timeout` or `other`; anything else (including unset) simulates nothing. The messages are the ones
 * Windows and Node give for these causes. The name has no `OMP_` prefix because `scripts/test-vscode.ps1` removes every
 * `OMP_*` variable from the window it launches.
 */
export function simulatedNativeFailure(value: string | undefined): string | null {
	switch (value) {
		case "1260":
			return "the native module did not load (This program is blocked by group policy. For more information, contact your system administrator.)";
		case "577":
			return "the native module did not load (Windows cannot verify the digital signature for this file.)";
		case "225":
			return "the native module did not load (Operation did not complete successfully because the file contains a virus or potentially unwanted software.)";
		case "timeout":
			return "the native stage child did not answer in 60000 ms";
		case "other":
			return "the native module did not load (something nobody has seen before)";
		default:
			return null;
	}
}

/**
 * Test-only: how long the native module's staging is held back, so a slow machine can be reproduced by slowing only that one step
 * (every Windows check waits for the module). `OMPDESK_TEST_NATIVE_DELAY_MS` is a number of milliseconds; anything else, including
 * unset, is no delay.
 */
export function simulatedNativeDelayMs(value: string | undefined): number {
	const ms = Number(value);
	return Number.isFinite(ms) && ms > 0 ? Math.min(ms, 60_000) : 0;
}

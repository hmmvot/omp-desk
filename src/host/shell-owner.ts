/**
 * The folder-shell owner hint (ADR-0030).
 *
 * A folder shell's broker may make one finite, best-effort stop attempt after the
 * verified owning VS Code main process exits. The extension host cannot prove that
 * association itself; it can only hint at it, and the broker's privately staged helper
 * decides whether the hint is attested.
 *
 * Every failure here is fail-closed: a value that cannot be read as a plain process id
 * is never guessed, padded or carried as `0`. When no complete, usable hint can be
 * built the answer is `null`, which the broker turns into a disabled automatic stop.
 * The shell then keeps running until the user closes it, which is the safe direction.
 *
 * The three numbers are only candidates:
 *
 * - `extensionHostPid` — this process, which is the caller the broker authenticates;
 * - `parentPid` — this process's direct parent, read from the OS, never assumed;
 * - `mainPid` — the candidate named by `VSCODE_PID`, which VS Code sets in its primary
 *   process and which may be absent, stale or something else entirely.
 *
 * The broker re-reads all three from the kernel and requires them to agree before it
 * accepts any association; nothing here is trusted as fact.
 */

import { isPtyOwnerHint, type PtyOwnerHint } from "./pty-protocol.ts";

/** Values an owner hint is read from: process identity plus `VSCODE_PID`. */
export interface FolderShellOwnerSource {
	readonly extensionHostPid: number;
	readonly parentPid: number;
	readonly vscodePid: string | undefined;
}

/**
 * The candidate owning main process id named by `VSCODE_PID`, or `null`.
 *
 * Only a plain decimal integer names a pid. An empty or whitespace-only value, a signed,
 * hexadecimal or floating-point spelling, or trailing text is refused rather than parsed
 * loosely: `Number.parseInt` would turn `"12abc"` into `12`, and a number invented that
 * way would be compared as if it had been observed. Whether the number is a usable pid
 * is left to the protocol's own guard in {@link folderShellOwnerHint}.
 */
function candidateMainPid(value: string | undefined): number | null {
	if (typeof value !== "string") return null;
	const text = value.trim();
	if (!/^[0-9]+$/.test(text)) return null;
	return Number(text);
}

/**
 * The owner hint this extension host can offer for a folder shell, or `null`.
 *
 * `null` means "do not associate this shell with an owning instance"; the broker then
 * disables automatic stopping for it. That is the answer for a missing or unusable
 * extension-host/parent id, for a `VSCODE_PID` that is not a plain pid, and for a
 * candidate that names this very process: the VS Code main process cannot be the
 * extension host, so such a value is stale or foreign rather than an owner.
 *
 * What a hint is (three positive process ids, the candidate not being the caller) is
 * decided by the wire contract's own guard, so a hint built here is never one the
 * broker's decode would reject.
 */
export function folderShellOwnerHint(source: FolderShellOwnerSource): PtyOwnerHint | null {
	const mainPid = candidateMainPid(source.vscodePid);
	if (mainPid === null) return null;
	const hint: PtyOwnerHint = { extensionHostPid: source.extensionHostPid, parentPid: source.parentPid, mainPid };
	return isPtyOwnerHint(hint) ? hint : null;
}

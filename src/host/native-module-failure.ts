/**
 * Why the native module (`koffi.node`, ADR-0076) did not load, and what to tell the person who sees it.
 *
 * There is no PowerShell fallback (ADR-0076, decision 6 as completed by the maintainer's choice on O9): when the module cannot be
 * staged or loaded, every Windows check is unknown and launching or attaching Chat refuses. That is only acceptable if the cause
 * is named and the remedy is in front of the user, so this file turns the raw error into one of four classes, and the class into
 * the text of the notification, of the diagnostics the user copies, and of the launch refusal. The raw error stays in the log.
 *
 * Windows reports a blocked load as a localized message and node exposes no error number for it, so the class is read from
 * the English text of the message, from the hexadecimal and decimal codes some messages carry, and from this extension's own
 * wording for the staging failures. A localized message that matches none of them is `other`: the notification then shows the raw
 * text, which is what an administrator needs anyway. Nothing here imports `vscode`.
 */

import { describeForeignAccess, findForeignAccess, foreignAccessDiagnostics, type ForeignAccess } from "./foreign-access.ts";

/** The cause classes the notification distinguishes. */
export type NativeFailureClass = "blocked-by-policy" | "missing-or-quarantined" | "stage-timeout" | "foreign-account-access" | "other";

/** A native module failure: its class, the Windows error number when the message names one, and the raw message. */
export type NativeFailure =
	| {
			readonly kind: Exclude<NativeFailureClass, "foreign-account-access">;
			/** A Win32 error number the message names or implies (1260, 577, 225 …); `null` when it names none. */
			readonly code: number | null;
			readonly raw: string;
	  }
	| {
			/** The staged tree is reachable by an account other than the one running VS Code (ADR-0054): the check refused, correctly. */
			readonly kind: "foreign-account-access";
			readonly code: null;
			readonly raw: string;
			/** The refusal as facts: which folder, which account, what access, inherited or not, and who runs VS Code. */
			readonly foreign: ForeignAccess;
	  };

interface Signature {
	readonly code: number | null;
	readonly pattern: RegExp;
}

/** `ERROR_ACCESS_DISABLED_BY_POLICY`, `ERROR_INVALID_IMAGE_HASH` and the code-integrity statuses that mean "a policy refused this image". */
const POLICY: readonly Signature[] = [
	{ code: 1260, pattern: /blocked by group policy|ERROR_ACCESS_DISABLED_BY_POLICY|0x800704EC|(?:error|code)\s*:?\s*\(?1260\b/i },
	{ code: 577, pattern: /cannot verify the digital signature|ERROR_INVALID_IMAGE_HASH|0x80070241|0xC0000428|(?:error|code)\s*:?\s*\(?577\b/i },
	{ code: null, pattern: /application control|code integrity|AppLocker|WDAC|software restriction/i },
];

/** A file that is gone, held back or condemned by a scanner: `ERROR_MOD_NOT_FOUND`, the virus codes, `ENOENT`, and an access error on a read. */
const MISSING: readonly Signature[] = [
	{ code: 225, pattern: /contains a virus|potentially unwanted|ERROR_VIRUS_INFECTED|0x800700E1|(?:error|code)\s*:?\s*\(?225\b/i },
	{ code: 226, pattern: /ERROR_VIRUS_DELETED|0x800700E2|(?:error|code)\s*:?\s*\(?226\b|quarantine/i },
	{ code: 1920, pattern: /cannot be accessed by the system|ERROR_CANT_ACCESS_FILE|0x80070780|(?:error|code)\s*:?\s*\(?1920\b/i },
	{ code: 126, pattern: /specified module could not be found|ERROR_MOD_NOT_FOUND|0x8007007E|(?:error|code)\s*:?\s*\(?126\b/i },
	{ code: 2, pattern: /ENOENT|cannot find the file|no such file|ERROR_FILE_NOT_FOUND|0x80070002/i },
	{ code: 5, pattern: /EPERM|EACCES|access is denied|ERROR_ACCESS_DENIED|0x80070005/i },
];

/** The wording of `runNativeStage` when the stage child is killed at its deadline. */
const TIMEOUT = /native stage child did not answer in \d+ ms/i;

/** Classify the raw error of a failed staging or load. Never throws. */
export function classifyNativeFailure(raw: string): NativeFailure {
	// The extension's own refusal of the staged tree: a strict wording, so it is read before the Windows messages whose words a path could contain.
	const foreign = findForeignAccess(raw);
	if (foreign !== null) return { kind: "foreign-account-access", code: null, raw, foreign: foreign.access };
	if (TIMEOUT.test(raw)) return { kind: "stage-timeout", code: null, raw };
	for (const signature of POLICY) {
		if (signature.pattern.test(raw)) return { kind: "blocked-by-policy", code: signature.code, raw };
	}
	for (const signature of MISSING) {
		if (signature.pattern.test(raw)) return { kind: "missing-or-quarantined", code: signature.code, raw };
	}
	return { kind: "other", code: null, raw };
}

/** The sentences the notification and the launch refusal are made of. */
export interface NativeFailureText {
	/** One line: what happened. */
	readonly headline: string;
	/** The likely cause and what to do about it. */
	readonly remedy: string;
}

const REMEDY_MORE = "See Troubleshooting in the OMP Desk user guide.";

/** What the failure means for the person using the window. */
export function describeNativeFailure(failure: NativeFailure): NativeFailureText {
	switch (failure.kind) {
		case "foreign-account-access":
			return describeForeignAccess(failure.foreign, REMEDY_MORE);
		case "blocked-by-policy":
			return {
				headline: "Windows blocked OMP Desk's native module (koffi.node).",
				remedy: `An application-control policy (AppLocker, Windows Defender Application Control or a Software Restriction Policy) refused to load it${failure.code === null ? "" : ` (Windows error ${failure.code})`}. Ask your administrator to allow the file by hash, then choose Reload Window. ${REMEDY_MORE}`,
			};
		case "missing-or-quarantined":
			return {
				headline: "OMP Desk's native module (koffi.node) is missing or could not be read.",
				remedy: `An antivirus may have quarantined or locked it${failure.code === null ? "" : ` (Windows error ${failure.code})`}. Restore it from quarantine or exclude the OMP Desk folders, then choose Reload Window. ${REMEDY_MORE}`,
			};
		case "stage-timeout":
			return {
				headline: "OMP Desk's native module (koffi.node) did not start in time.",
				remedy: `A scanner or a very busy machine may be holding the file. Choose Reload Window to try again; if it keeps happening, exclude the OMP Desk folders from scanning. ${REMEDY_MORE}`,
			};
		case "other":
			return {
				headline: "OMP Desk's native module (koffi.node) could not be loaded.",
				remedy: `The cause is not one OMP Desk recognizes; the exact error is in the log and in Copy diagnostics. A policy or an antivirus is the usual cause. ${REMEDY_MORE}`,
			};
	}
}

/** What works and what does not while the module is unavailable; the same for every class. */
export const NATIVE_FAILURE_EFFECT =
	"Until it loads, New Session, Resume, and re-attaching a running Chat after a reload do not work, and the Sessions view cannot tell whether another OMP holds a session. Your saved sessions are still listed, and a stopped one still opens, read-only.";

/** The whole text of the notification, with the effect. */
export function nativeFailureMessage(failure: NativeFailure): string {
	const { headline, remedy } = describeNativeFailure(failure);
	return `${headline} ${remedy} ${NATIVE_FAILURE_EFFECT}`;
}

/**
 * The detail a refused check carries when the native module is unavailable. Without a recorded failure (no load was started,
 * or it is still running) it is the plain statement; with one it names the cause and points at the troubleshooting.
 */
export function nativeUnavailableDetail(raw: string | null): string {
	return raw === null ? "the native module is unavailable" : `the native module is unavailable (${describeNativeFailure(classifyNativeFailure(raw)).headline.replace(/\.$/, "")}): ${REMEDY_MORE}`;
}

/** The anchor, on the user guide's troubleshooting page, of the section the notification's troubleshooting button opens. */
export function nativeTroubleshootingAnchor(failure: NativeFailure): string {
	return failure.kind === "foreign-account-access" ? "another-windows-account-can-reach-omp-desks-folders" : "the-native-module-is-blocked-or-missing";
}

/** The facts "Copy diagnostics" puts on the clipboard. */
export interface NativeDiagnosticsInput {
	readonly failure: NativeFailure;
	/** The module as the VSIX ships it, with its digest (`null` when it could not be read). */
	readonly shipped: { readonly path: string; readonly sha256: string | null };
	/** Where the staged copy is (or would be) under the global storage; `null` when that cannot be derived because the shipped module is unreadable. `sha256` is `null` when nothing is there. */
	readonly staged: { readonly path: string; readonly sha256: string | null } | null;
	readonly vscodeVersion: string;
	readonly deskVersion: string;
	readonly arch: string;
}

/** The diagnostics, one fact per line, in the order an administrator needs them to write a rule. */
export function nativeDiagnosticsText(input: NativeDiagnosticsInput): string {
	const lines = [
		"OMP Desk native module diagnostics",
		`Cause class: ${input.failure.kind}`,
		`Windows error code: ${input.failure.code === null ? "not reported by the message" : input.failure.code}`,
		`Error: ${input.failure.raw.replace(/\s*\r?\n\s*/g, " ")}`,
		...(input.failure.kind === "foreign-account-access" ? foreignAccessDiagnostics(input.failure.foreign) : []),
		`Shipped koffi.node: ${input.shipped.path}`,
		`Shipped SHA-256: ${input.shipped.sha256 ?? "unreadable"}`,
		`Staged koffi.node: ${input.staged === null ? "unknown" : input.staged.path}`,
		`Staged SHA-256: ${input.staged === null ? "unknown" : (input.staged.sha256 ?? "not present")}`,
		`Architecture: ${input.arch}`,
		`VS Code: ${input.vscodeVersion}`,
		`OMP Desk: ${input.deskVersion}`,
	];
	return lines.join("\n");
}

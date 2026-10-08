/**
 * OMP Desk — the shared, environment-free primitives of read-only OMP
 * session discovery.
 *
 * `SessionIndex` remains the only owner of *what this extension manages*: exact
 * tracked files, claims, hosts and tab order. This module holds only what every
 * read-only pass over OMP's own session files has to agree on:
 *
 * - the shape and provenance of a session root ({@link NativeHistoryRoot}) and of
 *   the problems a pass can report ({@link NativeHistoryDiagnostic}, which covers
 *   rooted and profile problems only — a pass that reads individual files reports
 *   those through its own result type);
 * - how a path is classified without throwing ({@link probePathKind});
 * - which directory entries can be session files ({@link isSessionFileName}) and
 *   the single-line error text every diagnostic carries ({@link describeError}).
 *
 * Layout mirrored from OMP 18.2.11 (`src/session/session-listing.ts`): a sessions
 * root holds one directory per workspace and each of those holds `*.jsonl` files
 * named `<file-safe-timestamp>_<session-id>.jsonl`, so a pass enumerates the files
 * directly under a root and the files one workspace directory below it. Backup
 * files (`<primary>.jsonl.<snowflake>.bak`) never match and are left alone.
 *
 * History is discovered per folder, on demand, by `./folder-history.ts`, so a
 * folder's list is never a silent slice of a global snapshot. Nothing here
 * writes, renames, repairs or deletes, starts a process or takes a claim.
 * Header parsing stays the index's (`readSessionFileHeader`), so "this file is an
 * OMP session" means exactly the same thing in every pass.
 */
import * as fs from "node:fs";

/** Why a directory is being scanned. */
export type NativeHistoryRootSource =
	/** The ordinary default profile's sessions root, independent of any active profile. */
	| "default-profile"
	/** The sessions root of the profile the environment selects (`OMP_PROFILE`/`PI_PROFILE`). */
	| "active-profile"
	/** Another named profile's sessions root. */
	| "named-profile"
	/** An exact path the index already knows (a session file or its directory). */
	| "explicit";

export interface NativeHistoryRoot {
	/** Absolute directory to enumerate. */
	readonly root: string;
	/** OMP profile this root belongs to; `null` for the default profile. */
	readonly profile: string | null;
	readonly source: NativeHistoryRootSource;
}

export type NativeHistoryDiagnosticKind =
	/** The root does not exist; nothing to scan there. */
	| "missing-root"
	/** The root exists but could not be read (permissions, I/O error). */
	| "unreadable-root"
	/** A profile name in the index or the environment is not a valid OMP profile. */
	| "invalid-profile";

/** Something the user should be able to see instead of a silently shorter list. */
export interface NativeHistoryDiagnostic {
	readonly kind: NativeHistoryDiagnosticKind;
	/** Root the problem concerns, or `null` when it is not root-specific. */
	readonly root: string | null;
	readonly detail: string;
}

/** One line describing a thrown value; used for every diagnostic this module and the folder-scoped scan report. */
export function describeError(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

/**
 * The one path probe this feature uses, so a sessions root, an explicit index
 * path and a profile directory are classified identically. Platform error codes
 * are not enough on their own: Windows reports `ENOENT` for `readdir` on a path
 * that exists but is a file, which is not the same as a missing root.
 */
export async function probePathKind(target: string): Promise<"file" | "directory" | "missing"> {
	try {
		const stats = await fs.promises.stat(target);
		return stats.isDirectory() ? "directory" : "file";
	} catch {
		return "missing";
	}
}

/**
 * Whether a directory entry name is a session file. Backups are named
 * `<primary>.jsonl.<snowflake>.bak`, so they never match.
 */
export function isSessionFileName(name: string): boolean {
	return name.endsWith(".jsonl");
}

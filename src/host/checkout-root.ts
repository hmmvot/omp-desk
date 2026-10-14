/**
 * OMP Desk — the root of the version-control checkout a folder lies in.
 *
 * Sessions run at the checkout root of the folder VS Code has open (`ompDesk.runSessionsAtRepositoryRoot`, see
 * `session-folder.ts`). This module only answers "where is that root": it walks up from the folder and takes the
 * **nearest** ancestor, the folder itself included, that carries a root marker of a version-control system.
 * Nothing runs a VCS program: a marker is a `stat`.
 *
 * ## Markers
 *
 * | System                              | Marker at the checkout root                          | Notes |
 * | ----------------------------------- | ---------------------------------------------------- | ----- |
 * | Git                                 | `.git`, a directory **or** a file                    | The file is a worktree's or a submodule's pointer, so the innermost wins. |
 * | Mercurial                           | `.hg` directory                                      | |
 * | Sapling                             | `.sl` directory                                      | A Sapling clone that keeps Mercurial's name has `.hg`. |
 * | Jujutsu                             | `.jj` directory                                      | Also at a secondary workspace; a colocated repository has `.git` beside it. |
 * | Subversion                          | `.svn` directory                                     | One per working copy since 1.7. Before 1.7 every directory had one, so the folder itself is its own root. |
 * | Plastic SCM / Unity Version Control | `.plastic` directory                                 | The workspace root. |
 * | Bazaar / Breezy                     | `.bzr` directory                                     | |
 * | Fossil                              | `.fslckout` file, or `_FOSSIL_` file on Windows      | |
 * | Pijul                               | `.pijul` directory                                   | |
 * | Darcs                               | `_darcs` directory                                   | |
 * | CVS                                 | `CVS/Root` file in a directory whose parent has none | Every directory of a working copy has a `CVS` directory: the topmost of the run is the root. |
 * | Perforce                            | the file `P4CONFIG` names, else `.p4config`          | Perforce has no marker of its own; a P4CONFIG file at the workspace root is the convention. The name is read from this process's `P4CONFIG` variable (a value `p4 set` keeps in the Windows registry is not seen). |
 *
 * The last two are *weak*: a CVS directory and a P4CONFIG file say less than a repository directory does (a P4CONFIG
 * file also sits in a home folder, to configure every client), so they are not taken in a home folder or a drive root.
 *
 * ## Search
 *
 * - The search starts at the folder and goes up one directory at a time; the nearest marker wins, whatever its system.
 * - The home directory and a drive (or filesystem) root are never chosen because a walk ended there: only a strong marker
 *   in one of them (a dotfiles repository in the home folder) makes it a checkout root. The walk does not climb above the
 *   home directory of a folder inside it.
 * - It ends at the filesystem root. Each directory costs at most fifteen `stat` calls, made at once; a folder's answer is
 *   remembered by the caller (`SessionFolderResolver`), and `memo` lets the folders of one pass share the directories they
 *   climb through.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** The existence probe the search reads the file system through; `null` means absent or unreadable. */
export type PathKindProbe = (target: string) => Promise<"file" | "directory" | "other" | null>;

export const probePathKind: PathKindProbe = async target => {
	try {
		const stat = await fs.promises.stat(target);
		return stat.isFile() ? "file" : stat.isDirectory() ? "directory" : "other";
	} catch {
		return null;
	}
};

export type VersionControl =
	| "git" | "mercurial" | "sapling" | "jujutsu" | "subversion" | "plastic" | "bazaar" | "fossil" | "pijul" | "darcs" | "cvs" | "perforce";

export interface CheckoutMarker {
	readonly vcs: VersionControl;
	readonly name: string;
	/** The kinds of entry that count; a `.git` file points at a worktree's or submodule's repository. */
	readonly kinds: readonly ("file" | "directory")[];
}

/** The strong markers: one entry at a checkout root and nothing else. The one list the search reads. */
export const CHECKOUT_MARKERS: readonly CheckoutMarker[] = [
	{ vcs: "git", name: ".git", kinds: ["directory", "file"] },
	{ vcs: "mercurial", name: ".hg", kinds: ["directory"] },
	{ vcs: "sapling", name: ".sl", kinds: ["directory"] },
	{ vcs: "jujutsu", name: ".jj", kinds: ["directory"] },
	{ vcs: "subversion", name: ".svn", kinds: ["directory"] },
	{ vcs: "plastic", name: ".plastic", kinds: ["directory"] },
	{ vcs: "bazaar", name: ".bzr", kinds: ["directory"] },
	{ vcs: "fossil", name: ".fslckout", kinds: ["file"] },
	{ vcs: "fossil", name: "_FOSSIL_", kinds: ["file"] },
	{ vcs: "pijul", name: ".pijul", kinds: ["directory"] },
	{ vcs: "darcs", name: "_darcs", kinds: ["directory"] },
];

/** The conventional name of a Perforce configuration file, used whatever `P4CONFIG` says. */
export const DEFAULT_P4CONFIG = ".p4config";

export interface CheckoutRoot {
	readonly root: string;
	readonly vcs: VersionControl;
}

/** What one directory answered, shared by the folders of one pass. */
export type CheckoutMemo = Map<string, Promise<VersionControl | null>>;

export interface CheckoutSearch {
	readonly probe?: PathKindProbe;
	/** The home directory that is never chosen for lack of a marker; `null` for none. Defaults to the user's. */
	readonly home?: string | null;
	/** The value of the `P4CONFIG` variable. Defaults to this process's; empty or a path is ignored. */
	readonly p4config?: string | null;
	readonly memo?: CheckoutMemo;
}

/** The Perforce configuration file names to look for: the conventional one, and the configured one when it is a plain file name. */
function p4configNames(configured: string | null | undefined): readonly string[] {
	const name = configured === undefined ? process.env.P4CONFIG : configured;
	if (name === undefined || name === null || name === "" || name === "." || name === ".." || /[\\/]/.test(name) || name === DEFAULT_P4CONFIG) return [DEFAULT_P4CONFIG];
	return [DEFAULT_P4CONFIG, name];
}

async function strongMarkerAt(directory: string, probe: PathKindProbe): Promise<VersionControl | null> {
	const kinds = await Promise.all(CHECKOUT_MARKERS.map(marker => probe(path.join(directory, marker.name))));
	const at = CHECKOUT_MARKERS.findIndex((marker, index) => {
		const kind = kinds[index];
		return kind !== null && kind !== "other" && marker.kinds.includes(kind);
	});
	return at < 0 ? null : CHECKOUT_MARKERS[at]!.vcs;
}

async function weakMarkerAt(directory: string, probe: PathKindProbe, p4configs: readonly string[]): Promise<VersionControl | null> {
	const parent = path.dirname(directory);
	const [cvs, parentCvs, ...configs] = await Promise.all([
		probe(path.join(directory, "CVS", "Root")),
		probe(path.join(parent, "CVS", "Root")),
		...p4configs.map(name => probe(path.join(directory, name))),
	]);
	if (cvs === "file" && !(parent !== directory && parentCvs === "file")) return "cvs";
	return configs.includes("file") ? "perforce" : null;
}

/**
 * The nearest checkout root at or above `folder`, or `null` when none lies on the way up. Never throws: an unreadable
 * directory has no marker.
 */
export async function findCheckoutRoot(folder: string, search: CheckoutSearch = {}): Promise<CheckoutRoot | null> {
	const probe = search.probe ?? probePathKind;
	const configured = search.home === undefined ? os.homedir() : search.home;
	const home = configured === null || configured === "" ? null : path.resolve(configured);
	const p4configs = p4configNames(search.p4config);
	const memo = search.memo;
	for (let directory = path.resolve(folder); ; directory = path.dirname(directory)) {
		const atHome = home !== null && (process.platform === "win32" ? directory.toLowerCase() === home.toLowerCase() : directory === home);
		const atFilesystemRoot = path.dirname(directory) === directory;
		const answer = async (): Promise<VersionControl | null> => {
			const strong = await strongMarkerAt(directory, probe);
			if (strong !== null || atHome || atFilesystemRoot) return strong;
			return weakMarkerAt(directory, probe, p4configs);
		};
		let found: Promise<VersionControl | null>;
		if (memo === undefined) found = answer();
		else {
			found = memo.get(directory) ?? answer();
			memo.set(directory, found);
		}
		const vcs = await found;
		if (vcs !== null) return { root: directory, vcs };
		if (atHome || atFilesystemRoot) return null;
	}
}

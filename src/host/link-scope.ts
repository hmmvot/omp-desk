/**
 * What the two link resolvers (workspace symbols in `symbol-links.ts`, bare file names in `file-name-links.ts`)
 * and their callers share: the session's scope, a link outcome, a file lookup and the containment rule. A leaf, so
 * neither resolver imports the other's module for a type.
 */
import path from "node:path";
import type { BareFileName } from "../shared/code-symbols.ts";

/** Whether `file` is `root` or inside it (Windows rules: case-insensitive, either separator). */
export function isInside(root: string, file: string): boolean {
	if (root === "" || file === "") return false;
	const relative = path.win32.relative(root, file);
	return relative === "" || (relative !== ".." && !relative.startsWith("..\\") && !path.win32.isAbsolute(relative));
}

export type SymbolOutcome =
	| { readonly status: "found"; readonly target: string }
	| { readonly status: "none" }
	/** Several different definitions inside the session's folders: the page links to the workspace symbol search, never to one of them. With `files`, several files carry the name of a bare file name span and a click lets the user choose one. */
	| { readonly status: "ambiguous"; readonly definitions: number; readonly files?: true }
	| { readonly status: "unavailable" }
	/** Not a verdict: the provider is not ready or its queue is full; the token is asked again when the host signals a retry. */
	| { readonly status: "pending" };

export interface SymbolScope {
	/** The session's working directory: relative targets are relative to it, and it names the cache scope. */
	readonly cwd: string;
	readonly roots: readonly string[];
}

/** The files a name stands for inside the session's folders. */
export type FileLookup =
	| { readonly state: "none" }
	| { readonly state: "unique"; readonly path: string }
	| { readonly state: "many"; readonly paths: readonly string[] }
	/** The search failed, timed out or was refused, or files changed while it ran: no reliable answer yet. `waiting`: the search line was full, so the lookup was not tried; it is asked again once the line has drained. */
	| { readonly state: "unavailable"; readonly waiting?: true };

/** The bare-file-name side as the symbol resolver uses it (`FileNameLinkResolver` in `file-name-links.ts` implements it). */
export interface FileNameLinks {
	/** Moves on whenever answers are forgotten; a batch compares it before and after its file lookups. */
	readonly generation: number;
	/** Forget every answer: a file appeared, vanished or moved. */
	invalidate(): void;
	/** The link outcome for one span. */
	resolve(file: BareFileName, scope: SymbolScope): Promise<SymbolOutcome>;
	/** The files `reference` (a file name, or a name with the directories that end its path, `/`-separated) stands for inside `scope`. */
	lookup(reference: string, scope: SymbolScope): Promise<FileLookup>;
}

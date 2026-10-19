/**
 * OMP's `proc://` addresses of background jobs (`proc-protocol.ts` of OMP 18.11.1): `proc://` lists them, `proc://<id>` reads one,
 * `proc://<id>/kill` is a write that cancels it, `proc://<id>/mode` sets a service's lifetime. An id is a job id (`bg_30`), the name
 * of a task's agent or of a launched service.
 *
 * Chat links such an address to the Jobs row and never acts on it: the suffix says what OMP would do with a write, not what a click
 * does.
 */

/** What a `proc://` id and a job id may be: a word OMP minted, never one that could change a `/jobs kill` command. */
const ID = "[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}";
const WHOLE = new RegExp(`^proc://(${ID})?(?:/(kill|mode))?$`);
const IN_TEXT = new RegExp(`(?<![A-Za-z0-9_./:-])proc://(?:${ID})?(?:/(?:kill|mode))?(?![A-Za-z0-9_/])`, "g");
const JOB_ID = new RegExp(`^${ID}$`);

/** What a `proc://` address names. `id` is null for the bare listing. */
export interface ProcLink {
	id: string | null;
	suffix: "kill" | "mode" | null;
}

/** Whether `id` is a word OMP could have given a job. */
export function isJobId(id: string): boolean {
	return JOB_ID.test(id);
}

/** A whole text that is one `proc://` address, or null. */
export function parseProcLink(text: string): ProcLink | null {
	const match = WHOLE.exec(text.trim());
	if (match === null) return null;
	const id = match[1] ?? null;
	const suffix = match[2] === "kill" || match[2] === "mode" ? match[2] : null;
	// A suffix needs an id: `proc:///kill` names nothing.
	return suffix !== null && id === null ? null : { id, suffix };
}

/** The most `proc://` addresses one piece of prose links. */
const MAX_PER_TEXT = 100;

/** The `proc://` addresses in prose, in order and without overlap; each covers exactly its own characters (a sentence's closing punctuation is not one). */
export function detectProcLinks(text: string): { link: ProcLink; start: number; end: number }[] {
	const found: { link: ProcLink; start: number; end: number }[] = [];
	for (const match of text.matchAll(IN_TEXT)) {
		const trimmed = match[0].replace(/[.:-]+$/, "");
		const link = parseProcLink(trimmed);
		if (link !== null) found.push({ link, start: match.index, end: match.index + trimmed.length });
		if (found.length >= MAX_PER_TEXT) break;
	}
	return found;
}

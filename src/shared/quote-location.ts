/**
 * The location line of an editor quote (docs/designs/2026-10-15-quote-chat-selection.md, decisions 9 and 10): the host writes it,
 * the page recognises it, so the grammar lives in one place.
 *
 * - A working file is `path:42` or `path:42-50`.
 * - A side of a diff that is a Git revision says which version it is: `path:42-50 @ <version>`. The version is `index`, a
 *   commit-ish and, when the host resolved it, the commit (`HEAD (3f2a9c1)`, `main (3f2a9c1)`), or a bare short commit
 *   (`3f2a9c1`). The line numbers are those of that version of the file, not of the file on disk.
 */

/** The longest version a location may carry. */
export const MAX_QUOTE_VERSION_LENGTH = 128;

/** What separates the path and lines from the version. */
export const QUOTE_VERSION_SEPARATOR = " @ ";

/** `42` or `42-50`. */
export function lineRangeText(start: number, end: number): string {
	return start === end ? String(start) : `${start}-${end}`;
}

/** `src/app.ts:42-50`, or `src/app.ts:42-50 @ HEAD (3f2a9c1)` for a version other than the file on disk. */
export function quoteLocationText(path: string, start: number, end: number, version: string | null): string {
	const base = `${path}:${lineRangeText(start, end)}`;
	return version === null ? base : `${base}${QUOTE_VERSION_SEPARATOR}${version}`;
}

const REVISION_LOCATION = new RegExp(`:\\d+(?:-\\d+)?${QUOTE_VERSION_SEPARATOR}\\S[^\\r\\n\`]{0,${MAX_QUOTE_VERSION_LENGTH - 1}}$`);

/**
 * Whether `text` is a location of a Git revision (`src/app.ts:42-50 @ HEAD (3f2a9c1)`). The path in it names a file whose lines are
 * not the ones quoted, so the transcript must not link it to the file on disk.
 */
export function isRevisionLocation(text: string): boolean {
	return REVISION_LOCATION.test(text);
}

/** What separates the two sides of a hunk location: the modified side first, then the original side (`src/app.ts:3-5 was src/app.ts:3-4 @ HEAD (3f2a9c1)`). */
export const HUNK_LOCATION_SEPARATOR = " was ";

/**
 * The location line of a quoted hunk of a diff (decision 11): the lines of the modified side, then {@link HUNK_LOCATION_SEPARATOR}
 * and the lines of the original side, each as {@link quoteLocationText} writes it. A side that has no line in the hunk (a block that
 * only deletes, or only inserts) is left out, and then the location is the other side's alone.
 */
export function hunkLocationText(modified: string | null, original: string | null): string | null {
	if (modified === null) return original;
	return original === null ? modified : `${modified}${HUNK_LOCATION_SEPARATOR}${original}`;
}

const HUNK_LOCATION = new RegExp(`:\\d+(?:-\\d+)?(?:${QUOTE_VERSION_SEPARATOR}\\S[^\\r\\n\`]{0,${MAX_QUOTE_VERSION_LENGTH - 1}}?)?${HUNK_LOCATION_SEPARATOR}[^\\r\\n\`]{1,4096}:\\d+(?:-\\d+)?(?:${QUOTE_VERSION_SEPARATOR}\\S[^\\r\\n\`]{0,${MAX_QUOTE_VERSION_LENGTH - 1}})?$`);

/**
 * Whether `text` is the location of a hunk (`src/app.ts:3-5 was src/app.ts:3-4`): two paths and their lines, which no file link
 * opens, so the transcript must not make it one even when both sides are files on disk.
 */
export function isHunkLocation(text: string): boolean {
	return text.length <= 8192 && HUNK_LOCATION.test(text);
}

/**
 * Line wrapping of fenced code blocks in Chat. A block never wraps until the reader asks; the choice is per block and is kept for
 * the page's lifetime, because the transcript unmounts rows that scroll away and mounts them again.
 *
 * A block is named by the row that holds it, the content block of the message and its position in that Markdown text
 * ({@link codeWrapKey}); a block outside a transcript row has no name and keeps its choice only while it is mounted.
 */

/** The most blocks whose choice is remembered; the oldest choice is forgotten first. */
const WRAP_ENTRIES = 500;

const wrapped = new Set<string>();

/** The name of the block `block` of a Markdown text inside `scope`, or `null` when no row names the scope. */
export function codeWrapKey(scope: string | null, block: string | number): string | null {
	return scope === null ? null : `${scope}#${block}`;
}

/** Whether the reader turned wrapping on for this block; an unnamed block starts unwrapped. */
export function isCodeWrapped(key: string | null): boolean {
	return key !== null && wrapped.has(key);
}

export function setCodeWrapped(key: string | null, value: boolean): void {
	if (key === null) return;
	wrapped.delete(key);
	if (!value) return;
	wrapped.add(key);
	if (wrapped.size > WRAP_ENTRIES) wrapped.delete(wrapped.values().next().value as string);
}

/**
 * Whether the toggle is shown: while the block wraps (so it can be turned off, though a wrapped block has nothing to scroll) or while
 * its text is wider than the box. A pixel of slack keeps sub-pixel rounding from showing a button for a block that fits.
 */
export function showsWrapToggle(isWrapped: boolean, scrollWidth: number, clientWidth: number): boolean {
	return isWrapped || scrollWidth > clientWidth + 1;
}

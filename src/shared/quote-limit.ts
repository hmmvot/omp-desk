/**
 * How much Markdown one quote takes (docs/designs/2026-10-15-quote-chat-selection.md, decision 7): the one place the number and
 * the sentence that names it live, because both ends of a quote read them. The composer refuses a Chat quote with it, and the
 * extension host refuses an editor selection (`Alt+Q` in a text editor) with it before anything is posted to a page.
 */

/** The most characters of Markdown one quote takes, before the `> ` prefixes. */
export const MAX_QUOTE_CHARACTERS = 20_000;

/** `31482` as `31 482`. */
function grouped(count: number): string {
	return String(count).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

/** The notice for a quote over the limit, naming its size; `null` when it fits. */
export function quoteSizeRefusal(characters: number): string | null {
	return characters > MAX_QUOTE_CHARACTERS
		? `That selection is ${grouped(characters)} characters; Quote takes at most ${grouped(MAX_QUOTE_CHARACTERS)}.`
		: null;
}

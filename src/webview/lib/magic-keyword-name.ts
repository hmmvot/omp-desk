/**
 * The name of the CSS highlight that paints one stop of a keyword's gradient: `::highlight(omp-magic-<id>-<stop>)`.
 *
 * A leaf module, so the paint engine (`magic-keyword-paint.ts`, which fills the highlights) and the stylesheet generator
 * (`../magic-keyword-styles.ts`, which colours them) share the name without either depending on the other.
 */
import type { MagicKeywordId } from "../../shared/magic-keywords.ts";

/** The highlight of stop `stop` of a keyword's gradient. */
export function magicHighlightName(id: MagicKeywordId, stop: number): string {
	return `omp-magic-${id}-${stop}`;
}

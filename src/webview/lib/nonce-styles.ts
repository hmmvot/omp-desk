/**
 * Grant one document's own nonce to style elements script creates *in that document*.
 *
 * The extension host keeps stylesheet elements under
 * `style-src 'nonce-<N>' <cspSource>` without `'unsafe-inline'` in that directive.
 * A `<style>` element inserted *without* that document's nonce is refused by the
 * browser. This was measured in headless Chromium against exactly that policy: an
 * element created without the nonce left its target unstyled (`left: auto`), the
 * identical element carrying the nonce applied (`left: 9px`), while
 * `document.adoptedStyleSheets` and CSSOM (`element.style.x = …`) mutations were
 * allowed in both cases.
 *
 * The bundled terminal renderer creates its own `<style>` elements at runtime (the DOM
 * renderer's row rules and theme colours, the viewport's scrollbar colours). Without
 * this hook those styles would silently not apply and the terminal would be laid out
 * wrong.
 *
 * ## What this is not
 *
 * It is not a sanitizer, a provenance check or a security boundary, and it must not be
 * read as one. Precisely:
 *
 * - The document's nonce is already readable by any script that can run in it (that is
 *   how `readCspNonce` in `../bridge.ts` reads it, from the document's own script tag).
 * - `script-src` in this document also allows the extension's own `cspSource` origin, so
 *   a script loaded from the extension's resources runs here with or without this hook.
 * - Script in this document can already change styling without any `<style>` element, via
 *   CSSOM (`element.style`, `insertRule` on an allowed sheet) and `adoptedStyleSheets`.
 * - Only `Document.prototype.createElement` is intercepted: not `createElementNS`, not
 *   the HTML parser, not `cloneNode`, not `importNode`, and not another realm's
 *   `Document` class (a same-realm `Document` instance is handled by the receiver guard
 *   below). An element that arrives by any other route is left exactly as it is.
 *
 * What it does do is narrow: exactly one document instance — the one that installed it —
 * gets the nonce on exactly the style elements script creates in it, and nothing else is
 * touched. Stylesheet elements remain nonce-gated and trusted extension resources
 * remain allowed. Style-attribute permissions belong to the host's separate
 * `style-src-attr` policy; this hook changes no CSP directive.
 */

/** Signature of `Document.prototype.createElement`, the method this module wraps. */
type CreateElement = (this: Document, tagName: string, options?: ElementCreationOptions) => HTMLElement;

/**
 * True once this bundle's document installed the patch; separate from the receiver it
 * guards, because a document that did install is not necessarily the one being asked.
 */
let installed = false;

/**
 * The one document this install stamps, or `null` when it installed with no document.
 *
 * A module instance is per bundle per document, so one install serves one document; the
 * receiver guard is what keeps a *second* `Document` in the same realm from being
 * stamped by that install.
 */
let owner: Document | null = null;

/**
 * Install the patch for `nonce`, or do nothing when this document has no nonce.
 *
 * Idempotent: only the first call in this bundle's lifetime installs, so the nonce a
 * document was served with is the only one that can ever be stamped. Each entry point
 * passes the nonce it read from its own document tag (`readCspNonce`), and the patch
 * applies only to the document that is current when it installs.
 */
export function adoptNonceForCreatedStyles(nonce: string): void {
	if (installed || nonce.length === 0 || typeof Document === "undefined") return;
	installed = true;
	owner = typeof document === "undefined" ? null : document;
	const original = Document.prototype.createElement as CreateElement;
	Document.prototype.createElement = function patchedCreateElement(this: Document, tagName: string, options?: ElementCreationOptions): HTMLElement {
		const element = original.call(this, tagName, options);
		// The receiver decides: another Document instance in this realm keeps its own elements
		// exactly as it created them, and only a style element that carries no nonce yet is
		// stamped — an element that already has one is left as it is.
		if (this === owner && tagName.toLowerCase() === "style" && element.getAttribute("nonce") === null) {
			element.setAttribute("nonce", nonce);
		}
		return element;
	} as CreateElement;
}

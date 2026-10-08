/**
 * Tests for the nonce the terminal renderer's own styles need.
 *
 * Under the guest document's stylesheet policy
 * (`style-src 'nonce-…' <cspSource>`, without `'unsafe-inline'` in that directive),
 * a style element created without the nonce is refused, so xterm.js's runtime
 * rules would not apply and the terminal would be laid out wrong.
 *
 * The patch is deliberately once per bundle and *one* document, so these cases pin both
 * halves: the document that installed it is stamped on its style elements only, and
 * every other `Document` instance in the same realm — and every other kind of element —
 * is left exactly as it was created.
 *
 * Runner: `node --test src/webview/lib/nonce-styles.test.ts`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { adoptNonceForCreatedStyles } from "./nonce-styles.ts";

/** A document element stub: just the attribute surface the patch touches. */
class Element {
	readonly tagName: string;
	readonly #attributes = new Map<string, string>();
	constructor(tagName: string) {
		this.tagName = tagName;
	}
	getAttribute(name: string): string | null {
		return this.#attributes.get(name) ?? null;
	}
	setAttribute(name: string, value: string): void {
		this.#attributes.set(name, value);
	}
}

class DocumentStub {
	/** A nonce the document itself put on its elements before the patch saw them. */
	presetNonce: string | null = null;
	createElement(tagName: string): Element {
		const element = new Element(tagName);
		if (this.presetNonce !== null) element.setAttribute("nonce", this.presetNonce);
		return element;
	}
}

const owner = new DocumentStub();
const other = new DocumentStub();

describe("adoptNonceForCreatedStyles", () => {
	it("stamps the installing document's style elements, and only those", () => {
		Object.defineProperty(globalThis, "Document", { value: DocumentStub, configurable: true, writable: true });
		Object.defineProperty(globalThis, "document", { value: owner, configurable: true, writable: true });
		adoptNonceForCreatedStyles("abc123");
		try {
			assert.equal(owner.createElement("style").getAttribute("nonce"), "abc123");
			assert.equal(owner.createElement("STYLE").getAttribute("nonce"), "abc123", "the tag name is matched case-insensitively");
			assert.equal(owner.createElement("div").getAttribute("nonce"), null);
			assert.equal(owner.createElement("canvas").getAttribute("nonce"), null);

			// Another Document in the same realm did not install, so its elements are untouched:
			// the patch is bound to the document that asked for it, not to the realm.
			assert.equal(other.createElement("style").getAttribute("nonce"), null);

			// Even the owning document's pre-nonced style keeps its original value.
			owner.presetNonce = "host-nonce";
			assert.equal(owner.createElement("style").getAttribute("nonce"), "host-nonce");
			owner.presetNonce = null;

			// The nonce this document was served with is the only one that can apply, so a later
			// call must not exchange it for another value.
			adoptNonceForCreatedStyles("not-the-documents-nonce");
			assert.equal(owner.createElement("style").getAttribute("nonce"), "abc123");
		} finally {
			Reflect.deleteProperty(globalThis, "Document");
			Reflect.deleteProperty(globalThis, "document");
		}
	});
});

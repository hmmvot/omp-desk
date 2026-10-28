/**
 * Loads a script that ships beside the page's own bundle, on first use (ADR-0069, ADR-0085).
 *
 * The page is one classic script (`guest.js`, `shell.js`). A part of it that most pages never need (the diagram
 * renderer, the terminal renderer) is a script of its own that the page adds when it first needs it: the document's policy
 * allows scripts from its nonce and the extension's resource origin and nothing else, so the added script takes
 * its URL from the folder this page's own script came from and carries this document's nonce. Nothing in the document
 * policy, in `localResourceRoots` or in a message changes when another such script is added.
 */

/**
 * The script this bundle runs from: the other file is its sibling, and its nonce is the document's.
 * Read once, at start-up, while `document.currentScript` is still set; the fallback is the one `readCspNonce` uses.
 */
const ownScript: HTMLScriptElement | null = (() => {
	if (typeof document === "undefined") return null;
	if (document.currentScript instanceof HTMLScriptElement) return document.currentScript;
	return document.querySelector<HTMLScriptElement>("script[nonce][src]");
})();

/**
 * Add `name` (a file in the folder this page's script came from) as a nonce'd classic script and resolve once it has run.
 * Rejects when the page has no script of its own to take the folder from, or when the file cannot be fetched or run; a failed
 * element is removed, so a later call tries again.
 */
export async function loadSiblingScript(name: string): Promise<void> {
	if (ownScript === null || ownScript.src === "") throw new Error(`${name} cannot be located: the page has no script of its own`);
	const script = document.createElement("script");
	script.src = new URL(name, ownScript.src).href;
	if (ownScript.nonce !== "") script.nonce = ownScript.nonce;
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	script.addEventListener("load", () => resolve(), { once: true });
	script.addEventListener("error", () => reject(new Error(`${name} did not load`)), { once: true });
	document.head.append(script);
	try {
		await promise;
	} catch (error) {
		script.remove();
		throw error;
	}
}

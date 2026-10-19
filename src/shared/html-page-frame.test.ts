import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { HTML_PAGE_BOOTSTRAP, htmlPageFrameDocument, htmlPageFramePolicy } from "./html-page-frame.ts";

const hash = createHash("sha256").update(HTML_PAGE_BOOTSTRAP, "utf8").digest("base64");
const directives = new Map(htmlPageFramePolicy(hash).split("; ").map(part => [part.split(" ")[0]!, part.split(" ").slice(1).join(" ")] as const));

test("the frame's policy allows no request, frame, form or navigation of any kind", () => {
	assert.equal(directives.get("default-src"), "'none'");
	for (const name of ["connect-src", "frame-src", "child-src", "worker-src", "object-src", "manifest-src", "form-action", "base-uri"]) assert.equal(directives.get(name), "'none'", name);
	assert.equal(directives.get("sandbox"), "allow-scripts", "opaque origin, no popups, forms, modals, downloads or top navigation, even when opened on its own");
	for (const name of ["img-src", "font-src", "media-src"]) assert.match(directives.get(name)!, /^data:( blob:)?$/, `${name}: values made in the page only`);
});

test("the frame's scripts are the one hashed bootstrap and eval, and no policy has a host, a nonce or unsafe-inline for scripts", () => {
	assert.equal(directives.get("script-src"), `'sha256-${hash}' 'unsafe-eval'`);
	assert.equal(htmlPageFramePolicy(hash).includes("nonce"), false, "nothing the page can read lets it add a script or a stylesheet");
	assert.doesNotMatch(directives.get("script-src")!, /https?:|\*|unsafe-inline/);
	assert.equal(directives.get("style-src"), "'unsafe-inline'", "the page's own <style> and style= work; no stylesheet can be fetched");
});

test("the document is constant, holds exactly the hashed bootstrap and no model text slot", () => {
	const document = htmlPageFrameDocument();
	assert.equal(document, htmlPageFrameDocument());
	assert.equal(document.split("<script").length - 1, 1, "one script element");
	assert.ok(document.includes(`<script>${HTML_PAGE_BOOTSTRAP}</script>`));
	assert.equal(HTML_PAGE_BOOTSTRAP.includes("</script"), false);
	assert.equal(HTML_PAGE_BOOTSTRAP.includes("<!--"), false);
	assert.equal(/\r/.test(document), false, "the parser would normalize it and the hash would differ");
});

test("the bootstrap takes a message only from its parent and runs the page without a nonce", () => {
	assert.match(HTML_PAGE_BOOTSTRAP, /event\.source!==parentWindow/);
	assert.match(HTML_PAGE_BOOTSTRAP, /run=eval/);
	assert.match(HTML_PAGE_BOOTSTRAP, /new Function\("event"/);
	assert.equal(/nonce/i.test(HTML_PAGE_BOOTSTRAP), false);
});

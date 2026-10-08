import assert from "node:assert/strict";
import { test } from "node:test";
import { detectWebLinks } from "./chat-web-links.ts";
import { webLinkUrl } from "../terminal-links.ts";

test("bare URLs stop before sentence punctuation and unbalanced closing brackets, and cover exactly their characters", () => {
	const text = "Go to https://example.com. Then (see https://a.test/x?q=1), 'https://b.test/y'; [https://c.test/z] https://en.wikipedia.org/wiki/Foo_(bar) and https://d.test/e!?";
	const links = detectWebLinks(text);
	assert.deepEqual(links.map(link => text.slice(link.start, link.end)), [
		"https://example.com", "https://a.test/x?q=1", "https://b.test/y", "https://c.test/z", "https://en.wikipedia.org/wiki/Foo_(bar)", "https://d.test/e",
	]);
	assert.equal(links[0]!.target, "https://example.com/", "the target is the normalized URL");
});

test("only http(s) URLs with a host are web links; a scheme inside a word is not", () => {
	assert.deepEqual(detectWebLinks("javascript:alert(1) data:text/html,x command:run mailto:a@b.test file:///D:/a.ts ftp://x.test xhttps://y.test https:// http:z.test").map(link => link.target), []);
	assert.deepEqual(detectWebLinks("HTTPS://Example.COM/Path").map(link => link.target), ["https://example.com/Path"]);
	for (const refused of ["javascript:alert(1)", "data:text/html,x", "command:workbench.action.reloadWindow", "vscode://file/a", "file:///D:/a", "//example.com", "/relative", "https://", "https:example.com", "https://exa mple.com", "https://a\n.test"]) {
		assert.equal(webLinkUrl(refused), null, refused);
	}
	assert.equal(webLinkUrl(" https://example.com/a b "), "https://example.com/a%20b");
});

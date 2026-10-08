import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import { test } from "node:test";
import { ChatFileLinks, detectChatFileLinks, fileTargetOfHref, isFileLinkCandidate } from "./chat-file-links.ts";
import type { GuestHostMessage, GuestWebviewMessage } from "../messages.ts";

const targets = (text: string): string[] => detectChatFileLinks(text).map(link => link.target);

test("prose references keep their position, stop before trailing punctuation and cover exactly their own characters", () => {
	const text = "Edited src/foo.ts:12:4, then README.md. Also (see lib\\util.ts#L10-20) and docs/a.md:5-9; done.";
	assert.deepEqual(targets(text), ["src/foo.ts:12:4", "README.md", "lib\\util.ts#L10-20", "docs/a.md:5-9"]);
	for (const link of detectChatFileLinks(text)) assert.equal(text.slice(link.start, link.end), link.target, "the link covers the same characters the text already has");
});

test("Windows drive paths with spaces are one reference inside backticks and before an extension or position", () => {
	assert.deepEqual(targets("open `D:\\My Project\\src\\a b.ts:3:1` now"), ["D:\\My Project\\src\\a b.ts:3:1"]);
	assert.deepEqual(targets("open D:\\Work Space\\plain.ts:11:5 now"), ["D:\\Work Space\\plain.ts:11:5"]);
	assert.deepEqual(targets("at D:/repo/x.png."), ["D:/repo/x.png"]);
	assert.deepEqual(targets("open ~/notes/todo.md:4"), ["~/notes/todo.md:4"]);
});

test("@ mentions are one link that opens at the first line of their note", () => {
	const text = "Look at @src/a.ts [lines 12-30], @\"my dir/b.ts\" and @src/c.ts. Also @src/d.ts [line 7] and (@src/e.ts [lines 3-4, 9]).";
	const links = detectChatFileLinks(text);
	assert.deepEqual(links.map(link => link.target), ["src/a.ts:12", "my dir/b.ts", "src/c.ts", "src/d.ts:7", "src/e.ts:3"]);
	assert.deepEqual(links.map(link => text.slice(link.start, link.end)), ["@src/a.ts [lines 12-30]", "@\"my dir/b.ts\"", "@src/c.ts", "@src/d.ts [line 7]", "@src/e.ts [lines 3-4, 9]"]);
});

test("words, fractions, versions, flags and URLs are never candidates", () => {
	assert.deepEqual(targets("It's 1/3 of v1.2.3 with --flag/value and plain words"), []);
	assert.deepEqual(targets("see https://example.test/a.ts and mailto:a@b.test and javascript:alert(1)"), []);
	assert.equal(isFileLinkCandidate("Makefile"), false);
	assert.equal(isFileLinkCandidate("package.json"), true);
	assert.equal(isFileLinkCandidate("a/b"), true);
	assert.equal(isFileLinkCandidate("1/2"), false);
});

test("a Markdown destination is a file reference only for a path or a file URL", () => {
	assert.equal(fileTargetOfHref("docs/guide.md#L7"), "docs/guide.md#L7");
	assert.equal(fileTargetOfHref("./a%20b.ts"), "./a b.ts");
	assert.equal(fileTargetOfHref("D:/repo/a.ts"), "D:/repo/a.ts");
	assert.equal(fileTargetOfHref("file:///D:/repo/a.ts#L3"), "file:///D:/repo/a.ts#L3");
	for (const refused of ["https://example.test/a.ts", "http://x", "mailto:a@b.test", "javascript:alert(1)", "data:text/plain,x", "vscode://file/x", "command:workbench.action.reloadWindow", "#anchor", "?q=1", "//server/share/a.ts", "", "a\nb.ts"]) {
		assert.equal(fileTargetOfHref(refused), null, refused);
	}
});

function fixture(existing: readonly string[]) {
	const sent: GuestWebviewMessage[] = [];
	let deliver: (message: GuestHostMessage) => void = () => {};
	const transport = { post(message: GuestWebviewMessage) { sent.push(message); return true; }, subscribe(listener: (message: GuestHostMessage) => void) { deliver = listener; return () => {}; } };
	const answer = (message: GuestWebviewMessage | undefined) => {
		assert.ok(message !== undefined && message.type === "omp:terminal-link-validate");
		deliver({ type: "omp:terminal-link-validation", requestId: message.requestId, valid: existing.includes(message.target) });
	};
	return { sent, transport, answer };
}

test("validation reuses the Terminal request pair, is answered once per target and a click posts the open request", async () => {
	const { sent, transport, answer } = fixture(["src/a.ts:3"]);
	const links = new ChatFileLinks(transport);
	assert.equal(links.peek("src/a.ts:3"), undefined);
	const first = links.resolve("src/a.ts:3");
	const again = links.resolve("src/a.ts:3");
	assert.equal(sent.length, 1, "two asks for one target share one host request");
	answer(sent[0]);
	assert.equal(await first, true);
	assert.equal(await again, true);
	assert.equal(links.peek("src/a.ts:3"), true, "a repeat is answered from the cache");
	const missing = links.resolve("src/missing.ts");
	answer(sent[1]);
	assert.equal(await missing, false);
	links.open("src/a.ts:3");
	const opened = sent.at(-1);
	assert.ok(opened?.type === "omp:terminal-link-open");
	assert.equal(opened.target, "src/a.ts:3");
	assert.equal(sent.filter(message => message.type === "omp:terminal-link-validate").length, 2);
	links.dispose();
});

test("no more than eight validations wait on the host at once; the rest follow as answers arrive", async () => {
	const { sent, transport, answer } = fixture([]);
	const links = new ChatFileLinks(transport);
	const all = Array.from({ length: 12 }, (_, index) => links.resolve(`dir/file-${index}.ts`));
	assert.equal(sent.length, 8);
	answer(sent[0]);
	await all[0];
	await tick();
	assert.equal(sent.length, 9, "a finished validation frees one slot");
	for (let index = 1; index < 12; index++) { answer(sent[index]); await all[index]; await tick(); }
	assert.equal(sent.length, 12);
	links.dispose();
});

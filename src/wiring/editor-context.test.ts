/**
 * "OMP Desk: Add File to Session" and the location of "OMP Desk: Quote Selection to Session": the reference text, the paste bytes
 * and which sessions the picker offers.
 *
 * Runner: `node --test src/wiring/editor-context.test.ts`
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	EditorRecency,
	candidateDescription,
	composeEditorQuotes,
	composeInsertion,
	composeLineReference,
	formatReference,
	insertAvailability,
	newSessionFolder,
	orderCandidates,
	pickerEntries,
	selectionLines,
	visibleQuoteTarget,
} from "./editor-context.ts";
import type { EditorQuoteSource, SendCandidate } from "./editor-context.ts";
import { bracketedPaste } from "../host/bracketed-paste.ts";
import { MAX_FILE_PATH_LENGTH, MAX_INSERT_TEXT_LENGTH, MAX_QUOTE_LOCATION_LENGTH } from "../protocol/messages.ts";
import { MAX_QUOTE_VERSION_LENGTH } from "../shared/quote-location.ts";

const CWD = "D:\\Work\\Repo";

describe("selection line ranges", () => {
	it("are one-based and inclusive", () => {
		assert.deepEqual(selectionLines({ line: 11, character: 4 }, { line: 29, character: 10 }), { start: 12, end: 30 });
		assert.deepEqual(selectionLines({ line: 6, character: 0 }, { line: 6, character: 9 }), { start: 7, end: 7 });
	});

	it("stop at the previous line when the selection ends at column 0 of the next (a whole-line selection)", () => {
		assert.deepEqual(selectionLines({ line: 11, character: 0 }, { line: 30, character: 0 }), { start: 12, end: 30 });
	});

	it("read a backwards selection the same way", () => {
		assert.deepEqual(selectionLines({ line: 29, character: 10 }, { line: 11, character: 4 }), { start: 12, end: 30 });
	});

	it("keep a single column-0 position on its own line", () => {
		assert.deepEqual(selectionLines({ line: 4, character: 0 }, { line: 4, character: 0 }), { start: 5, end: 5 });
	});
});

describe("the line reference of an Alt+Q with nothing selected", () => {
	const at = (fsPath: string | null, line: number, version: string | null = null) => ({ fsPath, version, line });

	it("is the quote's location as inline code, relative inside the session's folder and absolute outside it", () => {
		assert.deepEqual(composeLineReference(at("D:\\Work\\Repo\\src\\app.ts", 42), CWD), { ok: true, text: "`src/app.ts:42`", summary: "src/app.ts:42" });
		assert.deepEqual(composeLineReference(at("D:\\Other\\b.ts", 7), CWD), { ok: true, text: "`D:/Other/b.ts:7`", summary: "D:/Other/b.ts:7" });
		assert.deepEqual(composeLineReference(at("D:\\Work\\Repo\\pkg\\x\\a.ts", 3), "D:\\Work\\Repo\\pkg"), { ok: true, text: "`x/a.ts:3`", summary: "x/a.ts:3" });
	});

	it("is never an @ mention, whatever the path", () => {
		const reference = composeLineReference(at("D:\\Work\\Repo\\my notes\\a b.md", 2), CWD);
		assert.deepEqual(reference, { ok: true, text: "`my notes/a b.md:2`", summary: "my notes/a b.md:2" });
		assert.ok(reference.ok && !reference.text.startsWith("@") && !reference.text.includes(" @"));
	});

	it("names the version of a side of a Git diff, as a quote does", () => {
		assert.deepEqual(composeLineReference(at("D:\\Work\\Repo\\src\\app.ts", 4, "HEAD (3f2a9c1)"), CWD), { ok: true, text: "`src/app.ts:4 @ HEAD (3f2a9c1)`", summary: "src/app.ts:4 @ HEAD (3f2a9c1)" });
		assert.deepEqual(composeLineReference(at("D:\\Work\\Repo\\src\\app.ts", 4, "index"), CWD), { ok: true, text: "`src/app.ts:4 @ index`", summary: "src/app.ts:4 @ index" });
	});

	it("pads or lengthens the code span for a path with a backtick", () => {
		assert.deepEqual(composeLineReference(at("D:\\Work\\Repo\\a`b.ts", 1), CWD), { ok: true, text: "``a`b.ts:1``", summary: "a`b.ts:1" });
	});

	it("refuses a document that has no location, with a reason that says what to do", () => {
		const refused = composeLineReference(at(null, 1), CWD);
		assert.equal(refused.ok, false);
		assert.match(refused.ok ? "" : refused.reason, /no file location.*Select text to quote/);
	});

	it("refuses a path with a control character and a path too long for one insertion", () => {
		assert.equal(composeLineReference(at("/r/a\u001b[201~b.ts", 1), "/r").ok, false);
		const long = composeLineReference(at(`/r/${"d".repeat(MAX_FILE_PATH_LENGTH - 8)}/${"e".repeat(MAX_INSERT_TEXT_LENGTH)}.ts`, 1), "/r");
		assert.equal(long.ok, false);
	});
});

describe("reference formatting", () => {
	it("makes a workspace file a relative @path, never a :12-30 suffix", () => {
		assert.deepEqual(formatReference({ fsPath: "D:\\Work\\Repo\\src\\a.ts" }, CWD), { ok: true, reference: "@src/a.ts" });
	});

	it("keeps a file outside the session's directory absolute with forward slashes so it still resolves", () => {
		assert.deepEqual(formatReference({ fsPath: "D:\\Other\\b.ts" }, CWD), { ok: true, reference: "@D:/Other/b.ts" });
		assert.deepEqual(formatReference({ fsPath: "/home/me/repo2/a.ts" }, "/home/me/repo"), { ok: true, reference: "@/home/me/repo2/a.ts" });
	});

	it("is relative to the target session's directory, not to the workspace", () => {
		assert.deepEqual(formatReference({ fsPath: "D:\\Work\\Repo\\pkg\\x\\a.ts" }, "D:\\Work\\Repo\\pkg"), { ok: true, reference: "@x/a.ts" });
	});

	it("quotes a path the bare form would not parse back to itself", () => {
		assert.deepEqual(formatReference({ fsPath: "D:\\Work\\Repo\\my notes\\a b.md" }, CWD), { ok: true, reference: '@"my notes/a b.md"' });
		assert.deepEqual(formatReference({ fsPath: "D:\\Work\\Repo\\say \"hi\".txt" }, CWD), { ok: true, reference: "@'say \"hi\".txt'" });
	});

	it("refuses a path OMP's mention grammar cannot express rather than inserting a mention that names nothing", () => {
		const both = formatReference({ fsPath: "/r/it's \"x\".txt" }, "/r");
		assert.equal(both.ok, false);
		const control = formatReference({ fsPath: "/r/a\u001b[201~b.txt" }, "/r");
		assert.equal(control.ok, false);
	});
});

describe("composing one insertion", () => {
	it("lists several files, one mention each, in selection order and without duplicates", () => {
		const result = composeInsertion(
			[{ fsPath: "D:\\Work\\Repo\\a.ts" }, { fsPath: "D:\\Work\\Repo\\src\\b.ts" }, { fsPath: "D:\\Work\\Repo\\a.ts" }, { fsPath: "D:\\Other\\c.ts" }],
			CWD,
		);
		assert.deepEqual(result, { ok: true, text: "@a.ts @src/b.ts @D:/Other/c.ts", summary: "3 file references", count: 3 });
	});

	it("names a single reference in full for the status message", () => {
		const result = composeInsertion([{ fsPath: "D:\\Work\\Repo\\src\\a.ts" }], CWD);
		assert.deepEqual(result, { ok: true, text: "@src/a.ts", summary: "@src/a.ts", count: 1 });
	});

	it("refuses the whole insertion when one path cannot be mentioned, or when it is too long for one paste", () => {
		assert.equal(composeInsertion([{ fsPath: "D:\\Work\\Repo\\a.ts" }, { fsPath: "/r/it's \"x\".txt" }], "/r").ok, false);
		const many = Array.from({ length: 80 }, (_, number) => ({ fsPath: `D:\\Work\\Repo\\src\\generated\\file-${number}.ts` }));
		const refused = composeInsertion(many, CWD);
		assert.equal(refused.ok, false);
		assert.equal(composeInsertion([], CWD).ok, false);
	});
});

describe("the terminal paste bytes", () => {
	it("is one bracketed paste with spaces around the mention and no Enter", () => {
		assert.equal(bracketedPaste("@src/a.ts [lines 12-30]"), "\u001b[200~ @src/a.ts [lines 12-30] \u001b[201~");
		const bytes = bracketedPaste("@a.ts @b.ts");
		assert.ok(bytes !== null);
		assert.doesNotMatch(bytes, /[\r\n]/);
		assert.equal(bytes.indexOf("\u001b[200~"), 0);
		assert.equal(bytes.lastIndexOf("\u001b[201~"), bytes.length - "\u001b[201~".length);
		assert.equal(bytes.split("\u001b").length - 1, 2, "the only escapes are the two markers");
	});

	it("refuses text that could end the paste early or press Enter, and text the TUI would collapse into a marker", () => {
		for (const bad of ["@a\r", "@a\n", "@a\r\n@b", "@a\u001b[201~ x", "@a\u0003", "@a\u0085", "", "  "]) {
			assert.equal(bracketedPaste(bad), null, JSON.stringify(bad));
		}
		assert.equal(bracketedPaste("x".repeat(MAX_INSERT_TEXT_LENGTH)), null);
		assert.notEqual(bracketedPaste("x".repeat(MAX_INSERT_TEXT_LENGTH - 2)), null);
	});
});

describe("which sessions are offered", () => {
	it("offers a running session this window controls, whatever the activity", () => {
		for (const state of ["running", "working", "background", "unread", "waiting"] as const) {
			assert.equal(insertAvailability(state, { running: true, open: true }), "live", state);
			assert.equal(insertAvailability(state, { running: true, open: false }), "live", `${state} with its editor closed`);
		}
	});

	it("offers a stopped session only with an editor open here, and says choosing it starts it", () => {
		assert.equal(insertAvailability("stopped", { running: false, open: true }), "resume");
		assert.equal(insertAvailability("draft", { running: false, open: true }), "resume");
		assert.equal(insertAvailability("stopped", { running: false, open: false }), null);
		assert.equal(insertAvailability("draft", { running: false, open: false }), null);
	});

	it("never offers a blocked, open-in-another-window, open-in-another-OMP-process, starting, stopping, restoring or waiting-for-your-answer session", () => {
		for (const state of ["blocked", "otherWindow", "externalOmp", "restoring", "starting", "stopping", "checking", "question"] as const) {
			assert.equal(insertAvailability(state, { running: true, open: true }), null, `${state} (running)`);
			assert.equal(insertAvailability(state, { running: false, open: true }), null, `${state} (not running)`);
		}
	});

	it("does not offer a running-labelled row this window does not run", () => {
		assert.equal(insertAvailability("running", { running: false, open: true }), null);
	});
});

function candidate(tabId: string, overrides: Partial<SendCandidate> = {}): SendCandidate {
	return {
		tabId,
		slotId: `slot-${tabId}`,
		title: `Session ${tabId}`,
		cwd: "D:\\Work\\Repo",
		mode: "chat",
		stateLabel: "Running",
		availability: "live",
		visible: false,
		...overrides,
	};
}

describe("the visible target of a quote", () => {
	const shown = (tabId: string, overrides: Partial<SendCandidate> = {}): SendCandidate => candidate(tabId, { visible: true, ...overrides });

	it("is none when no Chat is visible, so the picker asks", () => {
		assert.equal(visibleQuoteTarget([candidate("a"), candidate("b")], ["slot-a"]), null);
		assert.equal(visibleQuoteTarget([], []), null);
	});

	it("is the one visible Chat, whatever hidden sessions were focused more recently", () => {
		assert.equal(visibleQuoteTarget([candidate("a"), shown("b"), candidate("c")], ["slot-a", "slot-c", "slot-b"])?.tabId, "b");
	});

	it("takes the most recently focused of several visible Chats", () => {
		const recency = new EditorRecency();
		recency.touch("slot-a");
		recency.touch("slot-b");
		recency.touch("slot-c");
		recency.touch("slot-a");
		assert.equal(visibleQuoteTarget([shown("a"), shown("b"), shown("c", { visible: false })], recency.order())?.tabId, "a");
		assert.equal(visibleQuoteTarget([shown("b"), shown("c")], recency.order())?.tabId, "c");
	});

	it("ranks a visible Chat no recency knows after the ones it knows", () => {
		assert.equal(visibleQuoteTarget([shown("a", { title: "Aardvark" }), shown("b")], ["slot-b"])?.tabId, "b");
		assert.equal(visibleQuoteTarget([shown("z", { title: "Zed" }), shown("a", { title: "Alpha" })], [])?.tabId, "a");
	});

	it("does not count a visible Terminal view, a stopped Chat that would first be started, or a session with no editor", () => {
		assert.equal(visibleQuoteTarget([shown("t", { mode: "terminal" })], ["slot-t"]), null);
		assert.equal(visibleQuoteTarget([shown("s", { availability: "resume", stateLabel: "Stopped" })], ["slot-s"]), null);
		assert.equal(visibleQuoteTarget([shown("n", { slotId: null })], []), null);
		assert.equal(visibleQuoteTarget([shown("t", { mode: "terminal" }), shown("c")], ["slot-t", "slot-c"])?.tabId, "c", "a visible Terminal does not hide the Chat beside it");
	});
});

describe("the target picker", () => {
	it("puts the most recently focused session first, so it is the preselected row", () => {
		const recency = new EditorRecency();
		recency.touch("slot-a");
		recency.touch("slot-b");
		recency.touch("slot-c");
		recency.touch("slot-a");
		const entries = pickerEntries([candidate("a"), candidate("b"), candidate("c"), candidate("d", { slotId: null })], recency.order(), "D:\\Work\\Repo", "chat", true);
		assert.deepEqual(entries.map(entry => (entry.kind === "session" ? entry.candidate.tabId : "new")), ["a", "c", "b", "d", "new"]);
	});

	it("does not rank a closed editor: its recency is ignored once its session has no open editor", () => {
		const recency = new EditorRecency();
		recency.touch("slot-b");
		recency.touch("slot-a");
		// `a` was the most recent, then its editor closed (its session still runs without one).
		const entries = pickerEntries([candidate("a", { slotId: null }), candidate("b")], recency.order(), "D:\\Work\\Repo", "chat", true);
		assert.deepEqual(entries.map(entry => (entry.kind === "session" ? entry.candidate.tabId : "new")), ["b", "a", "new"]);
	});

	it("lists running sessions before stopped ones that merely resume, then by title", () => {
		const ordered = orderCandidates(
			[
				candidate("z", { title: "Zed", availability: "resume", stateLabel: "Stopped" }),
				candidate("m", { title: "Mid", slotId: null }),
				candidate("a", { title: "Alpha", slotId: null }),
				candidate("s", { title: "Alpha stopped", availability: "resume", slotId: null, stateLabel: "Stopped" }),
			],
			[],
		);
		assert.deepEqual(ordered.map(item => item.tabId), ["a", "m", "s", "z"]);
	});

	it("offers only a new session, in the folder of the file, when no session qualifies", () => {
		const entries = pickerEntries([], ["slot-gone"], "D:\\Work\\Repo", "terminal", true);
		assert.deepEqual(entries, [{ kind: "new", folder: "D:\\Work\\Repo", label: "New session in Repo", description: "Terminal · D:\\Work\\Repo" }]);
	});

	it("says on the new-session row when choosing it pins the folder to the Sessions view", () => {
		const [entry] = pickerEntries([], [], "D:\\Elsewhere", "chat", false);
		assert.equal(entry?.kind === "new" ? entry.description : null, "Chat · D:\\Elsewhere · pins this folder to the Sessions view");
	});

	it("shows title, folder, mode and status on each row", () => {
		assert.equal(candidateDescription(candidate("a", { mode: "terminal", stateLabel: "Waiting for you", cwd: "/home/me/proj/" })), "proj · Terminal · Waiting for you");
		assert.equal(candidateDescription(candidate("a")), "Repo · Chat · Running");
	});

	it("starts a new session in the workspace folder of the file, else in the folder holding it", () => {
		assert.equal(newSessionFolder("D:\\Work\\Repo\\src\\a.ts", "D:\\Work\\Repo"), "D:\\Work\\Repo");
		assert.equal(newSessionFolder("D:\\Elsewhere\\notes\\a.md", null), "D:\\Elsewhere\\notes");
		assert.equal(newSessionFolder("/tmp/a.md", null), "/tmp");
		assert.equal(newSessionFolder("C:\\a.md", null), "C:\\", "a drive root is not the drive-relative `C:`");
		assert.equal(newSessionFolder("/a.md", null), "/");
	});
});

describe("editor recency", () => {
	it("moves a refocused editor to the front, drops a closed one and stays bounded", () => {
		const recency = new EditorRecency(3);
		for (const slot of ["a", "b", "c", "d"]) recency.touch(slot);
		assert.deepEqual(recency.order(), ["d", "c", "b"]);
		recency.touch("b");
		assert.deepEqual(recency.order(), ["b", "d", "c"]);
		recency.forget("d");
		assert.deepEqual(recency.order(), ["b", "c"]);
	});
});

describe("quoting editor selections", () => {
	const pos = (line: number, character: number) => ({ line, character });
	const source = (selections: { start: ReturnType<typeof pos>; end: ReturnType<typeof pos>; text: string }[], over: Partial<EditorQuoteSource> = {}): EditorQuoteSource => ({
		fsPath: "D:\\Work\\Repo\\src\\app.ts", version: null, fileName: "app.ts", languageId: "typescript", selections, ...over,
	});

	it("writes the location as path:line for one line and path:start-end for a range, relative inside the session's directory", () => {
		const one = composeEditorQuotes(source([{ start: pos(41, 0), end: pos(41, 11), text: "const x = 1" }]), CWD);
		assert.deepEqual(one, { ok: true, quotes: [{ location: "src/app.ts:42", fileName: "app.ts", languageId: "typescript", text: "const x = 1" }], summary: "src/app.ts:42" });
		const range = composeEditorQuotes(source([{ start: pos(41, 2), end: pos(49, 3), text: "a\nb" }]), CWD);
		assert.ok(range.ok && range.quotes[0]?.location === "src/app.ts:42-50");
	});

	it("says which version a side of a diff is: path:lines @ version, the lines being that version's", () => {
		const head = composeEditorQuotes(source([{ start: pos(2, 0), end: pos(4, 1), text: "a\nb\nc" }], { version: "HEAD (3f2a9c1)" }), CWD);
		assert.deepEqual(head, { ok: true, quotes: [{ location: "src/app.ts:3-5 @ HEAD (3f2a9c1)", fileName: "app.ts", languageId: "typescript", text: "a\nb\nc" }], summary: "src/app.ts:3-5 @ HEAD (3f2a9c1)" });
		const index = composeEditorQuotes(source([{ start: pos(41, 0), end: pos(41, 4), text: "abcd" }], { version: "index" }), CWD);
		assert.ok(index.ok && index.quotes[0]?.location === "src/app.ts:42 @ index");
		const commit = composeEditorQuotes(source([{ start: pos(0, 0), end: pos(0, 3), text: "abc" }], { fsPath: "D:\\Other\\b.ts", fileName: "b.ts", version: "3f2a9c1" }), CWD);
		assert.ok(commit.ok && commit.quotes[0]?.location === "D:/Other/b.ts:1 @ 3f2a9c1", "outside the session's directory the path is absolute, the version stays");
	});

	it("gives every selection of a revision the version, and the file on disk none", () => {
		const both = composeEditorQuotes(source([{ start: pos(0, 0), end: pos(0, 1), text: "a" }, { start: pos(9, 0), end: pos(9, 1), text: "b" }], { version: "index" }), CWD);
		assert.ok(both.ok);
		assert.deepEqual(both.quotes.map(quote => quote.location), ["src/app.ts:1 @ index", "src/app.ts:10 @ index"]);
		const disk = composeEditorQuotes(source([{ start: pos(0, 0), end: pos(0, 1), text: "a" }]), CWD);
		assert.ok(disk.ok && disk.quotes[0]?.location === "src/app.ts:1");
	});

	it("refuses a location that is too long with its version, and the longest one still passes the page's bound", () => {
		const long = composeEditorQuotes(source([{ start: pos(0, 0), end: pos(0, 1), text: "a" }], { fsPath: `/r/${"d/".repeat(400)}a.ts`, version: "HEAD (3f2a9c1)" }), "/r");
		assert.equal(long.ok, false);
		const longest = composeEditorQuotes(source([{ start: pos(0, 0), end: pos(0, 1), text: "a" }], { fsPath: `/r/${"d".repeat(MAX_FILE_PATH_LENGTH - 20)}.ts`, version: "x".repeat(MAX_QUOTE_VERSION_LENGTH) }), "/r");
		assert.ok(longest.ok && (longest.quotes[0]?.location?.length ?? Infinity) <= MAX_QUOTE_LOCATION_LENGTH);
	});

	it("keeps a file outside the session's directory absolute with forward slashes", () => {
		const outside = composeEditorQuotes(source([{ start: pos(0, 0), end: pos(0, 3), text: "abc" }], { fsPath: "D:\\Other\\b.ts", fileName: "b.ts" }), CWD);
		assert.ok(outside.ok && outside.quotes[0]?.location === "D:/Other/b.ts:1");
	});

	it("does not count the line a selection only touches at column 0, and drops the line break that leaves behind", () => {
		const whole = composeEditorQuotes(source([{ start: pos(9, 0), end: pos(12, 0), text: "a\nb\nc\n" }]), CWD);
		assert.ok(whole.ok && whole.quotes[0]?.location === "src/app.ts:10-12" && whole.quotes[0]?.text === "a\nb\nc");
	});

	it("normalises CRLF to LF", () => {
		const crlf = composeEditorQuotes(source([{ start: pos(0, 0), end: pos(1, 1), text: "a\r\nb" }]), CWD);
		assert.ok(crlf.ok && crlf.quotes[0]?.text === "a\nb");
	});

	it("makes each non-empty selection its own quote in document order, without a repeated one and without a blank one", () => {
		const result = composeEditorQuotes(source([
			{ start: pos(20, 0), end: pos(20, 1), text: "z" },
			{ start: pos(2, 0), end: pos(2, 1), text: "a" },
			{ start: pos(2, 0), end: pos(2, 1), text: "a" },
			{ start: pos(5, 0), end: pos(5, 2), text: "  " },
		]), CWD);
		assert.ok(result.ok);
		assert.deepEqual(result.quotes.map(quote => [quote.location, quote.text]), [["src/app.ts:3", "a"], ["src/app.ts:21", "z"]]);
		assert.equal(result.summary, "2 selections");
	});

	it("gives a document with no path no location, and a selection of only blanks nothing to quote", () => {
		const untitled = composeEditorQuotes(source([{ start: pos(0, 0), end: pos(0, 2), text: "hi" }], { fsPath: null, fileName: "", languageId: "plaintext" }), CWD);
		assert.ok(untitled.ok && untitled.quotes[0]?.location === null && untitled.summary === "the selection");
		assert.deepEqual(composeEditorQuotes(source([{ start: pos(0, 0), end: pos(0, 2), text: " \n " }]), CWD), { ok: false, reason: "Select some text first." });
	});

	it("refuses over 20 000 characters with the size, counted over every selection of the gesture", () => {
		const big = composeEditorQuotes(source([{ start: pos(0, 0), end: pos(1, 0), text: "x".repeat(12_000) }, { start: pos(5, 0), end: pos(6, 0), text: "y".repeat(19_482 - 12_000 + 1_000) }]), CWD);
		assert.deepEqual(big, { ok: false, reason: "That selection is 20 482 characters; Quote takes at most 20 000." });
		assert.equal(composeEditorQuotes(source([{ start: pos(0, 0), end: pos(1, 0), text: "x".repeat(20_000) }]), CWD).ok, true);
	});

	it("refuses a control character a draft cannot hand over, a path a message cannot carry and too many selections", () => {
		assert.equal(composeEditorQuotes(source([{ start: pos(0, 0), end: pos(0, 3), text: "a\u000cb" }]), CWD).ok, false);
		assert.equal(composeEditorQuotes(source([{ start: pos(0, 0), end: pos(0, 3), text: "abc" }], { fsPath: "/r/a\u001bb.ts" }), "/r").ok, false);
		const many = Array.from({ length: 65 }, (_, line) => ({ start: pos(line, 0), end: pos(line, 1), text: "x" }));
		assert.deepEqual(composeEditorQuotes(source(many), CWD), { ok: false, reason: "Quote takes at most 64 selections at once." });
	});
});

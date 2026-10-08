/**
 * "OMP: Add Selection to Session" / "OMP: Add File to Session": the reference text, the paste bytes
 * and which sessions the picker offers.
 *
 * Runner: `node --test src/host/editor-context.test.ts`
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	EditorRecency,
	bracketedPaste,
	candidateDescription,
	composeInsertion,
	formatReference,
	insertAvailability,
	lineNote,
	newSessionFolder,
	orderCandidates,
	pickerEntries,
	selectionLines,
} from "./editor-context.ts";
import type { SendCandidate } from "./editor-context.ts";
import { MAX_INSERT_TEXT_LENGTH } from "../webview/messages.ts";

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

describe("line notes", () => {
	it("name one line, one range, or several merged ranges", () => {
		assert.equal(lineNote([]), "");
		assert.equal(lineNote([{ start: 7, end: 7 }]), "[line 7]");
		assert.equal(lineNote([{ start: 12, end: 30 }]), "[lines 12-30]");
		assert.equal(lineNote([{ start: 45, end: 45 }, { start: 12, end: 30 }, { start: 28, end: 33 }]), "[lines 12-33, 45]");
		assert.equal(lineNote([{ start: 3, end: 3 }, { start: 4, end: 5 }]), "[lines 3-5]", "adjacent ranges merge");
	});

	it("never contains an emoticon at a token boundary, which the native TUI would rewrite when the prompt is submitted", () => {
		// `expandEmoticons` rewrites `8)`, `B)`, `:)`, `;)`… after whitespace or an opening bracket. A closing
		// parenthesis after the last number is exactly `8)` for line 8; a closing bracket is not in its table.
		for (let line = 1; line <= 120; line++) {
			for (const note of [lineNote([{ start: line, end: line }]), lineNote([{ start: 2, end: 2 }, { start: line + 5, end: line + 5 }]), lineNote([{ start: line, end: line + 8 }])]) {
				assert.doesNotMatch(note, /[()]|[:;]/, note);
				assert.match(note, /^\[lines? [0-9, -]+\]$/, note);
			}
		}
	});
});

describe("reference formatting", () => {
	it("makes a workspace file a relative @path with the range as a note, never a :12-30 suffix", () => {
		const result = formatReference({ fsPath: "D:\\Work\\Repo\\src\\a.ts", ranges: [{ start: 12, end: 30 }] }, CWD);
		assert.deepEqual(result, { ok: true, reference: "@src/a.ts [lines 12-30]" });
		assert.deepEqual(formatReference({ fsPath: "D:\\Work\\Repo\\src\\a.ts" }, CWD), { ok: true, reference: "@src/a.ts" });
	});

	it("keeps a file outside the session's directory absolute with forward slashes so it still resolves", () => {
		assert.deepEqual(formatReference({ fsPath: "D:\\Other\\b.ts" }, CWD), { ok: true, reference: "@D:/Other/b.ts" });
		assert.deepEqual(formatReference({ fsPath: "/home/me/repo2/a.ts", ranges: [{ start: 1, end: 2 }] }, "/home/me/repo"), { ok: true, reference: "@/home/me/repo2/a.ts [lines 1-2]" });
	});

	it("is relative to the target session's directory, not to the workspace", () => {
		assert.deepEqual(formatReference({ fsPath: "D:\\Work\\Repo\\pkg\\x\\a.ts" }, "D:\\Work\\Repo\\pkg"), { ok: true, reference: "@x/a.ts" });
	});

	it("quotes a path the bare form would not parse back to itself", () => {
		assert.deepEqual(formatReference({ fsPath: "D:\\Work\\Repo\\my notes\\a b.md", ranges: [{ start: 2, end: 2 }] }, CWD), { ok: true, reference: '@"my notes/a b.md" [line 2]' });
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
		const result = composeInsertion([{ fsPath: "D:\\Work\\Repo\\src\\a.ts", ranges: [{ start: 12, end: 30 }] }], CWD);
		assert.deepEqual(result, { ok: true, text: "@src/a.ts [lines 12-30]", summary: "@src/a.ts [lines 12-30]", count: 1 });
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
		...overrides,
	};
}

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

	it("says on the new-session row when choosing it pins the folder to the OMP launcher", () => {
		const [entry] = pickerEntries([], [], "D:\\Elsewhere", "chat", false);
		assert.equal(entry?.kind === "new" ? entry.description : null, "Chat · D:\\Elsewhere · pins this folder to the OMP launcher");
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

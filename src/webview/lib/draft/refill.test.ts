/**
 * The writers that come from outside the field, through the Draft interface: completions and the Commands row, the host's inserted
 * reference, the session's editor text, what a Stop or a queue edit takes back, Rewind, the hand-off restore and the recovery cards.
 * The cell is the real one over a recording field that simulates the surface.
 *
 * Runner: `node --test src/webview/lib/draft/refill.test.ts`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChatSlashCommand } from "../../../chat/model.ts";
import { acceptCompletion, completionAt, insertCommand } from "./completion.ts";
import { createDraftCell, type DraftCell } from "./cell.ts";
import { heldMessage } from "./composition.ts";
import { stubPort, type StubPort } from "./draft-test-stub.ts";
import { captureOf, addRecoverable, dismissLost, dismissRecoverable, restoreHandoff } from "./handoff.ts";
import { clearText, cleared, insertText, restoreQueued, rewind, setEditorText, spaceInsertion } from "./refill.ts";
import { withState, type DraftImage } from "./value.ts";
import { viewOf } from "./view.ts";

const PNG = "iVBORw0KGgo=";
const image = (number: number): DraftImage => ({ id: number, name: `draft-${number}`, mimeType: "image/png", bytes: 8, data: `bytes-${number}`, number });

function open(text = "", extra: Parameters<typeof withState>[1] = {}): { cell: DraftCell; port: StubPort } {
	const port = stubPort();
	const cell = createDraftCell(port);
	port.bind(cell);
	cell.commit({ draft: withState(cell.read(), { text, ...extra }), writes: [{ kind: "text", text, history: "reset", focus: false }] });
	port.calls.length = 0;
	return { cell, port };
}

const COMMANDS: readonly ChatSlashCommand[] = [
	{ name: "compact", source: "builtin" },
	{ name: "skill:review", source: "skill" },
	{ name: "theme", source: "builtin", inputHint: "[name]", subcommands: [{ name: "dark", description: "Dark (default)" }, { name: "light" }] },
];
const WAIT = { composing: "wait", held: "wait" } as const;

describe("completions", () => {
	it("completionAt finds the one token the caret is in and nothing where completions are disabled", () => {
		const { cell } = open("see @src/a /sk");
		const draft = cell.read();
		assert.deepEqual(completionAt(draft, 8, COMMANDS, true).mention, { start: 4, query: "src" });
		assert.equal(completionAt(draft, 8, COMMANDS, true).slash, null);
		assert.equal(completionAt(draft, 14, COMMANDS, true).slash?.query, "sk");
		assert.equal(completionAt(draft, 14, COMMANDS, true).mention, null, "a slash token hides the mention rule");
		assert.deepEqual(completionAt(draft, 8, COMMANDS, false), { slash: null, argument: null, mention: null });
		assert.equal(completionAt(open("/theme d").cell.read(), 8, COMMANDS, true).argument?.query, "d");
	});

	it("an accepted mention replaces the token under the caret as one recorded step and leaves the attachments alone", () => {
		const { cell, port } = open("see @sr and more", { images: [image(1)] });
		cell.perform(acceptCompletion(7, { kind: "file", name: "src/a.ts" }, COMMANDS), { composing: "skip", held: "drop" });
		assert.equal(cell.read().text, "see @src/a.ts  and more", "the mention grammar adds its own separating space");
		assert.deepEqual(port.calls, ['write text "see @src/a.ts  and more" caret 14 record focus']);
		assert.equal(cell.read().images.length, 1);
	});

	it("a slash row and an argument row splice their own token", () => {
		const slash = open("/sk");
		slash.cell.perform(acceptCompletion(3, { kind: "slash", name: "skill:review" }, COMMANDS), { composing: "skip", held: "drop" });
		assert.equal(slash.cell.read().text, "/skill:review ");
		const argument = open("/theme d");
		argument.cell.perform(acceptCompletion(8, { kind: "argument", name: "dark" }, COMMANDS), { composing: "skip", held: "drop" });
		assert.equal(argument.cell.read().text, "/theme dark ");
	});

	it("is skipped while a composition window is open or the draft is held, and when the caret is in no token of that kind", () => {
		const composing = open("see @sr");
		composing.port.openWindow();
		const seen: string[] = [];
		composing.cell.perform(acceptCompletion(7, { kind: "file", name: "src/a.ts" }, COMMANDS), { composing: "skip", held: "drop" }, outcome => seen.push(outcome.kind));
		assert.deepEqual(seen, ["dropped"]);
		composing.port.closeWindow();
		assert.equal(composing.cell.read().text, "see @sr");
		const held = open("see @sr");
		assert.notEqual(held.cell.capture(1), null);
		held.cell.perform(acceptCompletion(7, { kind: "file", name: "src/a.ts" }, COMMANDS), { composing: "skip", held: "drop" }, outcome => seen.push(outcome.kind));
		assert.equal(seen[1], "dropped");
		assert.equal(held.cell.read().text, "see @sr");
		const none = open("plain");
		none.cell.perform(acceptCompletion(5, { kind: "file", name: "src/a.ts" }, COMMANDS), { composing: "skip", held: "drop" }, outcome => seen.push(outcome.kind));
		assert.equal(seen[2], "dropped");
		assert.equal(none.cell.read().text, "plain");
	});

	it("the Commands row insert puts /name at the front, keeps what was written and ends the history walk", () => {
		const { cell, port } = open("look at this", { walk: { index: 1, recalled: "look at this", draft: "" } });
		cell.commit(insertCommand(cell.read(), "skill:review"));
		assert.equal(cell.read().text, "/skill:review look at this");
		assert.equal(cell.read().walk, null);
		assert.deepEqual(port.calls, ['write text "/skill:review look at this" caret 14 record focus']);
		const replaced = open("/old existing args");
		replaced.cell.commit(insertCommand(replaced.cell.read(), "skill:review"));
		assert.equal(replaced.cell.read().text, "/skill:review existing args");
		const blank = open("  look [Image #1]");
		blank.cell.commit(insertCommand(blank.cell.read(), "fix"));
		assert.equal(blank.cell.read().text, "/fix look [Image #1]");
	});

	it("the Commands row insert of a command the draft already starts with only moves the caret", () => {
		const { cell, port } = open("/fix rest");
		const revision = cell.read().revision;
		cell.commit(insertCommand(cell.read(), "fix"));
		assert.deepEqual(port.calls, ["write caret 5 focus"]);
		assert.equal(cell.read().revision, revision, "a caret write raises nothing");
	});
});

describe("host-inserted text", () => {
	it("never glues to the word before it, and reuses a blank that is already there", () => {
		assert.equal(spaceInsertion("", 0, 0, "@a.ts"), "@a.ts ");
		assert.equal(spaceInsertion("look at", 7, 7, "@a.ts [line 3]"), " @a.ts [line 3] ");
		assert.equal(spaceInsertion("fix  the bug", 4, 4, "@a.ts"), "@a.ts");
		assert.equal(spaceInsertion("fix \nthe bug", 4, 4, "@a.ts"), "@a.ts ", "a line break is not a blank: the caret must not rest right after a bare @path");
		assert.equal(spaceInsertion("see THISnow", 4, 8, "@a.ts"), "@a.ts ");
	});

	it("lands at the caret over a selection as one step, and the caret steps over a blank that follows", () => {
		const { cell, port } = open("fix  the bug");
		port.selected = { anchor: 4, focus: 4 };
		cell.perform(insertText("@a.ts"), WAIT);
		assert.equal(cell.read().text, "fix @a.ts the bug");
		assert.equal(port.calls[0], 'write edit 4..4 "@a.ts" as replace focus');
		assert.equal(port.calls[1], "write caret 10");
	});

	it("replaces a selection", () => {
		const { cell, port } = open("see THIS now");
		port.selected = { anchor: 4, focus: 8 };
		cell.perform(insertText("@a.ts"), WAIT);
		assert.equal(cell.read().text, "see @a.ts now");
	});

	it("goes to the end of the draft while no field is mounted, value only", () => {
		const { cell, port } = open("note");
		port.unmount();
		cell.perform(insertText("@a.ts"), WAIT);
		assert.equal(cell.read().text, "note @a.ts ");
		assert.deepEqual(port.calls, []);
	});

	it("waits for a composition window and for the hand-off, once each, in order", () => {
		const { cell, port } = open("a");
		port.openWindow();
		cell.perform(insertText("@one"), WAIT);
		cell.perform(insertText("@two"), WAIT);
		assert.equal(cell.read().text, "a");
		port.closeWindow();
		assert.match(cell.read().text, /@one.*@two|@two.*@one/);
		const held = open("a");
		assert.notEqual(held.cell.capture(5), null);
		held.cell.perform(insertText("@x"), WAIT);
		assert.equal(held.cell.read().text, "a");
		held.cell.release(5);
		assert.equal(held.cell.read().text, "a @x ");
	});
});

describe("the session's editor text", () => {
	it("replaces the draft as one recorded step", () => {
		const { cell, port } = open("typed");
		cell.commit(setEditorText(cell.read(), "prefill"));
		assert.equal(cell.read().text, "prefill");
		assert.deepEqual(port.calls, ['write text "prefill" record focus']);
	});
});

describe("a message taken back (restoreQueued)", () => {
	const png = { mimeType: "image/png", data: PNG };

	it("is appended after what is typed, its images attached under fresh numbers, as one recorded step", () => {
		const { cell, port } = open("mine [Image #1, 4x4]", { images: [image(1)], next: { image: 2, document: 1, key: 2, card: 1 } });
		const seen: unknown[] = [];
		cell.perform(restoreQueued([{ text: "queued [Image #1]", images: [png] }]), WAIT, outcome => seen.push(outcome));
		assert.equal(cell.read().text, "mine [Image #1, 4x4]\n\nqueued [Image #2]");
		assert.deepEqual(cell.read().images.map(item => item.number), [1, 2]);
		assert.equal(cell.read().next.image, 3);
		assert.match(port.calls[0]!, /^write text .* record focus$/);
		assert.deepEqual(seen, [{ kind: "applied", result: { attach: null } }]);
	});

	it("says what could not come back and clears the sentence otherwise", () => {
		const { cell } = open("");
		let alert: string | null | undefined;
		cell.perform(restoreQueued([{ text: "x [Image #1]", images: [{ mimeType: "image/bmp", data: PNG }] }]), WAIT, outcome => { if (outcome.kind === "applied") alert = outcome.result.attach; });
		assert.equal(alert, "1 image of the edited message could not be attached (unsupported format).");
	});

	it("a lone message a Stop took back into an empty composer latches `unedited`: Undo of the refill is the rewind's undo", () => {
		const { cell } = open("");
		cell.perform(restoreQueued([{ text: "taken back", images: [], withdrawn: true }]), WAIT);
		assert.equal(cell.read().unedited, cell.read().revision);
		const typed = open("typed");
		typed.cell.perform(restoreQueued([{ text: "taken back", images: [], withdrawn: true }]), WAIT);
		assert.equal(typed.cell.read().unedited, null, "never over a typed draft");
		const several = open("");
		several.cell.perform(restoreQueued([{ text: "a", images: [], withdrawn: true }, { text: "b", images: [] }]), WAIT);
		assert.equal(several.cell.read().unedited, null, "never with messages the Stop took out of OMP's queue");
	});

	it("waits for a composition window and for the hand-off", () => {
		const { cell, port } = open("a");
		port.openWindow();
		cell.perform(restoreQueued([{ text: "b", images: [] }]), WAIT);
		assert.equal(cell.read().text, "a");
		port.closeWindow();
		assert.equal(cell.read().text, "a\n\nb");
	});
});

describe("Rewind", () => {
	const prompt = { text: "rewound [Image #1]", images: [{ type: "image" as const, mimeType: "image/png", data: PNG }], unavailableImages: 0 };

	it("a draft typed before it moves to a recovery card, and the rewound prompt replaces the draft with a fresh start", () => {
		const { cell, port } = open("typed", { walk: { index: 1, recalled: "x", draft: "" } });
		cell.perform(rewind({ kind: "rewind", draft: prompt }), WAIT);
		const draft = cell.read();
		assert.equal(draft.text, "rewound [Image #1]");
		assert.deepEqual(draft.recoverable.map(card => [card.id, card.text, card.reason]), [[1, "typed", "Your draft from before the rewind. Add it to the draft only when you want it back."]]);
		assert.equal(draft.walk, null);
		assert.equal(draft.unedited, draft.revision);
		assert.deepEqual(draft.images.map(item => item.number), [1]);
		assert.equal(port.calls[0], 'write text "rewound [Image #1]" caret 18 reset focus');
	});

	it("an empty draft leaves no card, and images that could not be carried are said", () => {
		const { cell } = open("");
		let alerts: unknown;
		cell.perform(rewind({ kind: "rewind", draft: { text: "p", images: [], unavailableImages: 2 } }), WAIT, outcome => { if (outcome.kind === "applied") alerts = outcome.result; });
		assert.deepEqual(cell.read().recoverable, []);
		assert.deepEqual(alerts, { attach: "2 images of the rewound message could not be restored.", send: null });
	});

	it("a held linked file is counted as lost on the card", () => {
		const { cell } = open("see [File #1: a.md]", { documents: [{ number: 1, name: "a.md", source: { kind: "linked", ref: "AbCdEf012345", bytes: 1, chars: 1 } }] });
		cell.perform(rewind({ kind: "rewind", draft: prompt }), WAIT);
		assert.equal(cell.read().recoverable[0]?.lostFiles, 1);
	});

	it("Undo clears the refill only while it is unedited, and every navigation consumes the latch", () => {
		const { cell } = open("");
		cell.perform(rewind({ kind: "rewind", draft: prompt }), WAIT);
		cell.perform(rewind({ kind: "undo" }), WAIT);
		assert.equal(cell.read().text, "");
		assert.deepEqual(cell.read().images, []);
		assert.deepEqual([cell.read().next.image, cell.read().next.document], [1, 1]);
		assert.equal(cell.read().unedited, null);
		const edited = open("");
		edited.cell.perform(rewind({ kind: "rewind", draft: prompt }), WAIT);
		edited.cell.edited("rewound! ");
		edited.cell.perform(rewind({ kind: "undo" }), WAIT);
		assert.equal(edited.cell.read().text, "rewound! ", "an edited refill stays");
		assert.equal(edited.cell.read().unedited, null);
	});

	it("a switch, or a rewind with no prompt, only clears the latch", () => {
		const { cell, port } = open("");
		cell.perform(rewind({ kind: "rewind", draft: prompt }), WAIT);
		port.calls.length = 0;
		cell.perform(rewind({ kind: "switch" }), WAIT);
		assert.equal(cell.read().unedited, null);
		assert.deepEqual(port.calls, []);
		assert.equal(cell.read().text, "rewound [Image #1]");
	});
});

describe("the clears", () => {
	it("/rewind typed alone clears the text only: attachments and counters stay", () => {
		const { cell, port } = open("/rewind", { images: [image(1)], next: { image: 2, document: 1, key: 2, card: 1 } });
		cell.commit(clearText(cell.read()));
		assert.equal(cell.read().text, "");
		assert.equal(cell.read().images.length, 1);
		assert.equal(cell.read().next.image, 2);
		assert.deepEqual(port.calls, ['write text "" reset']);
	});

	it("an accepted send clears text, attachments, the numbers and the walk, and starts the undo history over", () => {
		const { cell, port } = open("hi [Image #1]", { images: [image(1)], next: { image: 2, document: 3, key: 4, card: 5 }, walk: { index: 1, recalled: "x", draft: "" } });
		cell.commit(cleared(cell.read()));
		const draft = cell.read();
		assert.deepEqual([draft.text, draft.images, draft.documents, draft.walk], ["", [], [], null]);
		assert.deepEqual(draft.next, { image: 1, document: 1, key: 4, card: 5 }, "the key and the card counters never restart");
		assert.deepEqual(port.calls, ['write text "" reset']);
	});
});

describe("the hand-off", () => {
	it("a capture carries the text, the files and every card, the message in flight as unconfirmed, and the restore is its inverse", () => {
		const doc = { number: 1, name: "a.md", source: { kind: "held" as const, content: "hi", label: null, bytes: 2 } };
		const { cell } = open("see [File #1: a.md] and [Image #2]", { images: [image(2)], documents: [doc], lostImages: 1, recoverable: [{ id: 1, text: "old", images: [], reason: "r", unconfirmed: false, lostAttachments: 2 }], inFlight: { text: "sending", images: [] } });
		const content = cell.capture(9)!;
		assert.deepEqual(content.recoverable, [{ text: "old", attachments: 2, unconfirmed: false }, { text: "sending", attachments: 0, unconfirmed: true }]);
		assert.equal(content.attachments, 2, "one image with its marker plus one that could not be carried");
		assert.equal(content.documents[0]?.content, "hi");
		const fresh = open("");
		fresh.cell.commit(restoreHandoff(fresh.cell.read(), content));
		const draft = fresh.cell.read();
		assert.equal(draft.text, "see [File #1: a.md] and [Image #2]");
		assert.equal(draft.lostImages, 2);
		assert.deepEqual(draft.documents, [doc]);
		assert.deepEqual(draft.recoverable.map(card => [card.text, card.unconfirmed, card.lostAttachments]), [["old", false, 2], ["sending", true, 0]]);
		assert.deepEqual([draft.next.image, draft.next.document], [3, 2], "numbers move past the restored markers, the cards' texts included");
		assert.equal(draft.recoverable[0]?.reason, "This original message was not sent. Add it to the draft only when you want to send it.");
		assert.match(draft.recoverable[1]!.reason, /^OMP did not confirm this message/);
	});

	it("a held draft refuses every change, the cards and the warning included, until the capture is released", () => {
		const { cell } = open("x", { lostImages: 1 });
		cell.capture(1);
		assert.equal(cell.commit(dismissLost(cell.read())), false);
		assert.equal(cell.read().lostImages, 1);
		assert.equal(cell.release(1), true);
		assert.equal(cell.commit(dismissLost(cell.read())), true);
		assert.equal(cell.read().lostImages, 0);
	});

	it("cards are added with a fresh id and dismissed by id", () => {
		const { cell } = open("");
		cell.commit(addRecoverable(cell.read(), { text: "a", images: [], reason: "r", unconfirmed: true }));
		cell.commit(addRecoverable(cell.read(), { text: "b", images: [], reason: "r", unconfirmed: false }));
		assert.deepEqual(cell.read().recoverable.map(card => [card.id, card.text]), [[1, "a"], [2, "b"]]);
		cell.commit(dismissRecoverable(cell.read(), 1));
		assert.deepEqual(cell.read().recoverable.map(card => card.id), [2]);
		assert.equal(cell.read().next.card, 3);
		assert.equal(cell.read().revision, 1, "cards never raise the revision (only the opening text write did)");
	});

	it("captureOf and heldMessage agree on what a draft's files are", () => {
		const { cell } = open("[File #1: a.md] x", { documents: [{ number: 1, name: "a.md", source: { kind: "linked", ref: "AbCdEf012345", bytes: 3, chars: 3 } }] });
		assert.equal(captureOf(cell.read()).documents[0]?.ref, "AbCdEf012345");
		assert.deepEqual(heldMessage(cell.read()), { text: "[File #1: a.md] x", images: [], lostFiles: 1 });
		assert.equal(heldMessage(open("   ").cell.read()), null);
	});
});

describe("what a Stop hands back (restoreQueued)", () => {
	it("a message taken back fills an empty composer as it is, with no alert, and is not a send", () => {
		const { cell, port } = open("");
		let attach: string | null | undefined;
		cell.perform(restoreQueued([{ text: "fix the typo", images: [], withdrawn: true }]), WAIT, outcome => { if (outcome.kind === "applied") attach = outcome.result.attach; });
		assert.equal(cell.read().text, "fix the typo");
		assert.equal(attach, null);
		assert.deepEqual(port.calls, ['write text "fix the typo" caret 12 record focus']);
	});

	it("keeps a typed draft, puts the taken-back message after it and the queued messages after that", () => {
		const { cell } = open("new draft");
		cell.perform(restoreQueued([{ text: "fix the typo", images: [], withdrawn: true }, { text: "queued steer", images: [] }]), WAIT);
		const merged = cell.read().text;
		assert.equal(merged, "new draft\n\nfix the typo\n\nqueued steer");
		assert.ok(merged.indexOf("new draft") < merged.indexOf("fix the typo") && merged.indexOf("fix the typo") < merged.indexOf("queued steer"));
	});

	it("the still-queued messages come back after what is typed, in their queue order", () => {
		const { cell } = open("typed");
		cell.perform(restoreQueued([{ text: "queued steer", images: [] }, { text: "queued follow-up", images: [] }]), WAIT);
		const restored = cell.read().text;
		assert.ok(restored.startsWith("typed"), restored);
		assert.ok(restored.indexOf("queued steer") < restored.indexOf("queued follow-up"), restored);
		assert.equal(restored, "typed\n\nqueued steer\n\nqueued follow-up");
	});
});

describe("Undo of the Stop's move (the navigation answer of kind undo)", () => {
	const undo = (cell: DraftCell): void => cell.perform(rewind({ kind: "undo" }), WAIT);

	it("clears the unedited refill of an empty composer", () => {
		const { cell } = open("");
		cell.perform(restoreQueued([{ text: "fix the typo", images: [], withdrawn: true }]), WAIT);
		assert.equal(cell.read().text, "fix the typo");
		undo(cell);
		assert.equal(cell.read().text, "");
		assert.equal(cell.read().unedited, null);
	});

	it("leaves a refill the user edited", () => {
		const { cell } = open("");
		cell.perform(restoreQueued([{ text: "fix the typo", images: [], withdrawn: true }]), WAIT);
		cell.edited("fix the typo now");
		undo(cell);
		assert.equal(cell.read().text, "fix the typo now");
	});

	it("leaves a refill that also carries a queued message: the queued one exists nowhere else", () => {
		const { cell } = open("");
		cell.perform(restoreQueued([{ text: "fix the typo", images: [], withdrawn: true }, { text: "queued steer", images: [] }]), WAIT);
		const handed = cell.read().text;
		assert.ok(handed.includes("queued steer"));
		undo(cell);
		assert.equal(cell.read().text, handed);
	});

	it("never clears a typed draft", () => {
		const { cell } = open("new draft");
		cell.perform(restoreQueued([{ text: "fix the typo", images: [], withdrawn: true }]), WAIT);
		const kept = cell.read().text;
		assert.ok(kept.includes("fix the typo") && kept.includes("new draft"));
		undo(cell);
		assert.equal(cell.read().text, kept);
	});
});

describe("Rewind's prompt and the recovery card, as one conversation of the composer", () => {
	const answer = (text: string) => ({ kind: "rewind" as const, draft: { text, images: [], unavailableImages: 0 } });

	it("a rewound prompt fills an empty composer with no card, Undo takes the unedited prompt back, and a later rewind moves the user's own draft to a card", () => {
		const { cell, port } = open("");
		cell.perform(rewind(answer("fix the parser")), WAIT);
		assert.equal(cell.read().text, "fix the parser");
		assert.deepEqual(cell.read().recoverable, [], "an empty composer has nothing to keep");
		assert.deepEqual(port.calls, ['write text "fix the parser" caret 14 reset focus']);

		cell.perform(rewind({ kind: "undo" }), WAIT);
		assert.equal(cell.read().text, "");

		cell.edited("my own draft");
		cell.perform(rewind(answer("first prompt\nwith a second line")), WAIT);
		assert.equal(cell.read().text, "first prompt\nwith a second line");
		assert.deepEqual(cell.read().recoverable.map(card => ({ reason: card.reason, text: card.text })),
			[{ reason: "Your draft from before the rewind. Add it to the draft only when you want it back.", text: "my own draft" }], "the earlier draft is kept, not overwritten");
	});
});

describe("what Esc Esc may open Rewind over, and what /rewind or /branch typed alone leaves", () => {
	it("an empty draft is idle; any typed text is a draft Rewind never replaces, and deleting it makes the composer idle again", () => {
		const { cell } = open("");
		assert.equal(viewOf(cell.read(), 0).untouched, true);
		cell.edited("x");
		assert.equal(viewOf(cell.read(), 0).untouched, false);
		cell.edited("");
		assert.equal(viewOf(cell.read(), 0).untouched, true);
	});

	it("/rewind and /branch typed alone are consumed: the draft is empty and idle again, and nothing was sent", () => {
		for (const command of ["/rewind", "/branch"]) {
			const { cell, port } = open(command);
			assert.equal(viewOf(cell.read(), 0).untouched, false);
			cell.commit(clearText(cell.read()));
			assert.equal(cell.read().text, "", `${command} is consumed`);
			assert.equal(viewOf(cell.read(), 0).untouched, true);
			assert.deepEqual(port.calls, ['write text "" reset']);
		}
	});
});

/**
 * The send composition through the Draft interface: every validation in its order with its sentence, the linked read and its budget, the
 * blocks and their escaping, the image order, the second phase on the same draft value, and what is done with the draft when the host
 * has answered (`settleSend`), the in-flight message and "Add to draft".
 *
 * Runner: `node --test src/webview/lib/draft/compose.test.ts`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChatSlashCommand } from "../../../chat/model.ts";
import { MAX_MESSAGE_CHARS } from "../../../shared/attach-limits.ts";
import { fileMarker } from "../../../shared/file-blocks.ts";
import { createDraftCell, type DraftCell } from "./cell.ts";
import { addToDraft } from "./composition.ts";
import { beginSend, compose, settleSend, type Composition, type OutgoingMessage, type SendContext } from "./compose.ts";
import type { DraftDocument } from "./draft-documents.ts";
import { stubPort } from "./draft-test-stub.ts";
import type { Outcome } from "./field.ts";
import type { RestoredQueued } from "./queue-merge.ts";
import { emptyDraft, withState, type Draft, type DraftImage } from "./value.ts";

const context: SendContext = { commands: [{ name: "compact", source: "builtin" }, { name: "model", source: "builtin", inputHint: "<name>" }, { name: "skill:review", source: "skill" }], rewindAvailable: true };
const image = (number: number, bytes = 8): DraftImage => ({ id: number, name: `draft-${number}`, mimeType: "image/png", bytes, data: `bytes-${number}`, number });
const held = (number: number, name: string, content: string): DraftDocument => ({ number, name, source: { kind: "held", content, label: null, bytes: content.length } });
const linked = (number: number, name: string, chars = 10): DraftDocument => ({ number, name, source: { kind: "linked", ref: `ref-${number}-aaaaaa`, bytes: chars, chars } });
const draftOf = (patch: Partial<Draft>): Draft => ({ ...emptyDraft(), ...patch });
const refusal = (composition: Composition): string => {
	assert.equal(composition.kind, "refused");
	return composition.kind === "refused" ? composition.reason : "";
};
const ready = (composition: Composition): OutgoingMessage => {
	assert.equal(composition.kind, "ready");
	return composition.kind === "ready" ? composition.message : (undefined as never);
};

describe("compose, phase 1", () => {
	it("a draft with nothing to send is empty: blanks, and attachments whose marker was deleted", () => {
		assert.deepEqual(compose(draftOf({ text: "  \n " }), context), { kind: "empty" });
		assert.deepEqual(compose(draftOf({ text: "", images: [image(1)], documents: [held(1, "a.md", "x")] }), context), { kind: "empty" });
	});

	it("a typed /rewind or /branch with no attachment opens Rewind when it is available, and is a command otherwise", () => {
		assert.deepEqual(compose(draftOf({ text: "/rewind" }), context), { kind: "rewind" });
		assert.deepEqual(compose(draftOf({ text: " /branch " }), context), { kind: "rewind" });
		assert.equal(compose(draftOf({ text: "/rewind" }), { ...context, rewindAvailable: false }).kind, "ready");
		assert.equal(compose(draftOf({ text: "/rewind [Image #1]", images: [image(1)] }), context).kind, "ready", "with an attachment it is a message");
	});

	it("a command that needs an argument is refused and asks to reopen the completion", () => {
		assert.deepEqual(compose(draftOf({ text: "/model" }), context), { kind: "refused", reason: "This command requires an argument.", reopenCompletion: true });
		assert.equal(compose(draftOf({ text: "/model fast" }), context).kind, "ready");
	});

	it("images over the budget are refused with the real figures", () => {
		const big = image(1, 11 * 1024 * 1024);
		assert.equal(refusal(compose(draftOf({ text: "[Image #1]", images: [big] }), context)), "the attached images are 11.0 MB, over the 10.0 MB one message may carry; remove an image to send");
	});

	it("a /command cannot carry files, a /skill: can", () => {
		const files = { documents: [held(1, "a.md", "x")] };
		assert.equal(refusal(compose(draftOf({ text: `/compact ${fileMarker(1, "a.md")}`, ...files }), context)), "A message that starts with / is a command and cannot carry files.");
		assert.equal(compose(draftOf({ text: `/skill:review ${fileMarker(1, "a.md")}`, ...files }), context).kind, "ready");
	});

	it("the characters known so far over the limit are refused, naming the largest file", () => {
		const reason = refusal(compose(draftOf({ text: `x ${fileMarker(1, "big.md")}`, documents: [held(1, "big.md", "y".repeat(MAX_MESSAGE_CHARS))] }), context));
		assert.equal(reason, "The message would be 200 019 characters; one message carries 200 000. The largest file is big.md (200 000 characters).");
		assert.match(refusal(compose(draftOf({ text: "x".repeat(MAX_MESSAGE_CHARS + 1) }), context)), /^The message would be 200 001 characters; one message carries 200 000\.$/);
	});

	it("linked files must be read first: what to read, their names and what is left of the message after the text the page holds", () => {
		const text = `see ${fileMarker(1, "a.md")} ${fileMarker(2, "b.md")} ${fileMarker(3, "c.md")}`;
		const composition = compose(draftOf({ text, documents: [linked(1, "a.md"), held(2, "b.md", "1234567890"), linked(3, "c.md")] }), context);
		assert.equal(composition.kind, "read");
		if (composition.kind !== "read") return;
		assert.deepEqual(composition.files, [{ number: 1, ref: "ref-1-aaaaaa" }, { number: 3, ref: "ref-3-aaaaaa" }]);
		assert.deepEqual([...composition.names], [[1, "a.md"], [3, "c.md"]]);
		assert.equal(composition.budget, MAX_MESSAGE_CHARS - text.length - 10);
	});

	it("a draft of text and held files is ready at once, with the files as blocks after the prose", () => {
		const message = ready(compose(draftOf({ text: `see ${fileMarker(1, "a.md")}`, documents: [held(1, "a.md", "hello")] }), context));
		assert.equal(message.prose, `see ${fileMarker(1, "a.md")}`);
		assert.match(message.text, /^see \[File #1: a\.md\]\n\n<file name="a\.md" n="1" chars="5">\nhello\n<\/file>$/);
		assert.deepEqual(message.unsaved, []);
	});
});

describe("compose, the images", () => {
	it("go in marker order and are renumbered densely, and an image whose marker was deleted is not sent", () => {
		const message = ready(compose(draftOf({ text: "b [Image #5] a [Image #2]", images: [image(2), image(3), image(5)] }), context));
		assert.equal(message.text, "b [Image #2] a [Image #1]");
		assert.deepEqual(message.images.map(item => item.data), ["bytes-2", "bytes-5"]);
		assert.deepEqual(message.images[0], { type: "image", mimeType: "image/png", data: "bytes-2" });
	});
});

describe("compose, phase 2", () => {
	const text = `see ${fileMarker(1, "a.md")}`;
	const draft = draftOf({ text, documents: [linked(1, "a.md")], revision: 7 });

	it("builds the blocks from what the host read, names the files with unsaved changes and carries the revision of the draft", () => {
		const message = ready(compose(draft, context, new Map([[1, { label: "docs/a.md", content: "hello", dirty: true }]])));
		assert.match(message.text, /<file path="docs\/a\.md" n="1" chars="5">\nhello\n<\/file>$/);
		assert.deepEqual(message.unsaved, ["a.md has unsaved changes in the editor; the saved version was sent."]);
		assert.equal(message.revision, 7);
	});

	it("a file the host did not return refuses the send by name", () => {
		assert.equal(refusal(compose(draft, context, new Map())), "a.md could not be read.");
	});

	it("text that grows past the limit once escaped is refused with its real length", () => {
		const content = "<file>".repeat(Math.floor(MAX_MESSAGE_CHARS / 5));
		const reason = refusal(compose(draftOf({ text, documents: [linked(1, "a.md", 10)] }), context, new Map([[1, { label: "a.md", content, dirty: false }]])));
		assert.match(reason, /^The message would be [\d ]+ characters; one message carries 200 000\. The largest file is a\.md \(10 characters\)\.$/);
	});

	it("is the draft as it was at Enter: typing during the read changes nothing of the message, and the same draft composes to the same message", () => {
		const contents = new Map([[1, { label: "a.md", content: "hello", dirty: false }]]);
		const first = ready(compose(draft, context, contents));
		const typedLater = { ...draft, text: `${text} and more` };
		assert.equal(typedLater.text.length > draft.text.length, true);
		assert.deepEqual(ready(compose(draft, context, contents)), first);
	});
});

describe("settleSend", () => {
	const message = (revision: number): OutgoingMessage => ({ text: "hi", prose: "hi", images: [], revision, unsaved: [] });
	const accepted = { ok: true } as const;

	function start(): { cell: DraftCell; sent: OutgoingMessage } {
		const port = stubPort();
		const cell = createDraftCell(port);
		port.bind(cell);
		cell.commit({ draft: withState(cell.read(), { text: "hi", images: [image(1)], next: { image: 2, document: 1, key: 2, card: 1 } }), writes: [{ kind: "text", text: "hi", history: "reset", focus: false }] });
		const sent = { ...message(cell.read().revision), images: [{ type: "image" as const, mimeType: "image/png", data: "bytes-1" }] };
		cell.commit(beginSend(cell.read(), sent));
		return { cell, sent };
	}

	it("the message in flight is carried as unconfirmed by a capture and costs no revision", () => {
		const { cell, sent } = start();
		assert.deepEqual(cell.read().inFlight, { text: "hi", images: sent.images });
		assert.equal(cell.read().revision, 1);
		assert.deepEqual(cell.capture(1)?.recoverable, [{ text: "hi", attachments: 1, unconfirmed: true }]);
	});

	it("an accepted send of the unchanged draft clears it entirely and settles the message in flight", () => {
		const { cell, sent } = start();
		const settled = settleSend(cell.read(), { ...sent, unsaved: ["a.md has unsaved changes in the editor; the saved version was sent."] }, accepted);
		assert.equal(cell.commit(settled.change), true);
		assert.deepEqual([cell.read().text, cell.read().images, cell.read().inFlight, cell.read().next.image], ["", [], null, 1]);
		assert.deepEqual(settled.alerts, { send: null, attach: null });
		assert.equal(settled.notice, "a.md has unsaved changes in the editor; the saved version was sent.");
	});

	it("an accepted send of a draft edited meanwhile keeps everything the user did", () => {
		const { cell, sent } = start();
		cell.edited("hi there");
		const settled = settleSend(cell.read(), sent, accepted);
		cell.commit(settled.change);
		assert.equal(cell.read().text, "hi there");
		assert.equal(cell.read().images.length, 1);
		assert.equal(cell.read().inFlight, null);
		assert.deepEqual(settled.alerts, { send: null });
		assert.equal(settled.notice, null);
	});

	it("a refused send of the unchanged draft keeps it and says why", () => {
		const { cell, sent } = start();
		const settled = settleSend(cell.read(), sent, { ok: false, reason: "Not admitted" });
		cell.commit(settled.change);
		assert.equal(cell.read().text, "hi");
		assert.deepEqual(cell.read().recoverable, []);
		assert.equal(cell.read().inFlight, null);
		assert.deepEqual(settled.alerts, { send: "Not admitted" });
	});

	it("a refused send whose draft was edited meanwhile becomes a recovery card, and so does an unconfirmed one", () => {
		const edited = start();
		edited.cell.edited("changed");
		const first = settleSend(edited.cell.read(), edited.sent, { ok: false, reason: "Not admitted" });
		edited.cell.commit(first.change);
		assert.deepEqual(edited.cell.read().recoverable.map(card => [card.id, card.text, card.reason, card.unconfirmed, card.images.length]), [[1, "hi", "Not admitted", false, 1]]);
		assert.deepEqual(first.alerts, { send: null });
		const unsure = start();
		const second = settleSend(unsure.cell.read(), unsure.sent, { ok: false, reason: "Delivery unknown", unconfirmed: true });
		unsure.cell.commit(second.change);
		assert.deepEqual(unsure.cell.read().recoverable.map(card => [card.text, card.unconfirmed]), [["hi", true]]);
		assert.equal(unsure.cell.read().text, "hi", "the draft stays");
		assert.equal(unsure.cell.read().next.card, 2);
	});
});

describe("Add to draft", () => {
	const card = { id: 1, text: "original", images: [{ type: "image" as const, mimeType: "image/png", data: "bytes-1" }], reason: "r", unconfirmed: true };
	const run = (draft: Draft): { outcome: Outcome<RestoredQueued | null>; cell: DraftCell } => {
		const port = stubPort();
		const cell = createDraftCell(port);
		port.bind(cell);
		cell.commit({ draft: { ...draft, revision: 0 }, writes: [{ kind: "text", text: draft.text, history: "reset", focus: false }] });
		let outcome: Outcome<RestoredQueued | null> = { kind: "dropped" };
		cell.perform(addToDraft(card.id), { composing: "now", held: "drop" }, result => { outcome = result; });
		return { outcome, cell };
	};

	it("hands the original to the queue merge when the draft is something else, and adds what a hand-off could not carry to the warning", () => {
		const { outcome, cell } = run(draftOf({ text: "other", recoverable: [{ ...card, lostAttachments: 2 }], lostImages: 1 }));
		assert.deepEqual(outcome, { kind: "applied", result: { text: "original", images: card.images } });
		assert.equal(cell.read().lostImages, 3);
	});

	it("does nothing when the draft already is the original, but raises the warning to the card's count", () => {
		const same = draftOf({ text: "original [Image #1]", images: [image(1)], recoverable: [{ ...card, text: "original [Image #1]", lostAttachments: 4 }], lostImages: 1 });
		const { outcome, cell } = run(same);
		assert.deepEqual(outcome, { kind: "applied", result: null });
		assert.equal(cell.read().lostImages, 4);
	});

	it("a draft that carries a linked file never matches, a held file composes into the comparison", () => {
		const withLinked = draftOf({ text: `original ${fileMarker(1, "a.md")}`, documents: [linked(1, "a.md")], recoverable: [{ ...card, text: `original ${fileMarker(1, "a.md")}`, images: [] }] });
		assert.deepEqual(run(withLinked).outcome, { kind: "applied", result: { text: `original ${fileMarker(1, "a.md")}`, images: [] } });
		const doc = held(1, "a.md", "hi");
		const heldOne = draftOf({ text: `original ${fileMarker(1, "a.md")}`, documents: [doc], recoverable: [{ ...card, text: "placeholder", images: [] }] });
		const wire = ready(compose(heldOne, context)).text;
		const result = run({ ...heldOne, recoverable: [{ ...card, text: wire, images: [] }] }).outcome;
		assert.deepEqual(result, { kind: "applied", result: null });
	});

	it("is nothing for a card that was dismissed meanwhile", () => {
		assert.deepEqual(run(draftOf({ text: "x" })).outcome, { kind: "dropped" });
	});
});

import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChatSlashCommand } from "../../../chat/model.ts";
import { parseGuestHostMessage, parseGuestWebviewMessage } from "../../../protocol/messages.ts";
import { commandResolver, findChips } from "./command-chips.ts";
import { addRecoverable } from "./handoff.ts";
import { restorePersisted, snapshotOf } from "./persist.ts";
import { emptyDraft, knowsReference, type Draft, type DraftImage } from "./value.ts";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const COMMANDS: readonly ChatSlashCommand[] = [{ name: "skill:review", source: "skill" }, { name: "compact", source: "builtin" }];

function image(id: number, number: number, extra: Partial<DraftImage> = {}): DraftImage {
	return { id, number, name: "shot.png", mimeType: "image/png", bytes: PNG.byteLength, data: PNG.toString("base64"), width: 10, height: 6, ...extra };
}

/** A draft that holds everything the module keeps: a command chip, an image, a held file, a linked file, a card and a lost image. */
function busy(): Draft {
	const base = emptyDraft();
	return {
		...base,
		text: "/skill:review look at [Image #2, 10x6] and [File #1: notes.md] and [File #2: plan.md]",
		images: [image(7, 2), image(5, 1, { name: "deleted.png" })],
		documents: [
			{ number: 1, name: "notes.md", source: { kind: "held", content: "# Notes\n", label: null, bytes: 8 } },
			{ number: 2, name: "plan.md", source: { kind: "linked", ref: "AbCdEf012345", bytes: 40, chars: 40 } },
		],
		lostImages: 1,
		next: { image: 3, document: 3, key: 8, card: 2 },
		recoverable: [{ id: 1, text: "refused message", images: [], reason: "refused", unconfirmed: false, lostAttachments: 2 }],
		revision: 4,
	};
}

test("an empty draft is nothing to keep", () => {
	const snapshot = snapshotOf(emptyDraft());
	assert.equal(snapshot.empty, true);
	assert.equal(snapshot.imagesKey, "");
	assert.deepEqual(snapshot.images, []);
});

test("a draft is kept as what a send would carry: the markers' images and files, the cards and the not-carried count, never an image only Undo could bring back", () => {
	const snapshot = snapshotOf(busy());
	assert.equal(snapshot.empty, false);
	assert.equal(snapshot.content.text, busy().text);
	assert.deepEqual(snapshot.images.map(entry => [entry.number, entry.name, entry.width, entry.height]), [[2, "shot.png", 10, 6]]);
	assert.equal(snapshot.imagesKey, "7", "the key names the ids of the images kept");
	assert.equal(snapshot.content.attachments, 1, "an earlier hand-off's lost image stays counted; the images carried are not");
	assert.deepEqual(snapshot.content.documents.map(entry => [entry.number, entry.ref, entry.content]), [[1, null, "# Notes\n"], [2, "AbCdEf012345", null]]);
	assert.deepEqual(snapshot.content.recoverable, [{ text: "refused message", attachments: 2, unconfirmed: false }]);
});

test("the message awaiting admission is kept as an unconfirmed card, so a reload during a send never loses it", () => {
	const snapshot = snapshotOf({ ...emptyDraft(), inFlight: { text: "sending", images: [] } });
	assert.equal(snapshot.empty, false);
	assert.deepEqual(snapshot.content.recoverable, [{ text: "sending", attachments: 0, unconfirmed: true }]);
});

test("a draft the host could not store the images of counts them as not carried", () => {
	const snapshot = snapshotOf(busy(), false);
	assert.equal(snapshot.imagesKey, "");
	assert.deepEqual(snapshot.images, []);
	assert.equal(snapshot.content.attachments, 2, "the carried image joins the lost one");
});

test("a snapshot is a message the boundary accepts, and the host's record of it a recall the page accepts", () => {
	const snapshot = snapshotOf(busy());
	const save = { type: "omp:draft-save", saveId: 1, imagesKey: snapshot.imagesKey, images: snapshot.images, ...snapshot.content };
	assert.deepEqual(parseGuestWebviewMessage(save), save);
	assert.deepEqual(parseGuestWebviewMessage({ ...save, images: null }), { ...save, images: null });
	const recall = { type: "omp:draft-recall", recallId: 3, imagesKey: snapshot.imagesKey, images: snapshot.images, ...snapshot.content };
	assert.deepEqual(parseGuestHostMessage(recall), recall);
	assert.equal(parseGuestWebviewMessage({ ...save, imagesKey: "7,9" }), null, "the key names two images and the message carries one");
	assert.equal(parseGuestWebviewMessage({ ...save, images: [{ ...snapshot.images[0], bytes: 3 }] }), null, "the byte count is the decoded length");
});

test("a pristine composer takes the recalled draft whole: text, chips, images with new ids, files, cards, and no focus is taken", () => {
	const snapshot = snapshotOf(busy());
	const change = restorePersisted(emptyDraft(), { ...snapshot.content, imagesKey: snapshot.imagesKey, images: snapshot.images });
	const restored = change.draft;
	assert.equal(restored.text, busy().text);
	assert.deepEqual(restored.images.map(entry => [entry.id, entry.number, entry.name]), [[7, 2, "shot.png"]], "the image keeps the id its key names");
	assert.equal(restored.lostImages, 1);
	assert.deepEqual(restored.documents.map(entry => [entry.number, entry.source.kind]), [[1, "held"], [2, "linked"]]);
	assert.equal(restored.recoverable.length, 1);
	assert.ok(restored.next.image >= 3 && restored.next.document >= 3, "new attachments never reuse a number of the restored text");
	assert.equal(restored.next.key, 8, "the id is spent");
	assert.equal(snapshotOf(restored).imagesKey, snapshot.imagesKey, "so the restored draft's key is the one the host holds");
	assert.deepEqual(change.writes, [{ kind: "text", text: busy().text, caret: busy().text.length, history: "reset", focus: false }]);
	const chips = findChips(restored.text, (kind, number, name) => knowsReference(restored, kind, number, name), commandResolver(COMMANDS));
	assert.deepEqual(chips.map(chip => chip.kind), ["skill", "image", "file", "file"], "the command chip and the markers of the restored attachments are all there");
	assert.deepEqual(snapshotOf(restored).content, snapshot.content, "keeping a restored draft again changes nothing");
});

test("a composer the user already typed in keeps its own draft and gets the recalled text as a card", () => {
	const snapshot = snapshotOf(busy());
	const typed: Draft = { ...emptyDraft(), text: "new words", revision: 1 };
	const change = restorePersisted(typed, { ...snapshot.content, imagesKey: snapshot.imagesKey, images: snapshot.images });
	assert.equal(change.draft.text, "new words");
	assert.deepEqual(change.writes, []);
	assert.deepEqual(change.draft.recoverable.map(card => [card.text === busy().text, card.lostAttachments ?? 0, card.lostFiles ?? 0]), [[false, 2, 0], [true, 2, 2]]);
	assert.equal(new Set(change.draft.recoverable.map(card => card.id)).size, 2, "the cards have distinct ids");
});

test("a composer that was edited and emptied again is not pristine either", () => {
	const emptied: Draft = { ...emptyDraft(), revision: 3 };
	const change = restorePersisted(emptied, { ...snapshotOf(busy()).content, imagesKey: "", images: [] });
	assert.equal(change.draft.text, "");
	assert.equal(change.draft.recoverable.length, 2);
	const withCard = addRecoverable(emptyDraft(), { text: "x", images: [], reason: "r", unconfirmed: false }).draft;
	assert.equal(restorePersisted(withCard, { ...snapshotOf(busy()).content, imagesKey: "", images: [] }).writes.length, 0);
});

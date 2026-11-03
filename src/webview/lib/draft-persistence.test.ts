/**
 * The page's half of keeping the draft across a window reload (`draft-persistence.ts`): when a save is posted, what it carries, how the host's answers are
 * used, how a recall is applied. The cell is the real one over the Draft module's stub field; the host and the clock are fakes.
 *
 * Runner: `node --test src/webview/lib/draft-persistence.test.ts`.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import type { GuestDraftRecallMessage, GuestDraftSaveMessage } from "../../protocol/messages.ts";
import { createDraftCell, snapshotOf, type DraftCell } from "./draft/draft.ts";
import { withState } from "./draft/value.ts";
import { stubPort } from "./draft/draft-test-stub.ts";
import { receiveDraftPersistence, offerDraftPersistence, SAVE_ACK_MS, SAVE_MAX_WAIT_MS, SAVE_QUIET_MS, startDraftPersistence } from "./draft-persistence.ts";
import type { DraftPersistence } from "./draft-persistence.ts";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const image = (id: number, number: number) => ({ id, number, name: "shot.png", mimeType: "image/png" as const, bytes: PNG.byteLength, data: PNG.toString("base64"), width: 10, height: 6 });

interface World {
	cell: DraftCell;
	posted: GuestDraftSaveMessage[];
	persistence: DraftPersistence;
	route: { fire(): void };
	leave: { fire(): void };
	/** Answers the newest save with the key the host holds. */
	answer(key?: string): void;
	accepting: { value: boolean };
}

function world(): World {
	const port = stubPort();
	const cell = createDraftCell(port);
	port.bind(cell);
	const posted: GuestDraftSaveMessage[] = [];
	const accepting = { value: true };
	const routeListeners = new Set<() => void>();
	const leaveListeners = new Set<() => void>();
	const persistence = startDraftPersistence(cell, {
		post: message => { if (!accepting.value) return false; posted.push(message); return true; },
		onRoute: listener => { routeListeners.add(listener); return () => routeListeners.delete(listener); },
		onLeaving: listener => { leaveListeners.add(listener); return () => leaveListeners.delete(listener); },
	});
	return {
		cell, posted, persistence, accepting,
		route: { fire: () => routeListeners.forEach(listener => listener()) },
		leave: { fire: () => leaveListeners.forEach(listener => listener()) },
		answer(key) {
			const last = posted[posted.length - 1]!;
			persistence.receive({ type: "omp:draft-saved", saveId: last.saveId, imagesKey: key ?? last.imagesKey });
		},
	};
}

/** The user types `text` (a text write, as the field's own edit reports it). */
function type(cell: DraftCell, text: string): void {
	cell.commit({ draft: withState(cell.read(), { text }), writes: [{ kind: "text", text, history: "record", focus: false }] });
}

/** A draft that holds one image and the marker that names it. */
function attachImage(cell: DraftCell, id = 1): void {
	const text = `[Image #${id}, 10x6] caption`;
	cell.commit({ draft: withState(cell.read(), { text, images: [image(id, id)], next: { ...cell.read().next, image: id + 1, key: id + 1 } }), writes: [{ kind: "text", text, history: "record", focus: false }] });
}

describe("draft persistence (page)", () => {
	let open: World[] = [];
	beforeEach(() => { mock.timers.enable({ apis: ["setTimeout"] }); });
	afterEach(() => {
		for (const w of open) w.persistence.stop();
		open = [];
		mock.timers.reset();
	});
	const start = (): World => { const w = world(); open.push(w); return w; };

	it("posts nothing for a composer that has just mounted, however long it waits", () => {
		const w = start();
		mock.timers.tick(60_000);
		assert.deepEqual(w.posted, []);
	});

	it("posts the draft after a quiet moment, once, and nothing more while it does not change", () => {
		const w = start();
		type(w.cell, "hello");
		mock.timers.tick(SAVE_QUIET_MS - 1);
		assert.equal(w.posted.length, 0);
		mock.timers.tick(1);
		assert.equal(w.posted.length, 1);
		assert.equal(w.posted[0]!.text, "hello");
		assert.equal(w.posted[0]!.images !== null && w.posted[0]!.images.length, 0, "an empty image set that the host has not acknowledged is sent as such");
		w.answer();
		mock.timers.tick(60_000);
		assert.equal(w.posted.length, 1);
	});

	it("waits no longer than the maximum while the user keeps typing, and a caret move is no change", () => {
		const w = start();
		for (let at = 0; at < SAVE_MAX_WAIT_MS; at += SAVE_QUIET_MS - 100) {
			type(w.cell, `typing ${at}`);
			mock.timers.tick(SAVE_QUIET_MS - 100);
		}
		assert.equal(w.posted.length, 1, "one save at the latest 2 s after the first change");
		w.answer();
		w.cell.commit({ draft: w.cell.read(), writes: [{ kind: "caret", at: 1, focus: false }] });
		mock.timers.tick(60_000);
		assert.equal(w.posted.length, 1);
	});

	it("keeps one save in flight: a change waits for the answer, then goes out", () => {
		const w = start();
		type(w.cell, "one");
		mock.timers.tick(SAVE_QUIET_MS);
		type(w.cell, "one two");
		mock.timers.tick(SAVE_QUIET_MS * 3);
		assert.equal(w.posted.length, 1, "no second save before the first is answered");
		w.answer();
		mock.timers.tick(SAVE_QUIET_MS);
		assert.equal(w.posted.length, 2);
		assert.equal(w.posted[1]!.text, "one two");
	});

	it("tells the host at once when the draft has become empty after it held something (a send), and never for an empty draft it did not hold", () => {
		const w = start();
		w.cell.commit({ draft: withState(w.cell.read(), { documents: [] }), writes: [] });
		type(w.cell, "");
		mock.timers.tick(SAVE_QUIET_MS * 4);
		assert.equal(w.posted.length, 0, "an emptiness that was never anything else is not news");
		type(w.cell, "sent text");
		mock.timers.tick(SAVE_QUIET_MS);
		w.answer();
		type(w.cell, "");
		assert.equal(w.posted.length, 2, "posted in the same moment, with no quiet period");
		assert.equal(snapshotOf(w.cell.read()).empty, true);
		assert.equal(w.posted[1]!.text, "");
		assert.deepEqual(w.posted[1]!.documents, []);
	});

	it("sends the images when their set changes and leaves them out of a later text edit", () => {
		const w = start();
		attachImage(w.cell);
		mock.timers.tick(SAVE_QUIET_MS);
		assert.equal(w.posted[0]!.imagesKey, "1");
		assert.equal(w.posted[0]!.images?.length, 1);
		w.answer();
		type(w.cell, `${w.cell.read().text} more`);
		mock.timers.tick(SAVE_QUIET_MS);
		assert.equal(w.posted[1]!.images, null, "the host holds this set under its key");
		assert.equal(w.posted[1]!.imagesKey, "1");
	});

	it("sends the images again when the host answers it holds another set (it lost them), and counts a set it refused as not carried", () => {
		const w = start();
		attachImage(w.cell);
		mock.timers.tick(SAVE_QUIET_MS);
		w.answer("");
		mock.timers.tick(SAVE_QUIET_MS);
		assert.equal(w.posted.length, 2, "a refusal is followed by a save at once");
		assert.equal(w.posted[1]!.images, null, "refused when sent whole: not sent again");
		assert.equal(w.posted[1]!.imagesKey, "");
		assert.equal(w.posted[1]!.attachments, 1, "the image is counted as not carried, so a restore says to attach it again");
		w.answer();
		mock.timers.tick(60_000);
		assert.equal(w.posted.length, 2);

		const lost = start();
		attachImage(lost.cell);
		mock.timers.tick(SAVE_QUIET_MS);
		lost.answer();
		type(lost.cell, `${lost.cell.read().text} x`);
		mock.timers.tick(SAVE_QUIET_MS);
		assert.equal(lost.posted[1]!.images, null);
		lost.answer("");
		mock.timers.tick(SAVE_QUIET_MS);
		assert.equal(lost.posted[2]!.images?.length, 1, "left out and the host did not have them: sent whole this time");
	});

	it("gives up an unanswered save after the answer window, tries again, and stops after two until the draft changes", () => {
		const w = start();
		type(w.cell, "hello");
		mock.timers.tick(SAVE_QUIET_MS);
		mock.timers.tick(SAVE_ACK_MS);
		mock.timers.tick(SAVE_QUIET_MS);
		assert.equal(w.posted.length, 2);
		mock.timers.tick(SAVE_ACK_MS);
		mock.timers.tick(SAVE_QUIET_MS);
		assert.equal(w.posted.length, 2, "two unanswered saves in a row are enough");
		type(w.cell, "hello again");
		mock.timers.tick(SAVE_QUIET_MS);
		assert.equal(w.posted.length, 3, "a change asks again");
	});

	it("keeps an unposted draft until the route carries it, and posts when the page leaves", () => {
		const w = start();
		w.accepting.value = false;
		type(w.cell, "typed on a bridge route");
		mock.timers.tick(SAVE_QUIET_MS);
		assert.equal(w.posted.length, 0);
		w.accepting.value = true;
		w.route.fire();
		mock.timers.tick(SAVE_QUIET_MS);
		assert.equal(w.posted.length, 1);
		w.answer();
		type(w.cell, "typed and gone");
		w.leave.fire();
		assert.equal(w.posted.length, 2, "the page is hiding: nothing waits for the timer");
	});

	it("does not post a draft the boundary would refuse whole, and so never waits for an answer that cannot come", () => {
		const w = start();
		type(w.cell, "has a carriage return\r inside");
		mock.timers.tick(SAVE_QUIET_MS * 5);
		assert.deepEqual(w.posted, []);
		type(w.cell, "clean again");
		mock.timers.tick(SAVE_QUIET_MS);
		assert.equal(w.posted.length, 1);
	});

	it("applies a recall to a pristine composer, answers the next save with no images when it came back whole, and never saves it as an empty draft before", () => {
		const w = start();
		const snapshot = snapshotOf({ ...w.cell.read(), text: "[Image #4, 10x6] restored", images: [image(9, 4)], documents: [], next: { ...w.cell.read().next, image: 5, key: 10 } });
		const recall: GuestDraftRecallMessage = { type: "omp:draft-recall", recallId: 1, ...snapshot.content, imagesKey: snapshot.imagesKey, images: [...snapshot.images] };
		w.persistence.receive(recall);
		assert.equal(w.cell.read().text, "[Image #4, 10x6] restored");
		assert.deepEqual(w.cell.read().images.map(entry => entry.id), [9], "the image keeps the id the key names");
		mock.timers.tick(SAVE_QUIET_MS);
		assert.equal(w.posted.length, 1, "the restored draft is a change that is saved");
		assert.equal(w.posted[0]!.images, null, "the host holds exactly this set");
		assert.equal(w.posted[0]!.imagesKey, "9");
	});

	it("keeps a recall the cell refused while it is held and applies it when released", () => {
		const w = start();
		assert.equal(w.cell.capture(1) !== null, true);
		const recall: GuestDraftRecallMessage = { type: "omp:draft-recall", recallId: 2, text: "back", attachments: 0, recoverable: [], documents: [], imagesKey: "", images: [] };
		w.persistence.receive(recall);
		assert.equal(w.cell.read().text, "");
		w.cell.release(1);
		assert.equal(w.cell.read().text, "back");
	});

	it("an answer for another save is not this save's answer", () => {
		const w = start();
		type(w.cell, "x");
		mock.timers.tick(SAVE_QUIET_MS);
		w.persistence.receive({ type: "omp:draft-saved", saveId: w.posted[0]!.saveId + 5, imagesKey: "" });
		type(w.cell, "xy");
		mock.timers.tick(SAVE_QUIET_MS * 3);
		assert.equal(w.posted.length, 1, "still waiting for its own answer");
	});
});

describe("draft persistence (the page's inbound path)", () => {
	it("hands a recall that arrived before the composer mounted to the composer that mounts, once, and an answer to the newest composer", () => {
		const recall: GuestDraftRecallMessage = { type: "omp:draft-recall", recallId: 7001, text: "early", attachments: 0, recoverable: [], documents: [], imagesKey: "", images: [] };
		offerDraftPersistence(recall);
		const got: string[] = [];
		const stop = receiveDraftPersistence(message => got.push(message.type));
		assert.deepEqual(got, ["omp:draft-recall"]);
		offerDraftPersistence(recall);
		assert.deepEqual(got, ["omp:draft-recall"], "the same recall is delivered once");
		offerDraftPersistence({ type: "omp:draft-saved", saveId: 1, imagesKey: "" });
		assert.deepEqual(got, ["omp:draft-recall", "omp:draft-saved"]);
		stop();
		offerDraftPersistence({ type: "omp:draft-saved", saveId: 2, imagesKey: "" });
		assert.equal(got.length, 2, "nobody is listening");
	});
});

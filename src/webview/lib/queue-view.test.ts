/**
 * The queued-messages row's view-model: rows from the readback, the line budget and the sentences that report
 * what a removal did. Runner: `node --test src/webview/lib/queue-view.test.ts`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChatQueueResultItem } from "../chat-messages.ts";
import { QUEUE_MAX_LINES, QUEUE_TITLE_LIMIT, queueNotice, queueRows, queueSummary, queueWindow, restoredEntries } from "./queue-view.ts";

const result = (status: ChatQueueResultItem["status"], text: string, extra: Record<string, unknown> = {}): ChatQueueResultItem => ({ queue: "followUp", text, status, ...extra }) as ChatQueueResultItem;

describe("queueRows", () => {
	it("lists steering before follow-up, each in OMP's order, with the exact text kept for removal", () => {
		const rows = queueRows({ steering: ["s1", "s2"], followUp: ["f1"] });
		assert.deepEqual(rows.map(row => [row.queue, row.label, row.text]), [["steering", "Steering", "s1"], ["steering", "Steering", "s2"], ["followUp", "Follow-up", "f1"]]);
		assert.equal(queueSummary(rows), "2 steering · 1 follow-up");
		assert.equal(queueSummary(queueRows({ steering: [], followUp: ["f1", "f2"] })), "2 follow-ups");
	});

	it("shows a multi-line message on one line but keeps its exact text", () => {
		const [row] = queueRows({ steering: [], followUp: ["first line\n\n  second\tline  "] });
		assert.equal(row?.preview, "first line second line");
		assert.equal(row?.text, "first line\n\n  second\tline  ");
	});

	it("labels an image-only message and bounds the tooltip", () => {
		assert.equal(queueRows({ steering: [""], followUp: [] })[0]?.preview, "(image only)");
		const [long] = queueRows({ steering: ["x".repeat(QUEUE_TITLE_LIMIT + 500)], followUp: [] });
		assert.equal(long?.title.length, QUEUE_TITLE_LIMIT + 1);
		assert.equal(long?.text.length, QUEUE_TITLE_LIMIT + 500);
	});

	it("is empty without a readback", () => {
		assert.deepEqual(queueRows(undefined), []);
		assert.equal(queueSummary([]), "");
		assert.equal(queueSummary([], 2), "2 not listed");
		assert.equal(queueSummary(queueRows({ steering: ["a"], followUp: [] }), 1), "1 steering · 1 not listed");
	});
});

describe("queueWindow", () => {
	it("shows every row that fits and folds the rest behind +N more", () => {
		assert.deepEqual(queueWindow(2, 900), { shown: 2, hidden: 0 });
		const { shown, hidden } = queueWindow(40, 900);
		assert.equal(shown + hidden, 40);
		assert.ok(shown + 1 <= QUEUE_MAX_LINES, "the +N more line is one of the budgeted lines");
	});

	it("keeps at least one row in a very short window", () => {
		assert.deepEqual(queueWindow(3, 120), { shown: 1, hidden: 2 });
	});
});

describe("restoredEntries", () => {
	it("keeps only what OMP actually removed, in order, with images", () => {
		const images = [{ type: "image" as const, mimeType: "image/png", data: "AA==" }];
		const entries = restoredEntries([result("removed", "one"), result("gone", "two"), result("removed", "three", { images }), result("unknown", "four"), result("failed", "five")]);
		assert.deepEqual(entries, [{ text: "one", images: [] }, { text: "three", images: [{ type: "image", mimeType: "image/png", data: "AA==" }] }]);
	});
});

describe("queueNotice", () => {
	it("is silent when every message was removed", () => {
		assert.equal(queueNotice("edit", { ok: true, results: [result("removed", "a")] }), null);
	});

	it("reports a message OMP had already delivered as already sent", () => {
		assert.equal(queueNotice("cancel", { ok: true, results: [result("gone", "a")] })?.text, "1 queued message was already sent or is no longer queued, so it could not be removed.");
		assert.equal(queueNotice("edit", { ok: true, results: [result("gone", "a"), result("gone", "b"), result("removed", "c")] })?.text, "2 queued messages were already sent or are no longer queued, so they could not be edited.");
	});

	it("carries the text of a message whose removal was not confirmed, so it cannot be lost", () => {
		const notice = queueNotice("edit", { ok: true, results: [result("unknown", "maybe gone")] });
		assert.match(notice?.text ?? "", /did not confirm whether 1 queued message was removed/);
		assert.equal(notice?.detail, "maybe gone");
	});

	it("reports a refused removal and dropped images, and names why nothing was asked", () => {
		assert.match(queueNotice("cancel", { ok: true, results: [result("failed", "a")] })?.text ?? "", /could not be removed and is still queued/);
		assert.match(queueNotice("edit", { ok: true, results: [result("removed", "a", { imagesDropped: true })] })?.text ?? "", /images could not be restored/);
		assert.equal(queueNotice("edit", { ok: false, reason: "the session is not running" })?.text, "The queue was not changed: the session is not running.");
	});
});

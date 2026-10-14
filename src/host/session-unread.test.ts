import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { compareReplyMarkers, isLookedAt, isUnread, laterReplyMarker, markersAfterEvent, markersAfterViewing, nextEventMarker, type ReplyMarkers } from "./session-unread.ts";

const READ: ReplyMarkers = { lastCompletedReplyId: null, lastSeenReplyId: null };

describe("session unread marker", () => {
	it("is unread exactly while the newest event is not the one the user was in front of", () => {
		assert.equal(isUnread(READ), false);
		assert.equal(isUnread({ lastCompletedReplyId: "event-1", lastSeenReplyId: null }), true);
		assert.equal(isUnread({ lastCompletedReplyId: "event-2", lastSeenReplyId: "event-1" }), true);
		assert.equal(isUnread({ lastCompletedReplyId: "event-2", lastSeenReplyId: "event-2" }), false);
	});

	it("counts as looked at only for the active, visible editor of a focused window, whatever the notification setting says", () => {
		for (const focused of [false, true]) for (const visible of [false, true]) for (const active of [false, true]) {
			assert.equal(isLookedAt(focused, visible, active), focused && visible && active);
		}
	});

	it("turns unread when a reply finishes or a question is asked while the user looks elsewhere", () => {
		const after = markersAfterEvent(READ, false, 1_000);
		assert.equal(isUnread(after), true);
		assert.equal(after.lastSeenReplyId, null);
	});

	it("stays read when the event happens in front of the user, and a viewed older reply does not hide a newer one", () => {
		const viewed = markersAfterEvent(READ, true, 1_000);
		assert.equal(isUnread(viewed), false);
		const away = markersAfterEvent(viewed, false, 2_000);
		assert.equal(isUnread(away), true);
		assert.equal(away.lastSeenReplyId, viewed.lastSeenReplyId);
		assert.notEqual(away.lastCompletedReplyId, viewed.lastCompletedReplyId);
	});

	it("clears when the user looks, once, and a second look changes nothing", () => {
		const unread = markersAfterEvent(READ, false, 1_000);
		const seen = markersAfterViewing(unread);
		assert.notEqual(seen, null);
		assert.equal(isUnread(seen!), false);
		assert.equal(seen!.lastCompletedReplyId, unread.lastCompletedReplyId);
		assert.equal(markersAfterViewing(seen!), null);
		assert.equal(markersAfterViewing(READ), null);
	});

	it("never repeats an identity, even for two events in the same millisecond", () => {
		const first = nextEventMarker(null, 5_000);
		const second = nextEventMarker(first, 5_000);
		const third = nextEventMarker(second, 5_000);
		assert.equal(new Set([first, second, third]).size, 3);
		assert.notEqual(nextEventMarker(third, 6_000), third);
		assert.notEqual(nextEventMarker("something else", 5_000), "something else");
	});

	it("survives a reload as plain identities: the same two strings give the same verdict", () => {
		const stored = JSON.parse(JSON.stringify(markersAfterEvent(READ, false, 42))) as ReplyMarkers;
		assert.equal(isUnread(stored), true);
		assert.equal(isUnread(markersAfterViewing(stored)!), false);
	});

	it("orders the identities it mints by time and repeat, and nothing else", () => {
		const a = nextEventMarker(null, 5_000);
		const b = nextEventMarker(a, 5_000);
		const c = nextEventMarker(b, 6_000);
		assert.ok(compareReplyMarkers(a, b)! < 0 && compareReplyMarkers(b, a)! > 0);
		assert.ok(compareReplyMarkers(b, c)! < 0);
		assert.equal(compareReplyMarkers(a, a), 0);
		assert.ok(compareReplyMarkers(null, a)! < 0 && compareReplyMarkers(a, null)! > 0 && compareReplyMarkers(null, undefined) === 0);
		assert.equal(compareReplyMarkers("reply-1", "reply-2"), null);
		assert.equal(compareReplyMarkers("reply-1", a), null);
	});

	it("lets the later identity win whichever side holds it, and the side that changed an unordered one", () => {
		const old = nextEventMarker(null, 5_000);
		const next = nextEventMarker(old, 6_000);
		assert.equal(laterReplyMarker(old, old, next), next, "a stale copy does not take a reply back");
		assert.equal(laterReplyMarker(old, next, old), next);
		assert.equal(laterReplyMarker(null, null, next), next);
		assert.equal(laterReplyMarker(null, next, null), next);
		assert.equal(laterReplyMarker("reply-1", "reply-1", "reply-2"), "reply-2", "unordered: the side that did not change it yields");
		assert.equal(laterReplyMarker("reply-1", "reply-3", "reply-2"), "reply-3");
	});
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	activityMillis,
	compareFlatRows,
	flatFolderLabels,
	flatRowLabel,
	normalizeSessionsGrouping,
	orderFlatRows,
	type FlatOrderFacts,
} from "./session-order.ts";

function row(tabId: string, overrides: Partial<FlatOrderFacts> = {}): FlatOrderFacts {
	return { tabId, stopped: false, unread: false, lastActivityAt: 0, ordinal: 0, ...overrides };
}

const ids = (rows: readonly FlatOrderFacts[]) => rows.map(item => item.tabId);

describe("flat session order", () => {
	it("puts unread live rows first, then live rows by last activity, newest first", () => {
		const rows = [
			row("read-old", { lastActivityAt: 10 }),
			row("unread-old", { lastActivityAt: 5, unread: true }),
			row("read-new", { lastActivityAt: 20 }),
			row("unread-new", { lastActivityAt: 8, unread: true }),
		];
		assert.deepEqual(ids(orderFlatRows(rows)), ["unread-new", "unread-old", "read-new", "read-old"]);
	});

	it("always puts stopped rows last, by last activity, whatever their activity or read marker", () => {
		const rows = [
			row("stopped-newest", { stopped: true, lastActivityAt: 1_000, unread: true }),
			row("live-ancient", { lastActivityAt: 1 }),
			row("stopped-old", { stopped: true, lastActivityAt: 50 }),
			row("live-unread", { unread: true, lastActivityAt: 2 }),
		];
		assert.deepEqual(ids(orderFlatRows(rows)), ["live-unread", "live-ancient", "stopped-newest", "stopped-old"]);
	});

	it("breaks ties by the newer ordinal, then by id, and is independent of the input order", () => {
		const rows = [
			row("b", { ordinal: 1 }),
			row("a", { ordinal: 1 }),
			row("newer", { ordinal: 2 }),
		];
		const expected = ["newer", "a", "b"];
		assert.deepEqual(ids(orderFlatRows(rows)), expected);
		assert.deepEqual(ids(orderFlatRows([...rows].reverse())), expected);
		assert.equal(compareFlatRows(rows[0]!, rows[0]!), 0);
	});

	it("moves a session to the top when it turns unread and back by activity once read", () => {
		const quiet = row("quiet", { lastActivityAt: 100 });
		const finished = row("finished", { lastActivityAt: 10 });
		assert.deepEqual(ids(orderFlatRows([quiet, finished])), ["quiet", "finished"]);
		assert.deepEqual(ids(orderFlatRows([quiet, { ...finished, unread: true }])), ["finished", "quiet"]);
		assert.deepEqual(ids(orderFlatRows([quiet, { ...finished, unread: false }])), ["quiet", "finished"]);
	});

	it("leaves the input untouched", () => {
		const rows = [row("a", { lastActivityAt: 1 }), row("b", { lastActivityAt: 2 })];
		orderFlatRows(rows);
		assert.deepEqual(ids(rows), ["a", "b"]);
	});
});

describe("activity time", () => {
	it("takes the first parseable timestamp and falls back to zero", () => {
		assert.equal(activityMillis("2026-09-25T10:00:00.000Z", "2026-09-25T11:00:00.000Z"), Date.parse("2026-09-25T10:00:00.000Z"));
		assert.equal(activityMillis(null, undefined, "not a date", "2026-09-25T11:00:00.000Z"), Date.parse("2026-09-25T11:00:00.000Z"));
		assert.equal(activityMillis(null, undefined), 0);
	});
});

describe("flat folder labels", () => {
	const labels = (...paths: string[]) => [...flatFolderLabels(paths.map((folderPath, position) => ({ id: String(position), path: folderPath }))).values()];

	it("uses the last path component when it is unique", () => {
		assert.deepEqual(labels("D:\\Work\\alpha", "D:\\Work\\beta", "/srv/gamma"), ["alpha", "beta", "gamma"]);
	});

	it("grows only the colliding folders, one parent at a time, ignoring case", () => {
		assert.deepEqual(labels("D:\\work\\app", "D:\\play\\APP", "D:\\other"), ["work/app", "play/APP", "other"]);
		assert.deepEqual(labels("/a/x/app", "/b/x/app", "/c/y/app"), ["a/x/app", "b/x/app", "y/app"]);
	});

	it("keeps the whole path when two folders stay equal to the root and names a root by itself", () => {
		assert.deepEqual(labels("C:\\", "D:\\"), ["C:", "D:"]);
		assert.deepEqual(labels("/same", "/same"), ["same", "same"]);
	});

	it("formats a row label with the folder before the session name", () => {
		assert.equal(flatRowLabel("app", "Fix login"), "app · Fix login");
	});
});

describe("grouping setting", () => {
	it("defaults to the flat list and accepts only the two known values", () => {
		assert.equal(normalizeSessionsGrouping(undefined), "flat");
		assert.equal(normalizeSessionsGrouping("tree"), "flat");
		assert.equal(normalizeSessionsGrouping("flat"), "flat");
		assert.equal(normalizeSessionsGrouping("folders"), "folders");
	});
});

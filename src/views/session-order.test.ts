import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	compareFlatRows,
	flatFolderLabels,
	flatRowLabel,
	normalizeSessionsGrouping,
	planNotificationReveal,
	sessionsLayoutPickItems,
	orderFlatRows,
	type FlatOrderFacts,
} from "./session-order.ts";

function row(tabId: string, overrides: Partial<FlatOrderFacts> = {}): FlatOrderFacts {
	return { tabId, stopped: false, folder: "", title: "", ordinal: 0, ...overrides };
}

const ids = (rows: readonly FlatOrderFacts[]) => rows.map(item => item.tabId);

describe("flat session order", () => {
	it("sorts by folder, then by title, case-insensitively and with numbers in numeric order", () => {
		const rows = [
			row("web-b", { folder: "web", title: "beta" }),
			row("api-10", { folder: "api", title: "Task 10" }),
			row("web-a", { folder: "Web", title: "Alpha" }),
			row("api-9", { folder: "api", title: "task 9" }),
		];
		assert.deepEqual(ids(orderFlatRows(rows)), ["api-9", "api-10", "web-a", "web-b"]);
	});

	it("always puts stopped rows after every live row, each group in the same alphabetical order", () => {
		const rows = [
			row("stopped-a", { stopped: true, folder: "a", title: "a" }),
			row("live-z", { folder: "z", title: "z" }),
			row("stopped-b", { stopped: true, folder: "a", title: "b" }),
			row("live-b", { folder: "b", title: "a" }),
		];
		assert.deepEqual(ids(orderFlatRows(rows)), ["live-b", "live-z", "stopped-a", "stopped-b"]);
	});

	it("breaks equal titles by the older ordinal, then by id, and is independent of the input order", () => {
		const rows = [
			row("b", { title: "same", ordinal: 2 }),
			row("a", { title: "same", ordinal: 2 }),
			row("older", { title: "same", ordinal: 1 }),
		];
		const expected = ["older", "a", "b"];
		assert.deepEqual(ids(orderFlatRows(rows)), expected);
		assert.deepEqual(ids(orderFlatRows([...rows].reverse())), expected);
		assert.equal(compareFlatRows(rows[0]!, rows[0]!), 0);
	});

	it("leaves the input untouched", () => {
		const rows = [row("b", { title: "b" }), row("a", { title: "a" })];
		orderFlatRows(rows);
		assert.deepEqual(ids(rows), ["b", "a"]);
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
	it("defaults to the flat list and accepts only the three known values", () => {
		assert.equal(normalizeSessionsGrouping(undefined), "flat");
		assert.equal(normalizeSessionsGrouping("tree"), "flat");
		assert.equal(normalizeSessionsGrouping("flat"), "flat");
		assert.equal(normalizeSessionsGrouping("folders"), "folders");
		assert.equal(normalizeSessionsGrouping("terminals"), "terminals");
	});

	it("offers the three layouts in order and marks exactly the current one", () => {
		for (const current of ["flat", "folders", "terminals"] as const) {
			const items = sessionsLayoutPickItems(current);
			assert.deepEqual(items.map(item => item.id), ["flat", "folders", "terminals"]);
			assert.deepEqual(items.filter(item => item.description === "current").map(item => item.id), [current]);
			assert.deepEqual(items.filter(item => item.label.startsWith("$(circle-large-filled)")).map(item => item.id), [current]);
			assert.ok(items.every(item => item.detail.length > 0));
		}
	});

	describe("planNotificationReveal", () => {
		it("reveals the session row in a layout that serves session rows", () => {
			assert.deepEqual(planNotificationReveal({ sessionRowsShown: true, hasProcessRow: false, previousSessionLayout: null }), { kind: "session-row" });
			assert.deepEqual(planNotificationReveal({ sessionRowsShown: true, hasProcessRow: true, previousSessionLayout: "folders" }), { kind: "session-row" });
		});

		it("reveals the process row in Terminals while the session's process is listed", () => {
			assert.deepEqual(planNotificationReveal({ sessionRowsShown: false, hasProcessRow: true, previousSessionLayout: "folders" }), { kind: "process-row" });
		});

		it("leaves Terminals for the user's previous session-serving layout when the process has ended", () => {
			assert.deepEqual(planNotificationReveal({ sessionRowsShown: false, hasProcessRow: false, previousSessionLayout: "folders" }), { kind: "switch-layout", to: "folders" });
			assert.deepEqual(planNotificationReveal({ sessionRowsShown: false, hasProcessRow: false, previousSessionLayout: "flat" }), { kind: "switch-layout", to: "flat" });
		});

		it("defaults to the flat list when no earlier layout is known", () => {
			assert.deepEqual(planNotificationReveal({ sessionRowsShown: false, hasProcessRow: false, previousSessionLayout: null }), { kind: "switch-layout", to: "flat" });
			assert.deepEqual(planNotificationReveal({ sessionRowsShown: false, hasProcessRow: false, previousSessionLayout: "terminals" }), { kind: "switch-layout", to: "flat" });
		});
	});
});

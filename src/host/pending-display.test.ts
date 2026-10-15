import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PendingDisplay, type PendingProgress, type PendingRow } from "./pending-display.ts";
import { PendingOperations, type PendingTimers } from "./pending-operations.ts";

interface Timer { readonly callback: () => void; at: number; cleared: boolean }

function world() {
	let now = 100_000;
	const timers: Timer[] = [];
	const fake: PendingTimers = {
		set: (callback, ms) => { const timer = { callback, at: now + ms, cleared: false }; timers.push(timer); return timer; },
		clear: handle => { if (handle !== undefined) (handle as Timer).cleared = true; },
	};
	const pushes: PendingRow[][] = [];
	const progress: { location: "view" | "window"; texts: string[]; ended: boolean }[] = [];
	const registry = new PendingOperations({ now: () => now, timers: fake });
	const display = new PendingDisplay(registry, {
		setRows: rows => { pushes.push([...rows]); },
		beginProgress: (location, text): PendingProgress => {
			const shown = { location, texts: [text], ended: false };
			progress.push(shown);
			return { update: next => { shown.texts.push(next); }, end: () => { shown.ended = true; } };
		},
	}, { now: () => now, timers: fake, graceMs: 1_000 });
	/** Move the clock, running the timers that fall due in order. */
	const advance = (ms: number): void => {
		const target = now + ms;
		for (;;) {
			const due = timers.filter(timer => !timer.cleared && timer.at <= target).sort((a, b) => a.at - b.at)[0];
			if (due === undefined) break;
			now = Math.max(now, due.at);
			due.cleared = true;
			due.callback();
		}
		now = target;
	};
	const live = (): number => timers.filter(timer => !timer.cleared).length;
	return { registry, display, pushes, progress, advance, live };
}

describe("the pending display", () => {
	it("pushes the rows once per turn however many steps changed, and an empty list when the last operation ends", () => {
		const w = world();
		const handle = w.registry.begin("tab:a", "resume", { origin: "row", step: "routing" });
		handle.step("ownership");
		handle.step("admission");
		assert.deepEqual(w.pushes, [], "nothing is pushed inside the turn");
		w.advance(0);
		assert.equal(w.pushes.length, 1);
		assert.deepEqual(w.pushes[0], [{ key: "tab:a", kind: "resume", step: "admission", startedAt: 100_000, still: false }]);
		handle.end("running");
		w.advance(0);
		assert.deepEqual(w.pushes.at(-1), []);
		w.display.dispose();
	});

	it("shows view progress for a row operation only, from begin to end", () => {
		const w = world();
		const reload = w.registry.begin("window", "reload-windows", { origin: "command" });
		assert.deepEqual(w.progress.filter(shown => shown.location === "view"), [], "no row, no view progress");
		reload.end("running");
		const open = w.registry.begin("tab:a", "open", { origin: "row" });
		const view = w.progress.filter(shown => shown.location === "view");
		assert.equal(view.length, 1);
		assert.equal(view[0]!.ended, false);
		const second = w.registry.begin("tab:b", "close", { origin: "row" });
		assert.equal(w.progress.filter(shown => shown.location === "view").length, 1, "one bar for every row operation");
		open.end("running");
		assert.equal(view[0]!.ended, false);
		second.end("running");
		assert.equal(view[0]!.ended, true);
		w.display.dispose();
	});

	it("shows the status bar only for a command-origin operation that outlasts the grace, with its words, and removes it with the operation", () => {
		const w = world();
		const row = w.registry.begin("tab:a", "open", { origin: "row" });
		const quick = w.registry.begin("tab:b", "open", { origin: "command", step: "routing" });
		w.advance(500);
		quick.end("running");
		w.advance(2_000);
		assert.deepEqual(w.progress.filter(shown => shown.location === "window"), [], "a quick command never flashes in the status bar");

		const slow = w.registry.begin("tab:c", "open", { origin: "command", step: "routing" });
		w.advance(999);
		assert.deepEqual(w.progress.filter(shown => shown.location === "window"), []);
		w.advance(1);
		const status = w.progress.filter(shown => shown.location === "window");
		assert.equal(status.length, 1);
		assert.deepEqual(status[0]!.texts, ["Opening · looking for the window that has it"]);
		slow.step("ownership");
		assert.equal(status[0]!.texts.at(-1), "Opening · checking for another OMP process");
		slow.end("running");
		assert.equal(status[0]!.ended, true);
		row.end("running");
		w.display.dispose();
	});

	it("counts seconds from the 5 s mark with one timer, and has no timer when nothing is pending", () => {
		const w = world();
		const slow = w.registry.begin("tab:a", "resume", { origin: "command", step: "ownership" });
		w.advance(4_999);
		assert.equal(w.progress.find(shown => shown.location === "window")?.texts.at(-1), "Starting · checking for another OMP process");
		w.advance(1);
		assert.equal(w.progress.find(shown => shown.location === "window")?.texts.at(-1), "Starting · checking for another OMP process · 5 s");
		w.advance(2_000);
		assert.equal(w.progress.find(shown => shown.location === "window")?.texts.at(-1), "Starting · checking for another OMP process · 7 s");
		const pushed = w.pushes.length;
		w.advance(1_000);
		assert.ok(w.pushes.length > pushed, "the rows are repainted every second while seconds show");
		slow.end("running");
		w.advance(0);
		assert.equal(w.live(), 0, "no clock, grace or push timer remains");
		w.display.dispose();
	});

	it("stops every surface on dispose, including a status bar that is showing", () => {
		const w = world();
		w.registry.begin("tab:a", "open", { origin: "command" });
		w.advance(1_000);
		w.display.dispose();
		assert.ok(w.progress.every(shown => shown.ended), "view and status bar are removed");
		assert.equal(w.live(), 1, "only the registry's own 60 s mark remains");
		const before = w.pushes.length;
		w.registry.begin("tab:b", "open", { origin: "row" });
		w.advance(10_000);
		assert.equal(w.pushes.length, before, "a disposed display shows nothing");
	});
});

/**
 * Tests for the terminal pane's rules.
 *
 * Every regression here is a screen that lies. Output from a generation that has
 * been replaced, written into its successor's screen; a partial stream written into
 * an empty one after an attach; a gap in a dense sequence treated as complete; a
 * late frame changing a screen the user is reading after the process exited. None of
 * those throws — they simply show the wrong terminal — so each one is exercised
 * directly, through the same entry point the renderer uses.
 *
 * Runner: `node --test src/webview/lib/terminal-pane.test.ts`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { GuestTerminalDataMessage, GuestTerminalExitMessage, GuestTerminalSnapshotMessage, GuestTerminalStateMessage } from "../messages.ts";
import { encodeBase64 } from "./bytes-base64.ts";
import { initialTerminalPane, reduceTerminalFrame, resizeTerminalPane, timeoutTerminalAttach } from "./terminal-pane.ts";

const GENERATION = "0123456789abcdef0123456789abcdef";
const NEXT_GENERATION = "fedcba9876543210fedcba9876543210";

/** The base64 of `text`, as the host's frames carry it. */
function payload(text: string): string {
	return encodeBase64(new TextEncoder().encode(text));
}

/** Everything the effects would write, as text, in order. */
function written(effects: { readonly writes: readonly Uint8Array[] }): string[] {
	return effects.writes.map(bytes => new TextDecoder().decode(bytes));
}

function state(overrides: Partial<GuestTerminalStateMessage> = {}): GuestTerminalStateMessage {
	return {
		type: "omp:terminal-state",
		generation: GENERATION,
		seq: 0,
		phase: "attached",
		input: true,
		cols: 80,
		rows: 24,
		snapshot: "none",
		...overrides,
	};
}

function data(seq: number, text: string, generation = GENERATION): GuestTerminalDataMessage {
	return { type: "omp:terminal-data", generation, seq, bytes: payload(text) };
}

function snapshot(seq: number, text: string, generation = GENERATION): GuestTerminalSnapshotMessage {
	return { type: "omp:terminal-snapshot", generation, seq, bytes: payload(text) };
}

function exit(seq: number, code: number | null, signal: string | null = null): GuestTerminalExitMessage {
	return { type: "omp:terminal-exit", generation: GENERATION, seq, code, signal };
}

/** A pane that has actually applied a screen, not merely received metadata. */
function live(seq = 0, grid = { cols: 80, rows: 24 }) {
	const promised = reduceTerminalFrame(initialTerminalPane(grid), state({ seq, snapshot: "follows" })).state;
	return reduceTerminalFrame(promised, snapshot(seq, "current screen")).state;
}

describe("terminal pane attach and screen", () => {
	it("waits for the screen an attach promised instead of writing a partial stream", () => {
		let pane = initialTerminalPane({ cols: 100, rows: 30 });
		const adopted = reduceTerminalFrame(pane, state({ seq: 5, snapshot: "follows" }));
		pane = adopted.state;
		assert.equal(pane.awaitingSnapshot, true);
		assert.deepEqual(adopted.effects, { reset: false, writes: [], attach: false });

		// Output that arrived before the screen is not applied: the screen the host is
		// sending already contains it, and writing both would duplicate it.
		const early = reduceTerminalFrame(pane, data(4, "early"));
		pane = early.state;
		assert.deepEqual(written(early.effects), []);

		const screen = reduceTerminalFrame(pane, snapshot(5, "screen"));
		pane = screen.state;
		assert.equal(screen.effects.reset, true);
		assert.deepEqual(written(screen.effects), ["screen"]);
		assert.equal(pane.awaitingSnapshot, false);
		assert.equal(pane.seq, 5);

		const next = reduceTerminalFrame(pane, data(6, "next"));
		assert.deepEqual(written(next.effects), ["next"]);
		assert.equal(next.state.seq, 6);
	});

	it("refuses a screen the pane has already moved past, so a late screen cannot roll it back", () => {
		const pane = live(7);
		const stale = reduceTerminalFrame(pane, snapshot(3, "old screen"));
		assert.deepEqual(written(stale.effects), []);
		assert.equal(stale.state.seq, 7);
	});

	it("reports a screen it cannot decode instead of writing nothing silently", () => {
		const pane = live(1);
		const broken = reduceTerminalFrame(pane, { type: "omp:terminal-snapshot", generation: GENERATION, seq: 2, bytes: "!!!!" });
		assert.deepEqual(written(broken.effects), []);
		assert.match(broken.state.notices.join(" | "), /could not decode/);
	});

	it("replaces a startup-unavailable report with current live state without stale notices", () => {
		let pane = reduceTerminalFrame(initialTerminalPane({ cols: 80, rows: 24 }), state({
			generation: "0".repeat(32), phase: "unavailable", input: false, reason: "Broker is not attached yet",
		})).state;
		assert.equal(pane.phase, "unavailable");
		assert.equal(pane.reason, "Broker is not attached yet");
		const attached = reduceTerminalFrame(pane, state({ snapshot: "follows" }));
		assert.equal(attached.effects.reset, false, "metadata cannot erase the retained screen");
		pane = reduceTerminalFrame(attached.state, snapshot(0, "Current native TUI")).state;
		assert.equal(pane.phase, "attached");
		assert.equal(pane.owner, true);
		assert.equal(pane.reason, null);
		assert.deepEqual(pane.notices, []);
	});

	it("keeps unresolved screen damage until a valid snapshot repairs it", () => {
		let pane = live();
		pane = reduceTerminalFrame(pane, data(2, "missing previous output")).state;
		const damage = pane.notices;
		pane = reduceTerminalFrame(pane, state({ seq: 2, snapshot: "follows" })).state;
		assert.deepEqual(pane.notices, damage, "metadata alone does not repair the screen");
		pane = reduceTerminalFrame(pane, { type: "omp:terminal-snapshot", generation: GENERATION, seq: 2, bytes: "!!!!" }).state;
		assert.equal(pane.awaitingSnapshot, true);
		const repaired = reduceTerminalFrame(pane, snapshot(2, "Complete current screen"));
		assert.deepEqual(written(repaired.effects), ["Complete current screen"]);
		assert.deepEqual(repaired.state.notices, []);
		assert.equal(repaired.state.awaitingSnapshot, false);
	});
});

describe("terminal health and explicit screen outcomes", () => {
	it("preserves a promised screen wait across ordinary ownership status", () => {
		const promised = reduceTerminalFrame(live(4), state({ seq: 4, snapshot: "follows" })).state;
		const ownership = reduceTerminalFrame(promised, state({ seq: 7, input: false }));
		assert.equal(ownership.state.awaitingSnapshot, true);
		assert.equal(ownership.state.seq, 4);
		assert.deepEqual(ownership.effects, { reset: false, writes: [], attach: false });
		const pending = reduceTerminalFrame(ownership.state, data(8, "not yet"));
		assert.deepEqual(written(pending.effects), []);
		const screen = reduceTerminalFrame(pending.state, snapshot(7, "complete"));
		assert.deepEqual(written(screen.effects), ["complete"]);
		assert.equal(screen.state.awaitingSnapshot, false);
	});

	it("ends a failed screen request explicitly without clearing or pretending to repair the screen", () => {
		const promised = reduceTerminalFrame(live(4), state({ seq: 4, snapshot: "follows" })).state;
		const failed = reduceTerminalFrame(promised, state({ seq: 4, snapshot: "failed", reason: "screen exceeds the frame budget" }));
		assert.equal(failed.state.awaitingSnapshot, false);
		assert.equal(failed.state.syncing, false);
		assert.equal(failed.state.seq, 4);
		assert.deepEqual(failed.effects, { reset: false, writes: [], attach: false });
		assert.deepEqual(failed.state.notices, ["screen exceeds the frame budget"]);
	});

	it("requests a replacement once when ordinary data announces an unknown presentation", () => {
		const current = live(9);
		const first = reduceTerminalFrame(current, data(1, "new presentation", NEXT_GENERATION));
		assert.equal(first.effects.attach, true);
		assert.deepEqual(written(first.effects), []);
		assert.equal(first.state.generation, GENERATION);
		assert.equal(first.state.seq, 9);
		const again = reduceTerminalFrame(first.state, data(2, "continued", NEXT_GENERATION));
		assert.deepEqual(again.effects, { reset: false, writes: [], attach: false });
	});
});

describe("terminal pane generation fence", () => {
	it("adopts a smaller replacement sequence only with a promised screen, and rejects retired output", () => {
		let pane = live(4);
		pane = reduceTerminalFrame(pane, data(5, "from the old presentation")).state;
		const announced = reduceTerminalFrame(pane, state({ generation: NEXT_GENERATION, seq: 1 }));
		assert.equal(announced.effects.attach, true);
		assert.equal(announced.effects.reset, false);
		assert.equal(announced.state.generation, GENERATION);
		assert.equal(announced.state.seq, 5);
		const premature = reduceTerminalFrame(announced.state, data(2, "new output", NEXT_GENERATION));
		assert.deepEqual(premature.effects, { reset: false, writes: [], attach: false });
		const promised = reduceTerminalFrame(premature.state, state({ generation: NEXT_GENERATION, seq: 1, snapshot: "follows" }));
		assert.equal(promised.effects.reset, false);
		assert.equal(promised.state.seq, 1);
		const screen = reduceTerminalFrame(promised.state, snapshot(1, "replacement", NEXT_GENERATION));
		assert.equal(screen.effects.reset, true);
		assert.deepEqual(written(screen.effects), ["replacement"]);
		const stale = reduceTerminalFrame(screen.state, data(6, "late", GENERATION));
		assert.deepEqual(stale.effects, { reset: false, writes: [], attach: false });
		const fresh = reduceTerminalFrame(stale.state, data(2, "continued", NEXT_GENERATION));
		assert.deepEqual(written(fresh.effects), ["continued"]);
	});

	it("keeps the old generation's screen while a replacement is only announced", () => {
		const pane = live(4);
		const sameGeneration = reduceTerminalFrame(pane, state({ seq: 4, phase: "stopped", input: false, reason: "closed by the user" }));
		assert.equal(sameGeneration.effects.reset, false);
		assert.equal(sameGeneration.state.phase, "stopped");
		assert.equal(sameGeneration.state.owner, false);
	});
});

describe("terminal pane output gaps", () => {
	it("does not write across a gap, asks for a fresh screen once, and resumes on it", () => {
		let pane = live(2);

		const gap = reduceTerminalFrame(pane, data(4, "partial"));
		pane = gap.state;
		assert.deepEqual(written(gap.effects), [], "a frame after a gap is not written");
		assert.equal(gap.effects.attach, true, "the pane asks the host to re-verify it");
		assert.equal(pane.syncing, true);

		// More of the same broken stream changes nothing and asks nothing again.
		const again = reduceTerminalFrame(pane, data(5, "more"));
		assert.deepEqual({ ...again.effects }, { reset: false, writes: [], attach: false });

		const screen = reduceTerminalFrame(pane, snapshot(5, "rebuilt"));
		pane = screen.state;
		assert.equal(screen.effects.reset, true);
		assert.deepEqual(written(screen.effects), ["rebuilt"]);
		assert.equal(pane.syncing, false);
		assert.equal(pane.seq, 5);
	});

	it("does not call the first report it ever receives a gap", () => {
		// The host's first account of a live terminal arrives with the sequence it is already
		// at; a pane that has heard nothing has missed nothing, and saying otherwise would
		// accuse a healthy host on every attach.
		const adopted = reduceTerminalFrame(initialTerminalPane({ cols: 80, rows: 24 }), state({ seq: 4211, snapshot: "follows" }));
		assert.deepEqual([...adopted.state.notices], []);
		assert.equal(adopted.state.seq, 4211);
	});

	it("reports a gap when a report moves past output it never received", () => {
		let pane = live(1);
		pane = reduceTerminalFrame(pane, data(2, "seen")).state;
		const drifted = reduceTerminalFrame(pane, state({ seq: 9 }));
		assert.equal(drifted.effects.attach, true);
		assert.equal(drifted.effects.reset, false);
		assert.equal(drifted.state.syncing, true);
		assert.equal(drifted.state.seq, 2, "a health report cannot consume the missing output");
		const ownership = reduceTerminalFrame(drifted.state, state({ seq: 9, input: false }));
		assert.equal(ownership.state.syncing, true);
		assert.equal(ownership.effects.attach, false);
		assert.equal(ownership.state.seq, 2);
	});

	it("ignores a duplicate or an out-of-order frame", () => {
		const pane = live(3);
		const duplicate = reduceTerminalFrame(pane, data(3, "again"));
		assert.deepEqual(written(duplicate.effects), []);
		const older = reduceTerminalFrame(pane, data(1, "stale"));
		assert.deepEqual(written(older.effects), []);
		assert.equal(older.state.seq, 3);
	});
});

describe("terminal pane exit", () => {
	it("keeps the last screen, reports the exit, and refuses what arrives after it", () => {
		let pane = live(1);
		pane = reduceTerminalFrame(pane, data(2, "last line")).state;

		const ended = reduceTerminalFrame(pane, exit(3, 0));
		pane = ended.state;
		assert.equal(ended.effects.reset, false, "the screen the user is reading is kept");
		assert.deepEqual(written(ended.effects), []);
		assert.equal(pane.phase, "stopped");
		assert.equal(pane.owner, false);
		assert.deepEqual(pane.exit, { code: 0, signal: null });

		const late = reduceTerminalFrame(pane, data(4, "after the exit"));
		assert.deepEqual(written(late.effects), []);
		assert.equal(late.state.seq, 3);
	});

	it("keeps the signalled exit current when the same exit arrives again", () => {
		const pane = live(1);
		const ended = reduceTerminalFrame(pane, exit(2, null, "SIGINT")).state;
		assert.deepEqual(ended.exit, { code: null, signal: "SIGINT" });
		const repeated = reduceTerminalFrame(ended, exit(2, null, "SIGINT")).state;
		assert.deepEqual(repeated.exit, { code: null, signal: "SIGINT" });
		assert.equal(repeated.phase, "stopped");
	});
});

describe("terminal pane ownership and grid", () => {
	it("renders the host's grid while it does not own input, and keeps its own while it does", () => {
		const fit = { cols: 100, rows: 30 };
		let pane = live(0, fit);

		// A passive pane (another editor owns input) shows the same screen the owner
		// sees, so it renders the host's grid rather than its own fit.
		pane = reduceTerminalFrame(pane, state({ input: false, cols: 80, rows: 24 })).state;
		assert.equal(pane.owner, false);
		assert.deepEqual(pane.grid, { cols: 80, rows: 24 });

		// Its own later fit is remembered for the next attach but does not change what
		// it renders while the host's grid is authoritative.
		pane = resizeTerminalPane(pane, { cols: 120, rows: 40 });
		assert.deepEqual(pane.fit, { cols: 120, rows: 40 }, "the pane remembers its fit for the next attach");
		assert.deepEqual(pane.grid, { cols: 80, rows: 24 }, "a passive pane keeps rendering the host's grid");
		pane = reduceTerminalFrame(pane, state({ input: false, cols: 80, rows: 24 })).state;
		assert.deepEqual(pane.grid, { cols: 80, rows: 24 });

		// Owning input makes the pane's own fit authoritative: it is the grid it asked
		// the host to resize the PTY to, and the host reports the same numbers back.
		pane = reduceTerminalFrame(pane, state({ input: true, cols: 80, rows: 24 })).state;
		assert.equal(pane.owner, true);
		assert.deepEqual(pane.grid, { cols: 120, rows: 40 });
	});

	it("does not own input while the terminal is stopped or unavailable", () => {
		const stopped = reduceTerminalFrame(initialTerminalPane({ cols: 80, rows: 24 }), state({ phase: "stopped", input: true })).state;
		assert.equal(stopped.owner, false);
		const unavailable = reduceTerminalFrame(initialTerminalPane({ cols: 80, rows: 24 }), state({ phase: "unavailable", input: true })).state;
		assert.equal(unavailable.owner, false);
	});
});

describe("terminal pane host silence", () => {
	it("says the screen may be out of date when an attach was not answered, once", () => {
		let pane = initialTerminalPane({ cols: 80, rows: 24 });
		pane = reduceTerminalFrame(pane, state({ seq: 1, snapshot: "follows" })).state;
		assert.equal(pane.awaitingSnapshot, true);

		pane = timeoutTerminalAttach(pane);
		assert.equal(pane.hostSilent, true);
		assert.equal(pane.awaitingSnapshot, false);

		// A report clears the current silence condition.
		pane = timeoutTerminalAttach(pane);
		pane = reduceTerminalFrame(pane, state({ seq: 1 })).state;
		assert.equal(pane.hostSilent, false);
	});

	it("revokes input on an unanswered live-pane probe without replacing the copyable screen, then accepts a rebound host", () => {
		let pane = live(3);
		assert.equal(pane.owner, true);
		pane = timeoutTerminalAttach(pane, true);
		assert.equal(pane.hostSilent, true);
		assert.equal(pane.owner, false);
		assert.equal(pane.generation, GENERATION);
		assert.equal(pane.seq, 3);
		pane = reduceTerminalFrame(pane, state({ seq: 3, input: true })).state;
		assert.equal(pane.hostSilent, false);
		assert.equal(pane.owner, true);
		assert.equal(pane.seq, 3);
	});

	it("does nothing when nothing was outstanding", () => {
		// A live, attached pane that has answered has no outstanding request, so a late
		// timer must not claim the host went silent.
		const pane = live(3);
		assert.equal(pane.awaitingSnapshot, false);
		assert.equal(timeoutTerminalAttach(pane), pane);
	});

});

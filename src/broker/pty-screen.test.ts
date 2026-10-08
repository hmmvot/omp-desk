/**
 * Tests for the broker's screen model.
 *
 * Runner: `node --test src/broker/pty-screen.test.ts`
 *
 * This is what a frontend that was not watching gets: a serialized screen that is
 * exactly the state at a stated output position, or a byte replay from a position the
 * frontend already had. What matters is that positions are contiguous and trimmable,
 * that a bounded backlog admits when it has dropped something, and that the
 * serialization comes from the same emulator that consumed the stream.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import headless from "@xterm/headless";
import { PtyScreenModel, type PtyScreenChunk } from "./pty-screen.ts";

/** Feed `data` and resolve once the headless parser has consumed it. */
async function settled(screen: PtyScreenModel, ...writes: readonly string[]): Promise<void> {
	for (const data of writes) screen.write(data);
	// A snapshot drains the parse queue itself, so it is the wait this test needs.
	await screen.snapshot();
}

describe("output positions", () => {
	it("numbers output contiguously and hands each listener its own position", () => {
		const screen = new PtyScreenModel({ cols: 20, rows: 5 });
		const seen: PtyScreenChunk[] = [];
		screen.onOutput(chunk => seen.push(chunk));
		screen.write("abc");
		screen.write("de");
		assert.deepEqual(
			seen.map(chunk => [chunk.fromPosition, chunk.data]),
			[
				[0, "abc"],
				[3, "de"],
			],
		);
		assert.equal(screen.position, 5);
		assert.equal(screen.oldestPosition, 0);
		screen.dispose();
	});

	it("trims a replay to exactly the requested position", () => {
		const screen = new PtyScreenModel({ cols: 20, rows: 5 });
		screen.write("abc");
		screen.write("defgh");
		const replay = screen.backlogSince(4);
		assert.equal(replay.truncated, false);
		assert.deepEqual(
			replay.chunks.map(chunk => [chunk.fromPosition, chunk.data]),
			[
				[4, "efgh"],
			],
		);
		assert.equal(replay.chunks.map(chunk => chunk.data).join(""), "efgh");
		// A request at the current position replays nothing, which is how a live-only
		// attachment starts.
		assert.deepEqual(screen.backlogSince(screen.position).chunks, []);
		screen.dispose();
	});

	it("says so when the backlog no longer holds what was asked for", () => {
		const screen = new PtyScreenModel({ cols: 20, rows: 5, backlogChars: 64 * 1024 });
		screen.write("x".repeat(64 * 1024));
		screen.write("y".repeat(1024));
		const replay = screen.backlogSince(0);
		assert.equal(replay.truncated, true);
		assert.equal(replay.oldestPosition, 64 * 1024);
		assert.equal(replay.chunks.map(chunk => chunk.data).join(""), "y".repeat(1024));
		screen.dispose();
	});
});

describe("snapshots", () => {
	it("serializes the screen at the position it reports", async () => {
		const screen = new PtyScreenModel({ cols: 40, rows: 6 });
		await settled(screen, "first line\r\n", "\u001b[31mred\u001b[0m text\r\n", "third");
		const snapshot = await screen.snapshot();
		assert.equal(snapshot.position, screen.position);
		assert.equal(snapshot.chars, snapshot.data.length);
		assert.match(snapshot.data, /first line/);
		assert.match(snapshot.data, /red/);
		assert.equal(snapshot.cols, 40);
		assert.equal(snapshot.rows, 6);
		assert.equal(snapshot.alt, false);
		assert.equal(snapshot.cursorVisible, true);
		assert.equal(snapshot.truncated, false);
		// What the snapshot shows and where the stream is are the same moment: a replay
		// from this position is what follows the screen, with no gap and no repeat.
		const replay = screen.backlogSince(snapshot.position);
		assert.deepEqual(replay.chunks, []);
		screen.dispose();
	});

	it("keeps the alternate screen and its modes in the serialization", async () => {
		const screen = new PtyScreenModel({ cols: 40, rows: 6 });
		await settled(screen, "\u001b[?1049h\u001b[2J\u001b[HTUI ROW ONE\r\nTUI ROW TWO");
		const snapshot = await screen.snapshot();
		assert.equal(snapshot.alt, true);
		assert.match(snapshot.data, /TUI ROW ONE/);
		assert.match(snapshot.data, /\u001b\[\?1049h/);
		screen.dispose();
	});

	it("reports the title it was given and a resized geometry", async () => {
		const screen = new PtyScreenModel({ cols: 40, rows: 6 });
		await settled(screen, "\u001b]0;a title\u0007", "hello");
		assert.equal(screen.title, "a title");
		screen.resize(80, 20);
		assert.equal(screen.cols, 80);
		assert.equal(screen.rows, 20);
		screen.dispose();
	});

	it("bounds a title the child produced, and serializes within its stated bound", async () => {
		const screen = new PtyScreenModel({ cols: 120, rows: 20, snapshotChars: 64 * 1024 });
		await settled(screen, `\u001b]0;${"t".repeat(4000)}\u0007`, "x");
		assert.equal(screen.title?.length, 256, "the stored title must fit one frame");
		// The line estimate is only a starting point: the serialized result itself is what
		// the bound applies to, so a screen whose scrollback would exceed it is reduced and
		// reports itself as truncated rather than silently exceeding the promise.
		const lines = Array.from({ length: 400 }, () => "x".repeat(190)).join("\r\n");
		await settled(screen, lines);
		const snapshot = await screen.snapshot();
		assert.ok(snapshot.chars <= 64 * 1024, `snapshot was ${snapshot.chars} chars`);
		assert.equal(snapshot.truncated, true);
		screen.dispose();
	});

	it("stops accepting output once disposed", () => {
		const screen = new PtyScreenModel({ cols: 20, rows: 5 });
		let seen = 0;
		screen.onOutput(() => {
			seen += 1;
		});
		screen.write("a");
		screen.dispose();
		screen.write("b");
		assert.equal(seen, 1);
		assert.equal(screen.position, 1);
	});
});

describe("cell widths", () => {
	/** What the OMP TUI draws for an input row holding wide characters, cursor parked at the insertion point. */
	const row = "\u001b[2J\u001b[H> \u231A \u{1F600} \u4F60\u597D";
	// `>`, space, then U+231A (2), space, U+1F600 (2), space, two CJK (4): the TUI counts 12 cells.
	const insertion = 12;

	it("places the cursor and text where the TUI counted, as live state and after a snapshot", async () => {
		const screen = new PtyScreenModel({ cols: 40, rows: 6 });
		await settled(screen, row);
		const live = await screen.snapshot();
		assert.equal(live.cursorX, insertion);

		// A reattach restores the serialization into a fresh renderer-side parser: the
		// same table there must give the same screen the mirror holds.
		const restored = new headless.Terminal({ cols: 40, rows: 6, allowProposedApi: true });
		try {
			restored.loadAddon(new Unicode11Addon());
			restored.unicode.activeVersion = "11";
			await new Promise<void>(resolve => restored.write(live.data, resolve));
			assert.equal(restored.buffer.active.cursorX, insertion);
			assert.equal(restored.buffer.active.getLine(0)?.translateToString(true), "> \u231A \u{1F600} \u4F60\u597D");
		} finally {
			restored.dispose();
			screen.dispose();
		}
	});

	it("keeps a CSI-addressed cursor on the character the TUI meant", async () => {
		const screen = new PtyScreenModel({ cols: 40, rows: 6 });
		// Column 5 (1-based) is the space after U+231A once it is two cells wide.
		await settled(screen, row, "\u001b[5GZ");
		const snapshot = await screen.snapshot();
		assert.equal(snapshot.cursorX, 5);
		assert.match(snapshot.data, /> \u231AZ\u{1F600}/u);
		screen.dispose();
	});
});

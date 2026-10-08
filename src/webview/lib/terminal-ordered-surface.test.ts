import assert from "node:assert/strict";
import { describe, it } from "node:test";
import headless from "@xterm/headless";
import type { Terminal as HeadlessTerminal } from "@xterm/headless";

import { OrderedTerminalSurface } from "./terminal-ordered-surface.ts";

const { Terminal } = headless;
const encoder = new TextEncoder();

function visibleRows(terminal: HeadlessTerminal): string[] {
	const buffer = terminal.buffer.active;
	return Array.from({ length: terminal.rows }, (_, y) => buffer.getLine(buffer.baseY + y)?.translateToString(true).trimEnd() ?? "");
}

function emulator(cols = 20, rows = 6): { terminal: HeadlessTerminal; surface: OrderedTerminalSurface; screen: () => string[] } {
	const terminal = new Terminal({ cols, rows, allowProposedApi: true });
	const surface = new OrderedTerminalSurface({
		write: (bytes, done) => terminal.write(bytes, done),
		reset: () => terminal.reset(),
		resize: (c, r) => terminal.resize(c, r),
	});
	return { terminal, surface, screen: () => visibleRows(terminal) };
}

function drained(terminal: HeadlessTerminal): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	terminal.write("", resolve);
	return promise;
}

async function settle(surface: OrderedTerminalSurface, terminal: HeadlessTerminal): Promise<void> {
	// Writes release the queue from parse callbacks, so a few turns settle any chain.
	for (let turn = 0; turn < 8; turn++) await drained(terminal);
	assert.equal(surface.pending, 0);
}

describe("OrderedTerminalSurface", () => {
	it("a restored screen replaces the one still waiting to be parsed instead of landing after it", async () => {
		const { terminal, surface, screen } = emulator();
		// The page is busy or hidden: this output is accepted but has not been parsed yet.
		surface.write(encoder.encode("OLD one\r\nOLD two\r\n"));
		surface.reset();
		surface.write(encoder.encode("NEW snapshot\r\nNEW row"));
		await settle(surface, terminal);
		assert.deepEqual(screen().slice(0, 3), ["NEW snapshot", "NEW row", ""]);
	});

	it("demonstrates the defect it prevents: a bare reset leaves older bytes to be parsed onto the fresh screen", async () => {
		const terminal = new Terminal({ cols: 20, rows: 6, allowProposedApi: true });
		terminal.write("OLD one\r\nOLD two\r\n");
		terminal.reset();
		terminal.write("NEW snapshot\r\nNEW row");
		await drained(terminal);
		assert.deepEqual(visibleRows(terminal).slice(0, 4), ["OLD one", "OLD two", "NEW snapshot", "NEW row"], "the old and new screens are stacked");
	});

	it("two restores in a row leave exactly one screen", async () => {
		const { terminal, surface, screen } = emulator();
		surface.write(encoder.encode("first snapshot\r\nlive A\r\n"));
		surface.reset();
		surface.write(encoder.encode("second snapshot\r\nlive B"));
		await settle(surface, terminal);
		assert.deepEqual(screen().slice(0, 3), ["second snapshot", "live B", ""]);
	});

	it("applies a resize between the bytes written before it and after it", async () => {
		const { terminal, surface, screen } = emulator(20, 6);
		// Drawn for 20 columns: parsed at 8 columns this line would already have wrapped.
		surface.write(encoder.encode("0123456789ABCDEF"));
		surface.resize(8, 6);
		surface.write(encoder.encode("\r\nshort"));
		await settle(surface, terminal);
		assert.equal(terminal.cols, 8);
		assert.equal(screen()[0], "01234567", "the older bytes were parsed at the old grid, then reflowed");
		assert.ok(screen().includes("short"));
	});

	it("is a pass-through when nothing is pending", async () => {
		const { terminal, surface, screen } = emulator();
		surface.write(encoder.encode("plain"));
		assert.equal(surface.pending, 1);
		await settle(surface, terminal);
		assert.equal(screen()[0], "plain");
		surface.resize(10, 4);
		assert.equal(terminal.cols, 10, "a resize with nothing pending is applied at once");
	});

	it("drops queued work after dispose", async () => {
		const { terminal, surface, screen } = emulator();
		surface.write(encoder.encode("before"));
		surface.reset();
		surface.write(encoder.encode("after"));
		surface.dispose();
		await drained(terminal);
		assert.equal(screen()[0], "before", "the reset and what followed it never ran");
	});
});

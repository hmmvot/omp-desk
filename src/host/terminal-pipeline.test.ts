/**
 * The host terminal pane: framing, ownership and the exact generation boundary.
 *
 * The writer is a small in-memory fake, so every rule here is exercised without a
 * real PTY: dense output sequences, base64 of exact UTF-8 bytes, one input owner
 * at a time, and a generation a page cannot talk past.
 *
 * Runner: `node --test src/host/terminal-pipeline.test.ts`
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import headless from "@xterm/headless";

import { TerminalPipeline, fitTerminalSnapshot, placeSnapshotCursor } from "./terminal-pipeline.ts";
import { PtyScreenModel } from "../broker/pty-screen.ts";
import { initialTerminalPane, reduceTerminalFrame } from "../webview/lib/terminal-pane.ts";
import type {
	TerminalHostMessage,
	TerminalWriter,
	TerminalWriterEvent,
	TerminalWriterSnapshot,
	TerminalWriterStatus,
} from "./terminal-pipeline.ts";

interface FakeWriter extends TerminalWriter {
	readonly writes: { readonly data: string; readonly frontendId: string }[];
	readonly resizes: { readonly cols: number; readonly rows: number; readonly frontendId: string }[];
	readonly claims: { readonly frontendId: string; readonly takeover: boolean }[];
	readonly releases: string[];
	emit(event: TerminalWriterEvent): void;
	setStatus(status: Partial<TerminalWriterStatus>): void;
}

function createFakeWriter(): FakeWriter {
	const listeners = new Set<(event: TerminalWriterEvent) => void>();
	const writes: { data: string; frontendId: string }[] = [];
	const resizes: { cols: number; rows: number; frontendId: string }[] = [];
	const claims: { frontendId: string; takeover: boolean }[] = [];
	const releases: string[] = [];
	let status: TerminalWriterStatus = {
		state: "running",
		exitCode: null,
		signal: null,
		cols: 80,
		rows: 24,
		alt: false,
		title: null,
		seq: 0,
		oldestSeq: 0,
		inputOwner: null,
		notices: [],
	};
	const snapshot: TerminalWriterSnapshot = { seq: 0, cols: 80, rows: 24, alt: false, truncated: false, data: "\u001b[2Jready" };
	return {
		nativePid: 4242,
		nativeCreationTime: "133000000000000000",
		writes,
		resizes,
		claims,
		releases,
		async status() {
			return { ...status };
		},
		async snapshot() {
			return { ...snapshot };
		},
		async write(data, frontendId) {
			writes.push({ data, frontendId });
		},
		async resize(cols, rows, frontendId) {
			resizes.push({ cols, rows, frontendId });
			status = { ...status, cols, rows };
		},
		async claimInput(frontendId, takeover) {
			claims.push({ frontendId, takeover });
			if (status.inputOwner === null || status.inputOwner === frontendId || takeover) status = { ...status, inputOwner: frontendId };
			for (const listener of listeners) listener({ kind: "input-owner", frontendId: status.inputOwner });
			return status.inputOwner;
		},
		async releaseInput(frontendId) {
			releases.push(frontendId);
			if (status.inputOwner === frontendId) status = { ...status, inputOwner: null };
			for (const listener of listeners) listener({ kind: "input-owner", frontendId: status.inputOwner });
		},
		watch(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		emit(event) {
			if (event.kind === "output") status = { ...status, seq: event.seq };
			if (event.kind === "input-owner") status = { ...status, inputOwner: event.frontendId };
			for (const listener of listeners) listener(event);
		},
		setStatus(next) {
			status = { ...status, ...next };
		},
	};
}

interface Collector {
	readonly messages: TerminalHostMessage[];
	readonly send: (message: TerminalHostMessage) => void;
}

function collector(): Collector {
	const messages: TerminalHostMessage[] = [];
	return { messages, send: message => messages.push(message) };
}

/** Apply the real renderer's reset/write effects, not just the host's envelope. */
function screenConsumer() {
	let state = initialTerminalPane({ cols: 80, rows: 24 });
	let screen = "";
	let resets = 0;
	let repairs = 0;
	return {
		send(message: TerminalHostMessage) {
			const result = reduceTerminalFrame(state, message);
			state = result.state;
			if (result.effects.reset) { screen = ""; resets += 1; }
			if (result.effects.attach) repairs += 1;
			for (const bytes of result.effects.writes) screen += Buffer.from(bytes).toString("utf8");
		},
		get state() { return state; },
		get screen() { return screen; },
		get resets() { return resets; },
		get repairs() { return repairs; },
	};
}

/** Decode one terminal frame's payload for an exact comparison. */
function decoded(message: TerminalHostMessage): string {
	if (message.type !== "omp:terminal-data" && message.type !== "omp:terminal-snapshot") {
		throw new Error(`not a byte frame: ${message.type}`);
	}
	return Buffer.from(message.bytes, "base64").toString("utf8");
}

async function startedPipeline(writer: FakeWriter, onSeen?: () => void): Promise<TerminalPipeline> {
	const pipeline = new TerminalPipeline({
		writer,
		label: "C:\\work",
		authority: null,
		...(onSeen === undefined ? {} : { onSeen }),
	});
	await pipeline.start();
	return pipeline;
}

describe("TerminalPipeline framing", () => {
	it("fans out output as dense base64 frames with the exact UTF-8 bytes", async () => {
		const writer = createFakeWriter();
		const pipeline = await startedPipeline(writer);
		const first = collector();
		const second = collector();
		pipeline.register("page-a", first.send);
		pipeline.register("page-b", second.send);
		try {
			writer.emit({ kind: "output", seq: 1, data: "hi \u{1f642}" });
			writer.emit({ kind: "output", seq: 2, data: "there" });

			const data = first.messages.filter(message => message.type === "omp:terminal-data");
			assert.equal(data.length, 2);
			assert.deepEqual(
				data.map(message => message.seq),
				[2, 3],
				"the renderer's sequence must be dense and start above zero",
			);
			assert.deepEqual(data.map(decoded), ["hi \u{1f642}", "there"]);
			assert.equal(data.every(message => message.generation === pipeline.generation), true);
			// A hidden page still receives output: it must not fall behind the writer.
			assert.deepEqual(
				second.messages.filter(message => message.type === "omp:terminal-data").map(decoded),
				["hi \u{1f642}", "there"],
			);
		} finally {
			pipeline.dispose();
		}
	});

	it("splits a large write into frames that stay inside the decoded budget", async () => {
		const writer = createFakeWriter();
		const pipeline = await startedPipeline(writer);
		const page = collector();
		pipeline.register("page-a", page.send);
		try {
			// Four-byte characters: a naive character-count split would overflow.
			const data = "\u{1f642}".repeat(40_000);
			writer.emit({ kind: "output", seq: 1, data });
			const frames = page.messages.filter(message => message.type === "omp:terminal-data");
			assert.ok(frames.length > 1, "an oversized write must be split");
			for (const frame of frames) {
				assert.ok(Buffer.from(frame.bytes, "base64").length <= 64 * 1024);
			}
			assert.equal(frames.map(decoded).join(""), data, "no character may be lost or half-encoded");
			assert.deepEqual(
				frames.map(frame => frame.seq),
				frames.map((_frame, index) => index + 2),
				"live data continues the sequence the attach state reported",
			);
		} finally {
			pipeline.dispose();
		}
	});

	it("reports an exit once and leaves the pane stopped", async () => {
		const writer = createFakeWriter();
		const pipeline = await startedPipeline(writer);
		const page = collector();
		pipeline.register("page-a", page.send);
		try {
			writer.emit({ kind: "exit", seq: 7, code: 0, signal: null });
			const exits = page.messages.filter(message => message.type === "omp:terminal-exit");
			assert.deepEqual(exits, [
				{ type: "omp:terminal-exit", generation: pipeline.generation, seq: 1, code: 0, signal: null },
			]);
			assert.equal(pipeline.phase, "stopped");
			const states = page.messages.filter(message => message.type === "omp:terminal-state");
			assert.equal(states.at(-1)?.phase, "stopped");
			assert.match(String(states.at(-1)?.reason), /exit code 0/);
		} finally {
			pipeline.dispose();
		}
	});
});

describe("TerminalPipeline ownership", () => {
	it("grants an unowned broker to an authorized visible pane without requiring browser focus", async () => {
		const writer = createFakeWriter();
		const pipeline = await startedPipeline(writer);
		const page = collector();
		pipeline.register("page-a", page.send);
		try {
			// The terminal pane is not displayed yet, so nothing owns input.
			pipeline.notePanelVisible(true);
			await pipeline.settled;
			assert.deepEqual(writer.claims, []);
			assert.equal(pipeline.inputOwner, null);

			await pipeline.settled;
			assert.deepEqual(writer.claims, [], "a pane that is not displayed cannot own input");

			pipeline.noteVisibility("page-a", true);
			pipeline.noteFocus("page-a", true);
			await pipeline.settled;
			assert.deepEqual(writer.claims, [{ frontendId: "page-a", takeover: false }]);
			assert.equal(pipeline.inputOwner, "page-a");
			const owned = page.messages.filter(message => message.type === "omp:terminal-state").at(-1);
			assert.equal(owned?.input, true);
			assert.equal(owned?.cols, 80);

		} finally {
			pipeline.dispose();
		}
	});

	it("keeps a passive second pane read-only while the owner keeps input", async () => {
		const writer = createFakeWriter();
		const pipeline = await startedPipeline(writer);
		const owner = collector();
		const passive = collector();
		pipeline.register("page-a", owner.send);
		pipeline.register("page-b", passive.send);
		try {
			pipeline.notePanelVisible(true);
			pipeline.noteVisibility("page-a", true);
			pipeline.noteFocus("page-a", true);
			pipeline.noteVisibility("page-b", true);
			await pipeline.settled;
			assert.deepEqual(writer.claims, [{ frontendId: "page-a", takeover: false }]);

			await pipeline.input("page-b", { generation: pipeline.generation, data: Buffer.from("x").toString("base64") });
			assert.deepEqual(writer.writes, [], "a passive pane must not reach the writer");
			await pipeline.input("page-a", { generation: pipeline.generation, data: Buffer.from("y").toString("base64") });
			assert.deepEqual(writer.writes, [{ data: "y", frontendId: "page-a" }]);
		} finally {
			pipeline.dispose();
		}
	});

	it("refuses input and resize from a page naming another generation", async () => {
		const writer = createFakeWriter();
		const pipeline = await startedPipeline(writer);
		const page = collector();
		pipeline.register("page-a", page.send);
		try {
			pipeline.notePanelVisible(true);
			pipeline.noteVisibility("page-a", true);
			pipeline.noteFocus("page-a", true);
			await pipeline.settled;

			const stale = "f".repeat(32);
			await pipeline.input("page-a", { generation: stale, data: Buffer.from("x").toString("base64") });
			await pipeline.resize("page-a", { generation: stale, cols: 100, rows: 30 });
			assert.deepEqual(writer.writes, []);
			assert.deepEqual(writer.resizes, []);

			// The owning page's own resize is applied and broadcast with the new grid.
			await pipeline.resize("page-a", { generation: pipeline.generation, cols: 100, rows: 30 });
			assert.deepEqual(writer.resizes, [{ cols: 100, rows: 30, frontendId: "page-a" }]);
			assert.equal(page.messages.filter(message => message.type === "omp:terminal-state").at(-1)?.cols, 100);
		} finally {
			pipeline.dispose();
		}
	});

	it("refuses a non-canonical base64 keystroke instead of writing it", async () => {
		const writer = createFakeWriter();
		const pipeline = await startedPipeline(writer);
		pipeline.register("page-a", collector().send);
		try {
			pipeline.notePanelVisible(true);
			pipeline.noteVisibility("page-a", true);
			pipeline.noteFocus("page-a", true);
			await pipeline.settled;
			for (const data of ["", "!!!", "YQ", "YR==", Buffer.alloc(64 * 1024 + 1, 0x41).toString("base64")]) {
				await pipeline.input("page-a", { generation: pipeline.generation, data });
			}
			assert.deepEqual(writer.writes, []);
			await pipeline.input("page-a", { generation: pipeline.generation, data: Buffer.from("ok").toString("base64") });
			assert.deepEqual(writer.writes, [{ data: "ok", frontendId: "page-a" }]);
		} finally {
			pipeline.dispose();
		}
	});
});

describe("terminal presentation recovery and broker authority", () => {
	it("preserves the scrolled viewport through healthy probes and output, following only at the bottom", async () => {
		const writer = createFakeWriter();
		writer.snapshot = async () => ({
			seq: 0, cols: 80, rows: 24, alt: false, truncated: false,
			data: Array.from({ length: 80 }, (_, index) => `HISTORY-${String(index).padStart(3, "0")}`).join("\r\n"),
		});
		const pipeline = await startedPipeline(writer);
		const terminal = new headless.Terminal({ cols: 80, rows: 24, scrollback: 4000, allowProposedApi: true, logLevel: "off" });
		let pane = initialTerminalPane({ cols: 80, rows: 24 });
		const writes: Promise<void>[] = [];
		const flush = async (): Promise<void> => { await Promise.all(writes.splice(0)); };
		pipeline.register("page-a", message => {
			const result = reduceTerminalFrame(pane, message);
			pane = result.state;
			if (result.effects.reset) terminal.reset();
			for (const bytes of result.effects.writes) writes.push(new Promise(resolve => terminal.write(bytes, resolve)));
		});
		try {
			await pipeline.attach("page-a", { generation: null, cols: 80, rows: 24 });
			await flush();
			terminal.scrollLines(-20);
			const viewport = terminal.buffer.active.viewportY;
			assert.equal(terminal.buffer.active.getLine(viewport)?.translateToString(true), "HISTORY-036");

			pipeline.notePanelVisible(true);
			pipeline.noteVisibility("page-a", true);
			pipeline.noteFocus("page-a", true);
			await pipeline.settled;
			pipeline.noteFocus("page-a", false);
			await pipeline.settled;
			await pipeline.probe("page-a", { generation: pipeline.generation, seq: pane.seq });
			await flush();
			assert.equal(terminal.buffer.active.viewportY, viewport, "ownership and liveness cannot move the reading position");
			assert.equal(terminal.buffer.active.getLine(viewport)?.translateToString(true), "HISTORY-036");

			writer.emit({ kind: "output", seq: 1, data: "\r\nLIVE-A" });
			await flush();
			assert.equal(terminal.buffer.active.viewportY, viewport, "new output must not follow while scrolled up");
			assert.equal(terminal.buffer.active.getLine(viewport)?.translateToString(true), "HISTORY-036");
			assert.equal(terminal.buffer.active.getLine(terminal.buffer.active.baseY + terminal.rows - 1)?.translateToString(true), "LIVE-A");

			terminal.scrollToBottom();
			writer.emit({ kind: "output", seq: 2, data: "\r\nLIVE-B" });
			await flush();
			assert.equal(terminal.buffer.active.viewportY, terminal.buffer.active.baseY, "new output follows a reader already at the bottom");
			assert.equal(terminal.buffer.active.getLine(terminal.buffer.active.viewportY + terminal.rows - 1)?.translateToString(true), "LIVE-B");
		} finally {
			pipeline.dispose();
			terminal.dispose();
		}
	});

	it("repairs a foreign probe namespace with the broker's actual retained screen", async () => {
		const writer = createFakeWriter();
		writer.snapshot = async () => ({ seq: 0, cols: 80, rows: 24, alt: false, truncated: false, data: "current screen" });
		const pipeline = await startedPipeline(writer);
		const page = screenConsumer();
		pipeline.register("page-a", page.send);
		try {
			await pipeline.probe("page-a", { generation: "f".repeat(32), seq: 100 });
			assert.equal(page.screen, "current screen");
			assert.equal(page.resets, 1);
			assert.equal(page.state.generation, pipeline.generation);
			assert.equal(page.state.awaitingSnapshot, false);
			writer.emit({ kind: "output", seq: 0, data: " follows" });
			assert.equal(page.screen, "current screen follows");
			assert.equal(page.repairs, 0);
		} finally { pipeline.dispose(); }
	});

	it("restores a long session's screen by dropping only the oldest scrollback instead of failing the attach", async () => {
		const writer = createFakeWriter();
		const rows = 24;
		const lines = Array.from({ length: 4000 }, (_unused, line) => `\u001b[31mline ${String(line).padStart(4, "0")}\u001b[0m ${"x".repeat(80)}`);
		const data = lines.join("\r\n") + "\u001b[24;1H";
		assert.ok(Buffer.byteLength(data) > 131_070, "the fixture is larger than one frame");
		writer.snapshot = async () => ({ seq: 0, cols: 80, rows, alt: false, truncated: false, data });
		const pipeline = await startedPipeline(writer);
		const page = screenConsumer();
		const states: TerminalHostMessage[] = [];
		pipeline.register("page-a", message => { states.push(message); page.send(message); });
		try {
			await pipeline.attach("page-a", { generation: null, cols: 80, rows });
			assert.equal(states.some(message => message.type === "omp:terminal-state" && message.snapshot === "failed"), false, "no failure is reported");
			const snapshot = states.find(message => message.type === "omp:terminal-snapshot")!;
			const restored = decoded(snapshot);
			assert.ok(Buffer.byteLength(restored) <= 131_070);
			assert.ok(restored.startsWith("\u001b[0m"), "attributes a dropped line left set are reset");
			assert.ok(restored.endsWith("line 3999\u001b[0m " + "x".repeat(80) + "\u001b[24;1H"), "the visible screen and the cursor are intact");
			assert.equal(page.state.awaitingSnapshot, false);
		} finally { pipeline.dispose(); }
	});

	it("reads the screen again when live output outran the first reading, and only then gives up in plain words", async () => {
		const writer = createFakeWriter();
		let readings = 0;
		writer.snapshot = async () => {
			readings += 1;
			// While the first reading is in flight more output arrives than one reply can hold.
			if (readings === 1) for (let burst = 0; burst < 3; burst++) writer.emit({ kind: "output", seq: burst + 1, data: "y".repeat(60_000) });
			return { seq: 3 * 60_000, cols: 80, rows: 24, alt: false, truncated: false, data: "settled screen" };
		};
		const pipeline = await startedPipeline(writer);
		const page = collector();
		pipeline.register("page-a", page.send);
		try {
			await pipeline.attach("page-a", { generation: null, cols: 80, rows: 24 });
			assert.equal(readings, 2, "the second reading covers what the first could not hold");
			assert.equal(page.messages.some(message => message.type === "omp:terminal-state" && message.snapshot === "failed"), false);
			assert.equal(decoded(page.messages.find(message => message.type === "omp:terminal-snapshot")!), "settled screen");
		} finally { pipeline.dispose(); }

		const stubborn = createFakeWriter();
		let tries = 0;
		stubborn.snapshot = async () => {
			tries += 1;
			for (let burst = 0; burst < 3; burst++) stubborn.emit({ kind: "output", seq: tries * 10 + burst, data: "z".repeat(60_000) });
			return { seq: 0, cols: 80, rows: 24, alt: false, truncated: false, data: "never fits" };
		};
		const hopeless = await startedPipeline(stubborn);
		const failed = collector();
		hopeless.register("page-b", failed.send);
		try {
			await hopeless.attach("page-b", { generation: null, cols: 80, rows: 24 });
			const failure = failed.messages.find(message => message.type === "omp:terminal-state" && message.snapshot === "failed");
			assert.ok(failure !== undefined && failure.type === "omp:terminal-state");
			assert.match(failure.reason ?? "", /^The earlier screen of this terminal could not be restored/);
			assert.doesNotMatch(failure.reason ?? "", /bounded|frame|broker|writer/i, "no internal vocabulary reaches the pane");
		} finally { hopeless.dispose(); }
	});

	it("retains acknowledged ownership across blur, but visibility revokes input and resize", async () => {
		const writer = createFakeWriter();
		const seen: string[] = [];
		const pipeline = await startedPipeline(writer, () => seen.push("seen"));
		pipeline.register("page-a", collector().send);
		try {
			pipeline.notePanelVisible(true); pipeline.noteVisibility("page-a", true);
			pipeline.noteFocus("page-a", true); await pipeline.settled;
			pipeline.noteFocus("page-a", false); await pipeline.settled;
			await pipeline.resize("page-a", { generation: pipeline.generation, cols: 100, rows: 30 });
			assert.deepEqual(writer.resizes, [{ frontendId: "page-a", cols: 100, rows: 30 }]);
			pipeline.seen("page-a", { generation: pipeline.generation, outcome: "stop" });
			assert.deepEqual(seen, [], "an unfocused owner cannot mark a turn seen");
			pipeline.noteVisibility("page-a", false); await pipeline.settled;
			await pipeline.input("page-a", { generation: pipeline.generation, data: Buffer.from("hidden").toString("base64") });
			await pipeline.resize("page-a", { generation: pipeline.generation, cols: 120, rows: 40 });
			assert.deepEqual(writer.writes, []);
			assert.deepEqual(writer.resizes, [{ frontendId: "page-a", cols: 100, rows: 30 }]);
			assert.deepEqual(writer.releases, ["page-a"]);
		} finally { pipeline.dispose(); }
	});

	it("does not take a foreign broker owner on replayed presence, but real intent can take it", async () => {
		const writer = createFakeWriter();
		writer.setStatus({ inputOwner: "external" });
		const pipeline = await startedPipeline(writer);
		pipeline.register("page-a", collector().send);
		try {
			pipeline.notePanelVisible(true); pipeline.noteVisibility("page-a", true);
			pipeline.noteFocus("page-a", true); await pipeline.settled;
			await pipeline.input("page-a", { generation: pipeline.generation, data: Buffer.from("blocked").toString("base64") });
			assert.deepEqual(writer.writes, []);
			assert.deepEqual(writer.claims, []);
			pipeline.noteFocus("page-a", true, true); await pipeline.settled;
			await pipeline.input("page-a", { generation: pipeline.generation, data: Buffer.from("intent").toString("base64") });
			assert.deepEqual(writer.writes, [{ data: "intent", frontendId: "page-a" }]);
			assert.deepEqual(writer.claims, [{ frontendId: "page-a", takeover: true }]);
		} finally { pipeline.dispose(); }
	});

	it("fences a delayed claim acknowledgement behind a newer owner event", async () => {
		const writer = createFakeWriter();
		const original = writer.claimInput;
		let resolve!: (owner: string | null) => void;
		writer.claimInput = () => new Promise<string | null>(done => { resolve = done; });
		const pipeline = await startedPipeline(writer);
		pipeline.register("page-a", collector().send);
		try {
			pipeline.notePanelVisible(true); pipeline.noteVisibility("page-a", true);
			await new Promise<void>(done => setImmediate(done));
			writer.emit({ kind: "input-owner", frontendId: "external" });
			resolve("page-a"); await pipeline.settled;
			await pipeline.input("page-a", { generation: pipeline.generation, data: Buffer.from("stale").toString("base64") });
			assert.deepEqual(writer.writes, []);
			writer.claimInput = original;
			pipeline.noteFocus("page-a", true, true); await pipeline.settled;
			await pipeline.input("page-a", { generation: pipeline.generation, data: Buffer.from("current").toString("base64") });
			assert.deepEqual(writer.writes, [{ data: "current", frontendId: "page-a" }]);
		} finally { writer.claimInput = original; pipeline.dispose(); }
	});

	it("rejects predecessor input when rebuilt over the same broker", async () => {
		const writer = createFakeWriter();
		const old = await startedPipeline(writer);
		const oldGeneration = old.generation;
		writer.emit({ kind: "output", seq: 1, data: "old output" });
		old.dispose();
		const current = await startedPipeline(writer);
		current.register("page-a", collector().send);
		try {
			current.notePanelVisible(true); current.noteVisibility("page-a", true); await current.settled;
			await current.input("page-a", { generation: oldGeneration, data: Buffer.from("old input").toString("base64") });
			await current.input("page-a", { generation: current.generation, data: Buffer.from("current input").toString("base64") });
			assert.deepEqual(writer.writes, [{ data: "current input", frontendId: "page-a" }]);
		} finally { current.dispose(); }
	});
});

describe("TerminalPipeline attach and seen", () => {
	it("retains post-capture output while a screen reply is in flight without pausing other panes", async () => {
		const writer = createFakeWriter();
		writer.setStatus({ seq: 5 });
		writer.snapshot = async () => ({ seq: 5, cols: 80, rows: 24, alt: false, truncated: false, data: "ready" });
		const pipeline = await startedPipeline(writer);
		const live = screenConsumer();
		const joining = screenConsumer();
		pipeline.register("live", live.send);
		pipeline.register("joining", joining.send);
		let captured!: () => void;
		const capture = new Promise<void>(resolve => { captured = resolve; });
		let reply!: (value: TerminalWriterSnapshot) => void;
		try {
			await pipeline.attach("live", { generation: null, cols: 80, rows: 24 });
			writer.snapshot = async () => {
				writer.emit({ kind: "output", seq: 5, data: "covered" });
				captured();
				return new Promise<TerminalWriterSnapshot>(resolve => { reply = resolve; });
			};
			const attach = pipeline.attach("joining", { generation: null, cols: 80, rows: 24 });
			await capture;
			const after = "α🙂".repeat(20_000);
			writer.emit({ kind: "output", seq: 12, data: after });
			assert.equal(live.screen, `readycovered${after}`, "a joining pane must not pause the existing consumer");
			reply({ seq: 12, cols: 80, rows: 24, alt: false, truncated: false, data: "readycovered" });
			await attach;
			assert.equal(joining.screen, live.screen, "post-capture frames must follow the exact snapshot cut");
			assert.equal(joining.resets, 1);
			assert.equal(joining.repairs, 0);
			assert.equal(joining.state.seq, live.state.seq);
			const before = joining.screen;
			await pipeline.probe("joining", { generation: pipeline.generation, seq: joining.state.seq });
			assert.equal(joining.screen, before);
			assert.equal(joining.resets, 1, "a healthy probe preserves the retained screen");
		} finally { pipeline.dispose(); }
	});

	it("answers an attach with the real generation, a state and an exact snapshot", async () => {
		const writer = createFakeWriter();
		const pipeline = await startedPipeline(writer);
		const page = collector();
		pipeline.register("page-a", page.send);
		try {
			await pipeline.attach("page-a", { generation: "f".repeat(32), cols: 120, rows: 40 });
			const state = page.messages.find(message => message.type === "omp:terminal-state");
			assert.ok(state !== undefined && state.type === "omp:terminal-state");
			assert.equal(state.generation, pipeline.generation, "the page is told which presentation actually exists");
			assert.equal(state.phase, "attached");
			assert.equal(state.snapshot, "follows");
			assert.equal(state.sessionLabel, "C:\\work");
			const snapshots = page.messages.filter(message => message.type === "omp:terminal-snapshot");
			assert.equal(snapshots.length, 1);
			assert.equal(decoded(snapshots[0]!), "\u001b[2Jready");
		} finally {
			pipeline.dispose();
		}
	});

	it("answers an attach to a stopped writer with no snapshot", async () => {
		const writer = createFakeWriter();
		writer.setStatus({ state: "exited", exitCode: 3 });
		const pipeline = await startedPipeline(writer);
		const page = collector();
		pipeline.register("page-a", page.send);
		try {
			await pipeline.attach("page-a", { generation: null, cols: 80, rows: 24 });
			assert.deepEqual(
				page.messages.filter(message => message.type === "omp:terminal-snapshot"),
				[],
			);
			const state = page.messages.find(message => message.type === "omp:terminal-state");
			assert.equal(state?.type === "omp:terminal-state" ? state.phase : null, "stopped");
			assert.equal(state?.type === "omp:terminal-state" ? state.input : null, false);
		} finally {
			pipeline.dispose();
		}
	});

	it("stops a read-only pane from typing, resizing or holding the broker's input slot", async () => {
		const writer = createFakeWriter();
		const pipeline = await startedPipeline(writer);
		const page = collector();
		pipeline.register("page-a", page.send);
		try {
			pipeline.notePanelVisible(true);
			pipeline.noteVisibility("page-a", true);
			pipeline.noteFocus("page-a", true);
			await pipeline.settled;
			assert.deepEqual(writer.claims, [{ frontendId: "page-a", takeover: false }]);

			// The tab becomes non-controlling: the broker's input slot is released, not
			// handed over, and the pane says why.
			pipeline.noteReadOnly("Another window or writer already holds this session.");
			await pipeline.settled;
			assert.deepEqual(writer.releases, ["page-a"]);
			assert.equal(pipeline.inputOwner, null);
			const state = page.messages.filter(message => message.type === "omp:terminal-state").at(-1);
			assert.equal(state?.input, false);
			assert.match(String(state?.reason), /already holds this session/);

			await pipeline.input("page-a", { generation: pipeline.generation, data: Buffer.from("x").toString("base64") });
			await pipeline.resize("page-a", { generation: pipeline.generation, cols: 100, rows: 30 });
			assert.deepEqual(writer.writes, []);
			assert.deepEqual(writer.resizes, []);

			// Output keeps flowing so the screen stays readable.
			writer.emit({ kind: "output", seq: 1, data: "still readable" });
			assert.deepEqual(
				page.messages.filter(message => message.type === "omp:terminal-data").map(decoded),
				["still readable"],
			);

			// Restoring it is what re-claims input — never an automatic takeover.
			pipeline.noteReadOnly(null);
			await pipeline.settled;
			assert.deepEqual(writer.claims.at(-1), { frontendId: "page-a", takeover: false });
		} finally {
			pipeline.dispose();
		}
	});

	it("publishes a temporary authority fence even when queued ownership work keeps the same owner", async () => {
		const writer = createFakeWriter();
		const pipeline = await startedPipeline(writer);
		const page = collector();
		pipeline.register("page-a", page.send);
		try {
			pipeline.notePanelVisible(true);
			pipeline.noteVisibility("page-a", true);
			await pipeline.settled;
			assert.equal(pipeline.inputOwner, "page-a");
			const before = page.messages.length;

			pipeline.noteReadOnly("The editor's authority is being reconciled.");
			const fenced = page.messages.filter(message => message.type === "omp:terminal-state").at(-1);
			assert.equal(fenced?.input, false, "the page loses permission before broker work can run");
			const refusedResize = pipeline.resize("page-a", { generation: pipeline.generation, cols: 120, rows: 40 });
			assert.deepEqual(writer.resizes, [], "the temporary fence still refuses grid writes");

			pipeline.noteReadOnly(null);
			const states = page.messages.slice(before).filter(message => message.type === "omp:terminal-state");
			assert.deepEqual(states.map(message => message.input), [false, true]);
			await refusedResize;
			await pipeline.settled;
			assert.equal(pipeline.inputOwner, "page-a");
			assert.deepEqual(writer.releases, [], "the fence lifted before ownership work needed to release input");
			await pipeline.resize("page-a", { generation: pipeline.generation, cols: 120, rows: 40 });
			assert.deepEqual(writer.resizes, [{ cols: 120, rows: 40, frontendId: "page-a" }]);
		} finally {
			pipeline.dispose();
		}
	});


	it("starts fenced when constructed with an authority, even though its pane is the visible owner", async () => {
		// The role is known before this pipeline exists (a restored non-controlling editor,
		// or one rebuilt for a newcomer after a settled switch), so the fence has to come
		// from construction.
		const writer = createFakeWriter();
		const pipeline = new TerminalPipeline({ writer, label: "C:\\work", authority: "Another writer already holds this session." });
		const page = collector();
		pipeline.register("page-a", page.send);
		try {
			await pipeline.start();
			pipeline.notePanelVisible(true);
			pipeline.noteVisibility("page-a", true);
			pipeline.noteFocus("page-a", true);
			await pipeline.settled;
			// Displaying the terminal, focused and visible — and still never the owner.
			assert.deepEqual(writer.claims, [], "a fenced pipeline must not claim the broker's input slot");
			assert.equal(pipeline.inputOwner, null);

			// A forged keystroke and resize from the page reach nothing.
			await pipeline.input("page-a", { generation: pipeline.generation, data: Buffer.from("typed").toString("base64") });
			await pipeline.resize("page-a", { generation: pipeline.generation, cols: 120, rows: 40 });
			assert.deepEqual(writer.writes, [], "a fenced pane must not reach the writer");
			assert.deepEqual(writer.resizes, []);

			// The screen stays readable and copyable: attach is answered from a snapshot.
			await pipeline.attach("page-a", { generation: null, cols: 90, rows: 30 });
			assert.equal(page.messages.filter(message => message.type === "omp:terminal-snapshot").length, 1);
			const state = page.messages.filter(message => message.type === "omp:terminal-state").at(-1);
			assert.equal(state?.input, false);
			assert.match(String(state?.reason), /already holds this session/);
			writer.emit({ kind: "output", seq: 1, data: "still readable" });
			assert.deepEqual(
				page.messages.filter(message => message.type === "omp:terminal-data").map(decoded),
				["still readable"],
			);
		} finally {
			pipeline.dispose();
		}
	});

	it("re-enables input only when the authority is lifted, and never for a stale generation", async () => {
		const writer = createFakeWriter();
		const pipeline = new TerminalPipeline({ writer, label: "C:\\work", authority: "not controlling" });
		const page = collector();
		pipeline.register("page-a", page.send);
		try {
			await pipeline.start();
			pipeline.notePanelVisible(true);
			pipeline.noteVisibility("page-a", true);
			pipeline.noteFocus("page-a", true);
			await pipeline.settled;
			// The fence lifts only by clearing the reason, and only then is input claimed.
			pipeline.noteReadOnly(null);
			await pipeline.settled;
			assert.deepEqual(writer.claims.at(-1), { frontendId: "page-a", takeover: false });
			assert.equal(pipeline.inputOwner, "page-a");

			await pipeline.input("page-a", { generation: "0".repeat(32), data: Buffer.from("stale").toString("base64") });
			assert.deepEqual(writer.writes, [], "a stale generation still cannot write after promotion");
			await pipeline.input("page-a", { generation: pipeline.generation, data: Buffer.from("live").toString("base64") });
			assert.deepEqual(writer.writes, [{ data: "live", frontendId: "page-a" }]);
		} finally {
			pipeline.dispose();
		}
	});
	it("marks an answer seen only from the visible focused owner", async () => {
		const writer = createFakeWriter();
		const seen: string[] = [];
		const pipeline = await startedPipeline(writer, () => seen.push("seen"));
		pipeline.register("page-a", collector().send);
		pipeline.register("page-b", collector().send);
		try {
			// A pane that is neither the owner nor visible reports nothing.
			pipeline.seen("page-a", { generation: pipeline.generation, outcome: "stop" });
			assert.deepEqual(seen, []);

			pipeline.notePanelVisible(true);
			pipeline.noteVisibility("page-a", true);
			pipeline.noteFocus("page-a", true);
			await pipeline.settled;

			pipeline.seen("page-b", { generation: pipeline.generation, outcome: "stop" });
			pipeline.seen("page-a", { generation: "f".repeat(32), outcome: "stop" });
			assert.deepEqual(seen, [], "a passive pane or a stale generation must not mark an answer seen");

			pipeline.seen("page-a", { generation: pipeline.generation, outcome: "stop" });
			assert.deepEqual(seen, ["seen"]);

			// Losing visibility stops the same page from marking anything seen.
			pipeline.noteVisibility("page-a", false);
			await pipeline.settled;
			pipeline.seen("page-a", { generation: pipeline.generation, outcome: "stop" });
			assert.deepEqual(seen, ["seen"]);
		} finally {
			pipeline.dispose();
		}
	});
});

describe("fitTerminalSnapshot", () => {
	const limit = 2_000;
	const screen = (count: number) => Array.from({ length: count }, (_unused, line) => `row ${line} ${"x".repeat(40)}`).join("\r\n");

	it("returns a snapshot that already fits untouched", () => {
		assert.equal(fitTerminalSnapshot("one screen", 24, limit)?.toString("utf8"), "one screen");
	});

	it("drops whole oldest lines, resets attributes at the cut and never cuts the visible rows", () => {
		const data = `${screen(200)}\u001b[5;3H`;
		const fitted = fitTerminalSnapshot(data, 10, limit)!;
		const text = fitted.toString("utf8");
		assert.ok(fitted.length <= limit);
		assert.ok(text.startsWith("\u001b[0mrow "), "starts at a line boundary after an attribute reset");
		assert.ok(text.endsWith("row 199 " + "x".repeat(40) + "\u001b[5;3H"), "the newest lines and the cursor are kept");
		assert.ok(text.split("\r\n").length >= 10, "at least the visible rows remain");
		assert.ok(data.endsWith(text.slice("\u001b[0m".length)), "what remains is an exact tail of the original");
	});

	it("drops no more than the limit forces", () => {
		const fitted = fitTerminalSnapshot(screen(200), 10, limit)!;
		assert.ok(limit - fitted.length < 60, "less than one more line would have fit");
	});

	it("keeps the alternate screen whole and trims only what precedes it", () => {
		const alternate = `\u001b[?1049h\u001b[H${"alt ".repeat(50)}`;
		const fitted = fitTerminalSnapshot(`${screen(200)}\r\nprompt${alternate}`, 10, 2_400)!.toString("utf8");
		assert.ok(fitted.endsWith(alternate));
		assert.ok(fitted.length <= 2_400);
	});

	it("gives up only when the visible screen alone is too large", () => {
		assert.equal(fitTerminalSnapshot(screen(30), 24, 500), null);
		assert.equal(fitTerminalSnapshot("no line breaks at all ".repeat(200), 24, 500), null);
	});

	it("keeps the cursor on the row it was on: a trimmed real mirror screen restores to the same cells", async () => {
		const cols = 60;
		const rows = 12;
		const mirror = new PtyScreenModel({ cols, rows });
		try {
			// Long wrapped history, then a TUI-shaped bottom: a prompt box whose cursor is parked on
			// the prompt row, one row above the footer, as OMP leaves it.
			for (let line = 0; line < 400; line++) mirror.write(`history ${line} \u001b[1;3${line % 7}m${"w".repeat(line % 90)}\u001b[0m\r\n`);
			mirror.write("\u001b[2J\u001b[H");
			for (let row = 0; row < rows - 1; row++) mirror.write(`screen row ${row}\r\n`);
			mirror.write(`footer ${"=".repeat(20)}\u001b[${rows - 2};5H`);
			const snapshot = await mirror.snapshot();
			assert.ok(snapshot.data.length > 4_000, "the fixture is a long screen");
			const fitted = fitTerminalSnapshot(snapshot.data, snapshot.rows, 1_500)!;
			assert.ok(fitted.length <= 1_500 && fitted.length < snapshot.data.length, "it really was trimmed");
			const whole = new headless.Terminal({ cols, rows, scrollback: 5_000, allowProposedApi: true });
			const trimmed = new headless.Terminal({ cols, rows, scrollback: 5_000, allowProposedApi: true });
			try {
				await new Promise<void>(resolve => whole.write(snapshot.data, resolve));
				await new Promise<void>(resolve => trimmed.write(fitted.toString("utf8"), resolve));
				const visible = (terminal: typeof whole) => {
					const buffer = terminal.buffer.active;
					return Array.from({ length: rows }, (_unused, row) => buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? "");
				};
				assert.equal(trimmed.buffer.active.cursorY, whole.buffer.active.cursorY, "the cursor row survives the cut");
				assert.equal(trimmed.buffer.active.cursorX, whole.buffer.active.cursorX, "the cursor column survives the cut");
				assert.equal(trimmed.buffer.active.cursorY, rows - 3, "and it is the row the program parked it on (CUP row rows-2, one-based)");
				assert.deepEqual(visible(trimmed), visible(whole), "every visible row is the same cells");
			} finally {
				whole.dispose();
				trimmed.dispose();
			}
		} finally {
			mirror.dispose();
		}
	});

	it("restores the cursor to its column when the last row fills the width (pending wrap)", async () => {
		const cols = 40;
		const rows = 8;
		const mirror = new PtyScreenModel({ cols, rows });
		const replay = new headless.Terminal({ cols, rows, scrollback: 100, allowProposedApi: true });
		try {
			// OMP's shape: a prompt row whose cursor sits after the two-cell prefix, and a full-width footer below it.
			mirror.write("\u001b[2J\u001b[H");
			for (let row = 0; row < rows - 3; row++) mirror.write(`body ${row}\r\n`);
			mirror.write(`${"─".repeat(cols)}\r\n❯ \r\n${"─".repeat(cols - 1)}\r\n\u001b[48;5;236m${" ".repeat(cols)}\u001b[0m`);
			mirror.write(`\u001b[${rows - 2};3H`);
			const snapshot = await mirror.snapshot();
			const cursor = { x: snapshot.cursorX, y: snapshot.cursorY, cols };
			assert.deepEqual([cursor.x, cursor.y], [2, rows - 3], "the mirror has the cursor after the prompt's two cells");
			const landed = async (data: string): Promise<[number, number]> => {
				replay.reset();
				await new Promise<void>(resolve => replay.write(data, resolve));
				return [replay.buffer.active.cursorX, replay.buffer.active.cursorY];
			};
			assert.deepEqual(await landed(snapshot.data), [1, rows - 3], "the serializer's own relative move lands one column short after a full-width row");
			assert.deepEqual(await landed(placeSnapshotCursor(snapshot.data, cursor)), [2, rows - 3], "the absolute move puts it where the program left it");
			assert.equal(placeSnapshotCursor("x", { x: cols, y: 0, cols }), "x\u001b[1;40H", "a pending-wrap column is the last column");
		} finally {
			mirror.dispose();
			replay.dispose();
		}
	});
});

describe("TerminalPipeline redraw after restore", () => {
	async function redrawing(writer: FakeWriter, redrawAfterRestore = true): Promise<TerminalPipeline> {
		const pipeline = new TerminalPipeline({ writer, label: "C:\\work", authority: null, redrawAfterRestore });
		await pipeline.start();
		return pipeline;
	}
	async function makeOwner(pipeline: TerminalPipeline, id = "page-a"): Promise<void> {
		pipeline.notePanelVisible(true);
		pipeline.noteVisibility(id, true);
		pipeline.noteFocus(id, true);
		await pipeline.settled;
	}
	const nudge = (frontendId: string, cols = 80, rows = 24) => [
		{ cols: cols - 1, rows, frontendId },
		{ cols, rows, frontendId },
	];

	it("repaints exactly once per reattach of the owning page: one column narrower and back", async () => {
		const writer = createFakeWriter();
		const pipeline = await redrawing(writer);
		const page = collector();
		pipeline.register("page-a", page.send);
		try {
			await makeOwner(pipeline);
			assert.deepEqual(writer.resizes, [], "owning a terminal alone is not a repaint");
			await pipeline.attach("page-a", { generation: null, cols: 80, rows: 24 });
			await pipeline.settled;
			assert.ok(page.messages.some(message => message.type === "omp:terminal-snapshot"));
			assert.deepEqual(writer.resizes, nudge("page-a"));
			await pipeline.settled;
			assert.equal(writer.resizes.length, 2, "nothing else asks for a second repaint");
			await pipeline.attach("page-a", { generation: pipeline.generation, cols: 80, rows: 24 });
			await pipeline.settled;
			assert.deepEqual(writer.resizes, [...nudge("page-a"), ...nudge("page-a")], "a second restore is a second repaint, and no more");
		} finally { pipeline.dispose(); }
	});

	it("sends the repaint after the restored screen, never before it", async () => {
		const writer = createFakeWriter();
		const order: string[] = [];
		const resize = writer.resize.bind(writer);
		writer.resize = async (cols, rows, frontendId) => { order.push(`resize ${cols}`); await resize(cols, rows, frontendId); };
		const pipeline = await redrawing(writer);
		pipeline.register("page-a", message => order.push(message.type));
		try {
			await makeOwner(pipeline);
			order.length = 0;
			await pipeline.attach("page-a", { generation: null, cols: 80, rows: 24 });
			await pipeline.settled;
			assert.ok(order.indexOf("omp:terminal-snapshot") >= 0);
			assert.ok(order.indexOf("omp:terminal-snapshot") < order.indexOf("resize 79"));
		} finally { pipeline.dispose(); }
	});

	it("waits for a hidden page to become the owner, then repaints once", async () => {
		const writer = createFakeWriter();
		const pipeline = await redrawing(writer);
		pipeline.register("page-a", collector().send);
		try {
			await pipeline.attach("page-a", { generation: null, cols: 80, rows: 24 });
			await pipeline.settled;
			assert.deepEqual(writer.resizes, [], "a page nobody sees is never resized");
			await makeOwner(pipeline);
			await pipeline.settled;
			assert.deepEqual(writer.resizes, nudge("page-a"));
		} finally { pipeline.dispose(); }
	});

	it("never resizes the program to the fit a page named when it attached", async () => {
		// The fit measured while an editor is still being laid out is a row or two off the
		// settled one; the page states its settled fit with its own resize.
		const writer = createFakeWriter();
		const pipeline = await redrawing(writer);
		pipeline.register("page-a", collector().send);
		try {
			await makeOwner(pipeline);
			await pipeline.attach("page-a", { generation: null, cols: 100, rows: 30 });
			await pipeline.settled;
			assert.deepEqual(writer.resizes, nudge("page-a"), "the repaint works on the grid the broker has");
		} finally { pipeline.dispose(); }
	});

	it("keeps a page's resize that arrives in the middle of a repaint", async () => {
		const writer = createFakeWriter();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const resize = writer.resize.bind(writer);
		let gated = false;
		writer.resize = async (cols, rows, frontendId) => {
			if (!gated) {
				gated = true;
				entered.resolve();
				await release.promise;
			}
			await resize(cols, rows, frontendId);
		};
		const pipeline = await redrawing(writer);
		pipeline.register("page-a", collector().send);
		try {
			await makeOwner(pipeline);
			await pipeline.attach("page-a", { generation: null, cols: 80, rows: 24 });
			await entered.promise;
			const moved = pipeline.resize("page-a", { generation: pipeline.generation, cols: 100, rows: 30 });
			release.resolve();
			await pipeline.settled;
			await moved;
			assert.deepEqual(writer.resizes, [...nudge("page-a"), { cols: 100, rows: 30, frontendId: "page-a" }], "the page's grid is the last one the program is given");
		} finally { pipeline.dispose(); }
	});

	it("sends nothing for a resize to the grid the program already has", async () => {
		const writer = createFakeWriter();
		const pipeline = await redrawing(writer);
		pipeline.register("page-a", collector().send);
		try {
			await makeOwner(pipeline);
			await pipeline.resize("page-a", { generation: pipeline.generation, cols: 80, rows: 24 });
			assert.deepEqual(writer.resizes, []);
			await pipeline.resize("page-a", { generation: pipeline.generation, cols: 100, rows: 30 });
			await pipeline.resize("page-a", { generation: pipeline.generation, cols: 100, rows: 30 });
			assert.deepEqual(writer.resizes, [{ cols: 100, rows: 30, frontendId: "page-a" }]);
		} finally { pipeline.dispose(); }
	});

	it("does nothing for a passive reader, a failed restore, or a pipeline that did not ask for it", async () => {
		const failing = createFakeWriter();
		failing.snapshot = async () => { throw new Error("unreadable"); };
		const failed = await redrawing(failing);
		failed.register("page-a", collector().send);
		const quiet = createFakeWriter();
		const shell = await redrawing(quiet, false);
		shell.register("page-a", collector().send);
		try {
			await makeOwner(failed);
			await failed.attach("page-a", { generation: null, cols: 80, rows: 24 });
			await failed.settled;
			assert.deepEqual(failing.resizes, [], "no screen was restored, so none is owed a repaint");
			await makeOwner(shell);
			await shell.attach("page-a", { generation: null, cols: 80, rows: 24 });
			await shell.settled;
			assert.deepEqual(quiet.resizes, [], "a shell is never nudged");
		} finally { failed.dispose(); shell.dispose(); }
	});

	it("repaints on demand for the visible owner: one nudge per request, nothing from nowhere", async () => {
		const writer = createFakeWriter();
		const pipeline = await redrawing(writer);
		pipeline.register("page-a", collector().send);
		try {
			await makeOwner(pipeline);
			await pipeline.attach("page-a", { generation: null, cols: 80, rows: 24 });
			await pipeline.settled;
			writer.resizes.length = 0;
			assert.equal(await pipeline.redrawNow(), true);
			assert.deepEqual(writer.resizes, nudge("page-a"));
			assert.equal(await pipeline.redrawNow(), true);
			assert.deepEqual(writer.resizes, [...nudge("page-a"), ...nudge("page-a")], "each request is one repaint");
		} finally { pipeline.dispose(); }
	});

	it("repaints at the page's current fit, not the grid it attached at", async () => {
		const writer = createFakeWriter();
		const pipeline = await redrawing(writer);
		pipeline.register("page-a", collector().send);
		try {
			await makeOwner(pipeline);
			await pipeline.attach("page-a", { generation: null, cols: 80, rows: 24 });
			await pipeline.settled;
			await pipeline.resize("page-a", { generation: pipeline.generation, cols: 100, rows: 30 });
			writer.resizes.length = 0;
			assert.equal(await pipeline.redrawNow(), true);
			assert.deepEqual(writer.resizes, nudge("page-a", 100, 30), "a stale attach-time grid must never shrink the PTY under the page's own fit");
		} finally { pipeline.dispose(); }
	});

	it("refuses an on-demand repaint it cannot honestly deliver: no owner, hidden panel, or a shell", async () => {
		const writer = createFakeWriter();
		const pipeline = await redrawing(writer);
		pipeline.register("page-a", collector().send);
		const quiet = createFakeWriter();
		const shell = await redrawing(quiet, false);
		shell.register("page-a", collector().send);
		try {
			assert.equal(await pipeline.redrawNow(), false, "no page owns the terminal yet");
			await makeOwner(pipeline);
			await pipeline.attach("page-a", { generation: null, cols: 80, rows: 24 });
			await pipeline.settled;
			writer.resizes.length = 0;
			pipeline.notePanelVisible(false);
			await pipeline.settled;
			assert.equal(await pipeline.redrawNow(), false, "a panel nobody sees is never resized");
			assert.deepEqual(writer.resizes, []);
			await makeOwner(shell);
			await shell.attach("page-a", { generation: null, cols: 80, rows: 24 });
			await shell.settled;
			assert.equal(await shell.redrawNow(), false, "a shell is never nudged");
			assert.deepEqual(quiet.resizes, []);
		} finally { pipeline.dispose(); shell.dispose(); }
	});
});

describe("TerminalPipeline host paste (Add Selection/File to Session)", () => {
	const REFERENCE = "@src/a.ts [lines 12-30]";
	const PASTE = `\u001b[200~ ${REFERENCE} \u001b[201~`;

	async function ownedPipeline(writer: FakeWriter): Promise<TerminalPipeline> {
		const pipeline = await startedPipeline(writer);
		pipeline.register("page-a", collector().send);
		pipeline.notePanelVisible(true);
		pipeline.noteVisibility("page-a", true);
		pipeline.noteFocus("page-a", true);
		await pipeline.settled;
		return pipeline;
	}
	const output = (data: string): TerminalWriterEvent => ({ kind: "output", seq: 1, data });

	it("writes one bracketed paste as the input owner, with no Enter, once the program enabled the mode", async () => {
		const writer = createFakeWriter();
		const pipeline = await ownedPipeline(writer);
		try {
			writer.emit(output("\u001b[?25l\u001b[?2004h"));
			assert.equal(await pipeline.pasteText(REFERENCE), "pasted");
			assert.deepEqual(writer.writes, [{ data: PASTE, frontendId: "page-a" }]);
			// A carriage return or line feed would submit the prompt; neither is in what was written.
			assert.doesNotMatch(writer.writes[0]!.data, /[\r\n]/);
		} finally {
			pipeline.dispose();
		}
	});

	it("does not paste while the program has not enabled bracketed paste, or has switched it off again", async () => {
		const writer = createFakeWriter();
		const pipeline = await ownedPipeline(writer);
		try {
			// The fake screen shows no 2004 mode: a shell prompt or a TUI that is still starting.
			assert.equal(await pipeline.pasteText(REFERENCE), "not-ready");
			writer.emit(output("\u001b[?2004h"));
			writer.emit(output("goodbye\u001b[?2004l"));
			assert.equal(await pipeline.pasteText(REFERENCE), "not-ready");
			assert.deepEqual(writer.writes, []);
		} finally {
			pipeline.dispose();
		}
	});

	it("learns the mode from the screen when the pipeline was created after the program started", async () => {
		const writer = createFakeWriter();
		writer.snapshot = async () => ({ seq: 0, cols: 80, rows: 24, alt: false, truncated: false, data: "\u001b[2Jprompt\u001b[?1;2004h" });
		const pipeline = await ownedPipeline(writer);
		try {
			assert.equal(await pipeline.pasteText(REFERENCE), "pasted");
			assert.equal(writer.writes[0]?.data, PASTE);
		} finally {
			pipeline.dispose();
		}
	});

	it("refuses text the TUI could not take as one small paste, and a pane that is not the visible owner", async () => {
		const writer = createFakeWriter();
		const pipeline = await startedPipeline(writer);
		pipeline.register("page-a", collector().send);
		try {
			writer.emit(output("\u001b[?2004h"));
			assert.equal(await pipeline.pasteText(REFERENCE), "not-owner", "no page owns input yet");
			pipeline.notePanelVisible(true);
			pipeline.noteVisibility("page-a", true);
			pipeline.noteFocus("page-a", true);
			await pipeline.settled;
			for (const bad of ["@a.ts\r", "@a.ts\n@b.ts", "@a.ts\u001b[201~ rm", "", "   ", `@${"x".repeat(900)}`]) {
				assert.equal(await pipeline.pasteText(bad), "refused", JSON.stringify(bad));
			}
			pipeline.notePanelVisible(false);
			await pipeline.settled;
			assert.equal(await pipeline.pasteText(REFERENCE), "not-owner", "a hidden pane never receives a paste");
			assert.deepEqual(writer.writes, []);
		} finally {
			pipeline.dispose();
		}
	});

	it("reads the screen once when the mode is unknown and remembers an 'off' answer, so a polling caller never serializes it again", async () => {
		const writer = createFakeWriter();
		let reads = 0;
		writer.snapshot = async () => {
			reads++;
			return { seq: 0, cols: 80, rows: 24, alt: false, truncated: false, data: "\u001b[2Jshell prompt" };
		};
		const pipeline = await ownedPipeline(writer);
		try {
			for (let poll = 0; poll < 5; poll++) assert.equal(await pipeline.pasteText(REFERENCE), "not-ready");
			assert.equal(reads, 1);
			// The program then enables the mode: live output wins over the remembered answer.
			writer.emit(output("\u001b[?2004h"));
			assert.equal(await pipeline.pasteText(REFERENCE), "pasted");
		} finally {
			pipeline.dispose();
		}
	});

	it("does not let a screen reading that finishes late overwrite a mode change that arrived while it ran", async () => {
		const writer = createFakeWriter();
		const release = Promise.withResolvers<void>();
		writer.snapshot = async () => {
			await release.promise;
			return { seq: 0, cols: 80, rows: 24, alt: false, truncated: false, data: "\u001b[2Jold\u001b[?2004h" };
		};
		const pipeline = await ownedPipeline(writer);
		try {
			const pending = pipeline.pasteText(REFERENCE);
			// The program switched the mode off while the screen was being read.
			writer.emit(output("\u001b[?2004l"));
			release.resolve();
			assert.equal(await pending, "not-ready");
			assert.deepEqual(writer.writes, []);
		} finally {
			pipeline.dispose();
		}
	});

	it("recognises a mode sequence that the output split across two chunks", async () => {
		const writer = createFakeWriter();
		const pipeline = await ownedPipeline(writer);
		try {
			writer.emit(output("welcome\u001b[?20"));
			writer.emit(output("04h ready"));
			assert.equal(await pipeline.pasteText(REFERENCE), "pasted");
		} finally {
			pipeline.dispose();
		}
	});
});

describe("TerminalPipeline exited broker retirement", () => {
	it("keeps the exited screen and state after broker shutdown and later page probes", async () => {
		const writer = createFakeWriter();
		const pipeline = await startedPipeline(writer);
		const page = screenConsumer();
		pipeline.register("page-a", page.send);
		try {
			await pipeline.attach("page-a", { generation: null, cols: 80, rows: 24 });
			writer.emit({ kind: "output", seq: 1, data: "final output" });
			writer.emit({ kind: "exit", seq: 2, code: 0, signal: null });
			const screen = page.screen;
			const resets = page.resets;
			writer.status = async () => { throw new Error("the broker has retired"); };
			writer.emit({ kind: "closed" });
			await pipeline.probe("page-a", { generation: pipeline.generation, seq: page.state.seq });
			assert.equal(page.state.phase, "stopped");
			assert.equal(page.screen, screen);
			assert.equal(page.resets, resets);
			assert.equal(pipeline.inputOwner, null);
		} finally {
			pipeline.dispose();
		}
	});

	it("also preserves an exit proved before the retained editor attached", async () => {
		const writer = createFakeWriter();
		writer.setStatus({ state: "exited", exitCode: 7 });
		const pipeline = await startedPipeline(writer);
		const page = screenConsumer();
		pipeline.register("page-a", page.send);
		try {
			writer.status = async () => { throw new Error("the broker has retired"); };
			writer.emit({ kind: "closed" });
			await pipeline.probe("page-a", { generation: pipeline.generation, seq: 0 });
			assert.equal(page.state.phase, "stopped");
		} finally {
			pipeline.dispose();
		}
	});

	it("still reports a connection failure when no child exit was proved", async () => {
		const writer = createFakeWriter();
		const pipeline = await startedPipeline(writer);
		const page = screenConsumer();
		pipeline.register("page-a", page.send);
		try {
			await pipeline.attach("page-a", { generation: null, cols: 80, rows: 24 });
			writer.emit({ kind: "closed" });
			assert.equal(page.state.phase, "unavailable");
		} finally {
			pipeline.dispose();
		}
	});
});

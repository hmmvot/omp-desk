/**
 * The broker's screen model: what the terminal looks like while nobody is
 * watching ([ADR-0024](../../docs/decisions/0024-own-omp-pty-for-in-tab-terminal.md)).
 *
 * The broker — not the editor, and not the Webview — owns the terminal state. Every
 * byte the PTY produces is fed into a headless xterm.js terminal and, at the same
 * time, appended to a bounded replay backlog with a monotonic position. That gives
 * the two answers a reconnecting frontend needs, and the difference between them is
 * the whole point of this module:
 *
 * - **an exact replay**: the retained byte stream from a position the frontend
 *   already had, re-parsed by the renderer's own parser, so it is exact by
 *   construction;
 * - **a serialization**: the *screen* itself, produced by xterm.js's own
 *   `SerializeAddon` from the headless buffer, for a frontend that has no prior
 *   state (first open, or a backlog that overflowed). It is exact because it is the
 *   same emulator that consumed the stream; it is not a hand-written ANSI dump.
 *
 * Positions are numbered in UTF-16 code units of output, so a chunk written at
 * `position = p` covers `[p, p + data.length)`. A snapshot is taken with the
 * position *read after* the parse queue has drained, which makes the pair
 * `(snapshot, position)` consistent: whatever the client replays from that position
 * was not yet on screen when the snapshot was taken.
 *
 * Everything is bounded: the headless scrollback, the replay
 * backlog and one snapshot's serialization each have a limit, and a snapshot that
 * had to drop older scrollback says so (`truncated`) instead of presenting a partial
 * screen as the whole one.
 */

import * as headlessModule from "@xterm/headless";
import * as serializeModule from "@xterm/addon-serialize";
import * as unicode11Module from "@xterm/addon-unicode11";

/**
 * The shape of a loaded CommonJS module that actually carries `member`.
 *
 * Both packages ship one self-contained CommonJS build, and the two loaders this code
 * runs under disagree about where its exports land: Node's ESM loader exposes them
 * directly, while esbuild's interop for a bundled CommonJS dependency can hand them over
 * under `default` — which is what a broker started from the bundle saw as `undefined` in
 * a measured run. Asking which shape carries the member covers both without a guess.
 */
function moduleCarrying<T extends object>(loaded: T, member: string): T {
	if (Reflect.get(loaded, member) !== undefined) return loaded;
	const wrapped: unknown = Reflect.get(loaded, "default");
	return wrapped !== null && typeof wrapped === "object" ? (wrapped as T) : loaded;
}

const headless = moduleCarrying(headlessModule, "Terminal");
const serialize = moduleCarrying(serializeModule, "SerializeAddon");
const unicode11 = moduleCarrying(unicode11Module, "Unicode11Addon");
import { activateTerminalUnicode } from "../webview/lib/terminal-unicode.ts";
import { PTY_DEFAULT_BACKLOG_CHARS, PTY_DEFAULT_SCROLLBACK_LINES, PTY_MAX_TITLE_CHARS } from "../host/pty-protocol.ts";

/** One sequenced piece of output: its first position and its text. */
export interface PtyScreenChunk {
	readonly fromPosition: number;
	readonly data: string;
}

/** One serialized screen, with the position it is consistent with. */
export interface PtyScreenSnapshot {
	readonly position: number;
	readonly data: string;
	readonly cols: number;
	readonly rows: number;
	readonly alt: boolean;
	readonly title: string | null;
	readonly cursorX: number;
	readonly cursorY: number;
	readonly cursorVisible: boolean;
	/** `true` when older scrollback was left out of this serialization. */
	readonly truncated: boolean;
	readonly chars: number;
}

/** The chunks retained for an exact replay from one position. */
export interface PtyReplay {
	readonly chunks: readonly PtyScreenChunk[];
	/** `true` when the backlog no longer holds everything after the request. */
	readonly truncated: boolean;
	readonly oldestPosition: number;
}

export interface PtyScreenOptions {
	readonly cols: number;
	readonly rows: number;
	/** Headless scrollback lines kept for the screen model. */
	readonly scrollbackLines?: number;
	/** UTF-16 code units of output kept for an exact replay. */
	readonly backlogChars?: number;
	/** Upper bound on one snapshot's serialized characters. */
	readonly snapshotChars?: number;
}

/** Default bound on one snapshot's serialized characters. */
export const PTY_DEFAULT_SNAPSHOT_CHARS = 1024 * 1024;

/**
 * One headless terminal plus its bounded replay backlog.
 *
 * Not thread-safe by design: the broker is single-threaded, and every mutation here
 * happens inside one of its callbacks, so a position read and the write that follows
 * it can never be interleaved by another actor.
 */
export class PtyScreenModel {
	private readonly terminal: headlessModule.Terminal;
	private readonly serializer: serializeModule.SerializeAddon;
	private readonly backlogChars: number;
	private readonly snapshotChars: number;
	private readonly outputListeners: Array<(chunk: PtyScreenChunk) => void> = [];
	private readonly chunks: PtyScreenChunk[] = [];
	/** Parse callbacks still outstanding; a snapshot waits for zero. */
	private pendingWrites = 0;
	private readonly drained: Array<() => void> = [];
	/** Characters currently retained by {@link chunks}, maintained incrementally. */
	private retained = 0;
	private positionValue = 0;
	private titleValue: string | null = null;
	private disposed = false;

	constructor(options: PtyScreenOptions) {
		this.backlogChars = Math.max(64 * 1024, options.backlogChars ?? PTY_DEFAULT_BACKLOG_CHARS);
		this.snapshotChars = Math.max(64 * 1024, options.snapshotChars ?? PTY_DEFAULT_SNAPSHOT_CHARS);
		this.terminal = new headless.Terminal({
			cols: options.cols,
			rows: options.rows,
			scrollback: Math.max(50, options.scrollbackLines ?? PTY_DEFAULT_SCROLLBACK_LINES),
			allowProposedApi: true,
		});
		this.serializer = new serialize.SerializeAddon();
		this.terminal.loadAddon(this.serializer);
		// The OMP TUI sizes characters with Unicode 11+ widths; the snapshot this mirror
		// serializes must place wide emoji and CJK exactly as the Webview's live parse does.
		activateTerminalUnicode(this.terminal, new unicode11.Unicode11Addon());
		this.terminal.onTitleChange(title => {
			// The title is the child's text, not this extension's: an unbounded one would
			// make every state frame too large for the peer's line reader and disconnect a
			// caller that did nothing wrong, so it is bounded where it is stored.
			this.titleValue = title.length === 0 ? null : title.slice(0, PTY_MAX_TITLE_CHARS);
		});
	}

	/** Position of the next character to arrive, i.e. total output so far. */
	get position(): number {
		return this.positionValue;
	}

	/** Oldest position still retained for an exact replay. */
	get oldestPosition(): number {
		const first = this.chunks[0];
		return first === undefined ? this.positionValue : first.fromPosition;
	}

	get cols(): number {
		return this.terminal.cols;
	}

	get rows(): number {
		return this.terminal.rows;
	}

	get alt(): boolean {
		return this.terminal.buffer.active.type === "alternate";
	}

	get title(): string | null {
		return this.titleValue;
	}

	onOutput(listener: (chunk: PtyScreenChunk) => void): () => void {
		this.outputListeners.push(listener);
		return () => {
			const index = this.outputListeners.indexOf(listener);
			if (index >= 0) this.outputListeners.splice(index, 1);
		};
	}

	/**
	 * Feed PTY output.
	 *
	 * The chunk's position is assigned before any listener sees it, so a listener
	 * that immediately asks for a replay from `chunk.fromPosition + data.length`
	 * receives exactly the bytes that follow, with no gap and no duplicate.
	 */
	write(data: string): void {
		if (this.disposed || data.length === 0) return;
		const fromPosition = this.positionValue;
		this.positionValue += data.length;
		this.pendingWrites += 1;
		this.terminal.write(data, () => {
			this.pendingWrites -= 1;
			if (this.pendingWrites === 0) {
				for (const resolve of this.drained.splice(0)) resolve();
			}
		});
		this.chunks.push({ fromPosition, data });
		this.retained += data.length;
		this.trimBacklog();
		const chunk: PtyScreenChunk = { fromPosition, data };
		for (const listener of this.outputListeners) listener(chunk);
	}

	resize(cols: number, rows: number): void {
		if (this.disposed) return;
		if (cols === this.terminal.cols && rows === this.terminal.rows) return;
		this.terminal.resize(cols, rows);
	}

	/** Everything retained after `since`, or an honest report that it is not all there. */
	backlogSince(since: number): PtyReplay {
		const oldestPosition = this.oldestPosition;
		const truncated = since < oldestPosition;
		const chunks: PtyScreenChunk[] = [];
		for (const chunk of this.chunks) {
			const end = chunk.fromPosition + chunk.data.length;
			if (end <= since) continue;
			if (chunk.fromPosition >= since) {
				chunks.push(chunk);
				continue;
			}
			// The first retained chunk can start before the request; the replay starts
			// exactly at the requested position so every frame's position is its own.
			chunks.push({ fromPosition: since, data: chunk.data.slice(since - chunk.fromPosition) });
		}
		return { chunks, truncated, oldestPosition };
	}

	/**
	 * Serialize the current screen.
	 *
	 * The position is read after every write issued so far has been parsed and before
	 * the serialization runs, in the same synchronous step, so the returned position
	 * describes exactly the screen that was serialized.
	 */
	async snapshot(): Promise<PtyScreenSnapshot> {
		await this.waitForParsedOutput();
		const position = this.positionValue;
		const cols = this.terminal.cols;
		const rows = this.terminal.rows;
		const buffer = this.terminal.buffer.active;
		// The line estimate is only a starting point: escape sequences mean a line count
		// says nothing about the serialized size, so the *result* is measured and the
		// scrollback is reduced until it fits the bound this snapshot promises.
		const available = this.scrollbackLines();
		let scrollback = Math.min(available, Math.max(0, Math.floor(this.snapshotChars / Math.max(1, cols + 2))));
		let data = this.serializer.serialize({ scrollback });
		let truncated = scrollback < available;
		while (data.length > this.snapshotChars && scrollback > 0) {
			scrollback = Math.floor(scrollback / 2);
			data = this.serializer.serialize({ scrollback });
			truncated = true;
		}
		if (data.length > this.snapshotChars) {
			// Even the viewport alone is above the bound. It is cut at a whole line, or at
			// a whole escape sequence when there is no line boundary, because half of one
			// would corrupt the renderer's state rather than shorten the screen.
			const head = data.slice(0, this.snapshotChars);
			let cut = head.lastIndexOf("\r\n");
			if (cut <= 0) cut = head.lastIndexOf("\u001b");
			if (cut <= 0) cut = head.length;
			data = `${head.slice(0, cut)}\u001b[0m`;
			truncated = true;
		}
		return {
			position,
			data,
			cols,
			rows,
			alt: buffer.type === "alternate",
			title: this.titleValue,
			cursorX: buffer.cursorX,
			cursorY: buffer.cursorY,
			cursorVisible: this.cursorVisible(),
			truncated,
			chars: data.length,
		};
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const resolve of this.drained.splice(0)) resolve();
		this.outputListeners.length = 0;
		this.terminal.dispose();
	}

	/** Scrollback lines the buffer is actually holding, for the truncation report. */
	private scrollbackLines(): number {
		const buffer = this.terminal.buffer.active;
		return Math.max(0, buffer.length - this.terminal.rows);
	}

	private cursorVisible(): boolean {
		// `modes` is proposed API on the headless terminal: read it defensively rather
		// than let a build that lacks it break a snapshot.
		const modes: unknown = Reflect.get(this.terminal, "modes");
		if (modes === null || typeof modes !== "object" || !("isCursorHidden" in modes)) return true;
		const hidden: unknown = modes.isCursorHidden;
		return hidden !== true;
	}

	private waitForParsedOutput(): Promise<void> {
		if (this.pendingWrites === 0) return Promise.resolve();
		const { promise, resolve } = Promise.withResolvers<void>();
		this.drained.push(resolve);
		return promise;
	}

	private trimBacklog(): void {
		while (this.retained > this.backlogChars && this.chunks.length > 1) {
			const dropped = this.chunks.shift();
			if (dropped === undefined) break;
			this.retained -= dropped.data.length;
		}
		// One chunk larger than the whole backlog is still retained: a replay from its
		// own start must be possible, and dropping it would leave a hole exactly where
		// a client is most likely to be.
	}
}

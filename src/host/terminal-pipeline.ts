/**
 * The host side of one editor's terminal pane (ADR-0024).
 *
 * One editor slot shows one document, and that document can present the chat or
 * the terminal. This module owns the terminal presentation: it is the only place
 * that decides which page may type into the live PTY, fans the exact output out
 * to every page that is watching, and turns the broker's own identity into the
 * bounded `omp:terminal-*` messages the bundled renderer consumes.
 *
 * Three rules it exists to keep:
 *
 * - **One input owner.** The broker's acknowledgement and owner events decide
 *   who may type and resize. Visibility and writer authority gate that ownership;
 *   browser focus only requests an explicit takeover and acknowledges seen turns.
 * - **Exact, dense output.** This pipeline sequences the bounded frames it emits,
 *   independently of broker output events, and repairs gaps with a screen snapshot.
 * - **A presentation generation.** Every pipeline has a fresh identity, so a
 *   rebuilt presentation never reuses a predecessor's dense sequence namespace.
 *
 * The port ({@link TerminalWriter}) is deliberately narrow: the extension-owned
 * PTY broker satisfies it through a small adapter, and the tests satisfy it with
 * an in-memory fake, so none of the fan-out, ownership or framing rules depend on
 * the native transport being present.
 */
import { randomBytes } from "node:crypto";
import { bracketedPaste } from "./editor-context.ts";


/** Shown in place of the earlier screen when it cannot be restored; new output still arrives, so nothing is lost from here on. */
const SNAPSHOT_READ_FAILED = "The earlier screen of this terminal could not be restored; new output will still appear.";
const SNAPSHOT_OUTPACED = "The earlier screen of this terminal could not be restored because output kept arriving; new output will still appear.";
const SNAPSHOT_TOO_LARGE = "The earlier screen of this terminal is too large to restore; new output will still appear.";
/** How many times one attach reads the screen again because output outran the first reading. */
const MAX_SNAPSHOT_ATTEMPTS = 3;
/** Enters the alternate screen; what precedes it is the primary screen and its scrollback. */
const ALTERNATE_SCREEN_ENTER = "\u001b[?1049h";
/** Resets the text attributes a dropped line may have left set. */
const RESET_ATTRIBUTES = "\u001b[0m";
/** Longer than any DECSET/DECRST sequence naming mode 2004 the TUI writes, so a split one is never missed. */
const MODE_TAIL_CHARS = 24;

/** The narrowest grid a size nudge may use; a one-column-narrower grid must stay a legal terminal. */
const REDRAW_MIN_COLS = 3;

/** DECSET/DECRST sequences, with the mode numbers they name. */
const PRIVATE_MODE_SEQUENCE = /\u001b\[\?([0-9;]*)([hl])/g;

/**
 * Whether the program enabled bracketed paste (DECSET 2004), given the output `data` it
 * just wrote: the last 2004 set or reset in it, or `previous` when it names none.
 *
 * The native TUI turns the mode on when it takes over the terminal and off when it gives
 * it back, so a pane may only be handed a bracketed paste while the program says it is
 * reading one. Anything else is raw typing that a shell prompt or a still-starting
 * program would interpret.
 */
export function scanBracketedPasteMode(data: string, previous: boolean | null): boolean | null {
	let mode = previous;
	for (const match of data.matchAll(PRIVATE_MODE_SEQUENCE)) {
		if ((match[1] ?? "").split(";").includes("2004")) mode = match[2] === "h";
	}
	return mode;
}

/** Why a host-initiated paste did not reach the program, or that it did. */
export type TerminalPasteOutcome = "pasted" | "refused" | "unavailable" | "not-owner" | "not-ready";

/** What a page may be shown about the writer. */
export type TerminalPhase = "attached" | "stopped" | "unavailable";
/** How a completion shown by the terminal pane ended. */
export type TerminalSeenOutcome = "stop" | "length" | "toolUse" | "error" | "aborted";

/**
 * Decoded budget of one `omp:terminal-data` message.
 *
 * The renderer accepts at most `floor(65536 / 3) * 4` base64 characters, and base64 of
 * `n` bytes is `4 * ceil(n / 3)` characters. A full 64 KiB chunk would be four
 * characters too long and be dropped by the page, so the bound is the largest whole
 * byte count that still fits.
 */
const MAX_DATA_BYTES = 65_535;
/** Decoded budget of one `omp:terminal-snapshot` message, by the same arithmetic. */
const MAX_SNAPSHOT_BYTES = 131_070;
/** Bounded display text carried by a state message. */
const MAX_LABEL_CHARS = 200;

/** One `omp:terminal-state` message, exactly as the renderer parses it. */
export interface TerminalStateMessage {
	readonly type: "omp:terminal-state";
	/** This presentation's generation: 32 lowercase hex characters. */
	readonly generation: string;
	/** Last dense renderer frame emitted before this state. */
	readonly seq: number;
	readonly phase: TerminalPhase;
	/** `true` only for the page that currently owns input and resize. */
	readonly input: boolean;
	readonly cols: number;
	readonly rows: number;
	/** Whether a replacement screen follows, failed, or was not requested. */
	readonly snapshot: "follows" | "failed" | "none";
	/** Bounded display label; a folder shell passes its folder path. */
	readonly sessionLabel?: string;
	readonly description?: string;
	/** Bounded display reason for a non-`attached` phase. */
	readonly reason?: string;
}

export interface TerminalDataMessage {
	readonly type: "omp:terminal-data";
	readonly generation: string;
	readonly seq: number;
	/** Base64 (RFC 4648, padded) of the exact UTF-8 bytes to write. */
	readonly bytes: string;
}

export interface TerminalSnapshotMessage {
	readonly type: "omp:terminal-snapshot";
	readonly generation: string;
	readonly seq: number;
	readonly bytes: string;
}

export interface TerminalExitMessage {
	readonly type: "omp:terminal-exit";
	readonly generation: string;
	readonly seq: number;
	readonly code: number | null;
	readonly signal: string | null;
}

/** Every message this module pushes to a terminal pane. */
export type TerminalHostMessage =
	| TerminalStateMessage
	| TerminalSnapshotMessage
	| TerminalDataMessage
	| TerminalExitMessage;

/** One inbound attach, after the page's own identity has been verified. */
export interface TerminalAttachRequest {
	/** The generation the page believes it has, or `null` on its first activation. */
	readonly generation: string | null;
	readonly cols: number;
	readonly rows: number;
}

export interface TerminalProbeRequest {
	readonly generation: string | null;
	/** Last dense output sequence consumed by the page. */
	readonly seq: number;
}

export interface TerminalInputRequest {
	readonly generation: string;
	/** Base64 of the exact bytes typed; never a decoded string. */
	readonly data: string;
}

export interface TerminalResizeRequest {
	readonly generation: string;
	readonly cols: number;
	readonly rows: number;
}

export interface TerminalSeenRequest {
	readonly generation: string | null;
	readonly outcome: TerminalSeenOutcome | null;
}

/** The writer's own reported state. */
export interface TerminalWriterStatus {
	readonly state: "running" | "exited";
	readonly exitCode: number | null;
	/** Signal name when the child was signalled, or `null`. */
	readonly signal: string | null;
	readonly cols: number;
	readonly rows: number;
	readonly alt: boolean;
	readonly title: string | null;
	/** Last output sequence handed out. */
	readonly seq: number;
	/** Oldest sequence still retained for an exact replay. */
	readonly oldestSeq: number;
	/** Broker-confirmed input owner, including frontends outside this host. */
	readonly inputOwner: string | null;
	/** Warnings that affect what a caller may claim; never a guess. */
	readonly notices: readonly string[];
}

export interface TerminalWriterSnapshot {
	readonly seq: number;
	readonly cols: number;
	readonly rows: number;
	readonly alt: boolean;
	/** `true` when the screen model could not be serialized in full. */
	readonly truncated: boolean;
	/** The exact escape sequences a renderer writes after `reset()`. */
	readonly data: string;
}

/** One writer event; output `seq` is its starting broker UTF-16 position. */
export type TerminalWriterEvent =
	| { readonly kind: "output"; readonly seq: number; readonly data: string }
	| { readonly kind: "exit"; readonly seq: number; readonly code: number | null; readonly signal: string | null }
	| { readonly kind: "input-owner"; readonly frontendId: string | null }
	| { readonly kind: "closed" };

/**
 * The narrow port this module needs from the extension-owned PTY broker.
 *
 * `write` and `resize` name the frontend that asked, so the broker can refuse a
 * caller that is no longer its input owner rather than applying a stale
 * keystroke to a live child.
 */
export interface TerminalWriter {
	/** OS process id of the child; used by the host's own evidence, never by a page. */
	readonly nativePid: number;
	readonly nativeCreationTime: string | null;
	status(): Promise<TerminalWriterStatus>;
	snapshot(): Promise<TerminalWriterSnapshot>;
	write(data: string, frontendId: string): Promise<void>;
	resize(cols: number, rows: number, frontendId: string): Promise<void>;
	claimInput(frontendId: string, takeover: boolean): Promise<string | null>;
	releaseInput(frontendId: string): Promise<void>;
	/** Watch live output and the child's exit. Retained history is read by snapshot. */
	watch(listener: (event: TerminalWriterEvent) => void): () => void;
}

export interface TerminalPipelineOptions {
	readonly writer: TerminalWriter;
	/** Display label for the pane; a fileless draft has none of its own. */
	readonly label?: string | null;
	readonly description?: string | null;
	/**
	 * A completion the *visible, focused* terminal pane displayed.
	 *
	 * This is deliberately narrower than "output arrived": a hidden pane never
	 * marks an answer seen, which is what keeps Answer Ready a comparison of what
	 * the user actually saw.
	 */
	readonly onSeen?: (outcome: TerminalSeenOutcome) => void;
	/**
	 * Why this pane may not drive its writer yet, or `null` when it may.
	 *
	 * Required, and applied before the first frame can be accepted: a pipeline that
	 * starts unfenced can take the broker input slot, so the authority is passed in at
	 * construction rather than learned later. That covers a role decided before the
	 * pipeline existed (a restored non-controlling editor) and a pipeline rebuilt for a
	 * non-controlling newcomer after a settled switch. `noteReadOnly(null)` is the only
	 * thing that lifts the fence.
	 */
	readonly authority: string | null;
	/**
	 * Make the program repaint its whole screen once after a screen was restored to the
	 * owning page (see {@link TerminalPipeline}). Only a full-screen TUI that redraws on a
	 * size change wants this; the native OMP session does, a shell must never get it.
	 */
	readonly redrawAfterRestore?: boolean;
}

interface SnapshotBuffer {
	initialSeq: number;
	/** Broker UTF-16 positions locate the exact screen cut in dense renderer frames. */
	readonly output: { readonly message: TerminalDataMessage; readonly position: number; readonly data: string }[];
	bytes: number;
	overflow: boolean;
	stateChanged: boolean;
}

interface Frontend {
	readonly id: string;
	readonly send: (message: TerminalHostMessage) => void;
	focused: boolean;
	visible: boolean;
	attachRevision: number;
	snapshot: SnapshotBuffer | null;
	/** A screen was restored into this page and OMP has not repainted since. */
	redrawOwed: boolean;
}

/** Split text into UTF-8-encoded chunks of at most `limit` bytes, never mid-character. */
export function chunkTerminalText(data: string, limit = MAX_DATA_BYTES): string[] {
	if (data.length === 0) return [];
	const chunks: string[] = [];
	let start = 0;
	let bytes = 0;
	for (let index = 0; index < data.length; ) {
		const code = data.codePointAt(index) ?? 0;
		const width = code > 0xffff ? 2 : 1;
		const size = Buffer.byteLength(data.slice(index, index + width), "utf8");
		if (bytes + size > limit && index > start) {
			chunks.push(data.slice(start, index));
			start = index;
			bytes = 0;
		}
		bytes += size;
		index += width;
	}
	if (start < data.length) chunks.push(data.slice(start));
	return chunks;
}

/**
 * A serialized screen ending with the cursor placed absolutely, whatever the serializer did.
 *
 * `SerializeAddon` returns the cursor to its place with relative moves counted from where
 * it believes the last row ended. A last row that fills the whole width (OMP's footer
 * does) leaves the renderer's cursor in the pending-wrap state, and xterm.js's
 * cursor-backward from that state first steps onto the last column, so the cursor lands
 * one column left of where the serializer meant and stays there until the program next
 * moves it. The mirror knows the real position, so it is stated as an absolute move after
 * everything the serializer wrote. A pending-wrap column (`cols`) is clamped to the last one.
 */
export function placeSnapshotCursor(data: string, cursor: { readonly x: number; readonly y: number; readonly cols: number }): string {
	const column = Math.min(Math.max(0, cursor.x), Math.max(0, cursor.cols - 1));
	return `${data}\u001b[${Math.max(0, cursor.y) + 1};${column + 1}H`;
}

/**
 * The bytes of one screen snapshot, cut to fit one `omp:terminal-snapshot` message.
 *
 * The broker serializes up to about a million characters of screen and scrollback, so a
 * long session's retained scrollback routinely exceeds the one message a page accepts.
 * Failing the attach for that would leave the pane blank exactly when there is the most
 * to show, so the oldest scrollback is dropped instead, whole lines at a time, until the
 * rest fits. The last `rows` lines (the visible screen, and everything after them:
 * cursor and modes) are never cut, and when the snapshot enters the alternate screen
 * only what precedes it is trimmed. The attributes a dropped line left set are reset at
 * the cut.
 *
 * Returns `null` when even the visible screen alone does not fit.
 */
export function fitTerminalSnapshot(data: string, rows: number, limit = MAX_SNAPSHOT_BYTES): Buffer | null {
	const whole = Buffer.from(data, "utf8");
	if (whole.length <= limit) return whole;
	const alternateAt = data.indexOf(ALTERNATE_SCREEN_ENTER);
	const scrollEnd = alternateAt < 0 ? data.length : alternateAt;
	const cuts: number[] = [];
	for (let at = data.indexOf("\r\n"); at >= 0 && at < scrollEnd; at = data.indexOf("\r\n", at + 2)) cuts.push(at + 2);
	const lastCut = cuts.length - Math.max(1, rows);
	if (lastCut < 0) return null;
	const fitted = (cut: number): Buffer => Buffer.from(RESET_ATTRIBUTES + data.slice(cuts[cut]), "utf8");
	if (fitted(lastCut).length > limit) return null;
	let low = 0;
	let high = lastCut;
	while (low < high) {
		const middle = (low + high) >> 1;
		if (fitted(middle).length <= limit) high = middle;
		else low = middle + 1;
	}
	return fitted(low);
}

/**
 * The live terminal presentation of one editor slot.
 *
 * Construction starts watching the writer, so output that arrives while no page
 * is attached is retained by the broker and replayed on the next attach rather
 * than dropped here.
 */
export class TerminalPipeline {
	readonly #writer: TerminalWriter;
	readonly #generation = randomBytes(16).toString("hex");
	readonly #label: string | null;
	#description: string | null;
	readonly #onSeen: ((outcome: TerminalSeenOutcome) => void) | undefined;
	readonly #frontends = new Map<string, Frontend>();
	#ownerId: string | null = null;
	/** Fences claim/status replies against later authoritative owner events. */
	#ownerRevision = 0;
	#panelVisible = false;
	/**
	 * Why this pane is read-only, or `null`.
	 *
	 * A conflicting, non-controlling editor may still render the terminal — the user
	 * must be able to read and copy what is on screen — but it may not type into it,
	 * resize it, or take the broker's input slot, because another writer owns that
	 * session. The reason is shown instead of being hidden.
	 */
	#readOnlyReason: string | null = null;
	#phase: TerminalPhase = "attached";
	#reason: string | null = null;
	#cols: number;
	#rows: number;
	/** Last writer sequence this host saw; used only to report the writer's own state. */
	#seq = 0;
	/**
	 * The renderer's own dense sequence, incremented once per data message.
	 *
	 * The renderer requires `previous + 1` and a positive integer for every frame. The
	 * broker's sequence counts its own output events, which this host may split into
	 * several frames, so the two are deliberately different counters and only this one
	 * travels in `omp:terminal-*`. It starts at 1 because a state or a snapshot is sent
	 * before any live data can arrive, and the page would refuse a sequence of zero.
	 */
	#lastSeq = 1;
	#oldestSeq = 0;
	#lastAlt = false;
	#lastTitle: string | null = null;
	#exit: { readonly code: number | null; readonly signal: string | null } | null = null;
	#disposed = false;
	/** Whether the program enabled bracketed paste (DECSET 2004); `null` until its output has said. */
	#bracketedPaste: boolean | null = null;
	/** The last characters of earlier output, so a mode sequence split across two events is still read. */
	#modeTail = "";
	#stopWatching: () => void;
	/** The serialized ownership reconciliations; see {@link settled}. */
	#ownership: Promise<void> = Promise.resolve();
	/** The serialized grid writes (page resizes and repaint nudges); see {@link resize}. */
	#grid: Promise<void> = Promise.resolve();
	readonly #redrawAfterRestore: boolean;

	constructor(options: TerminalPipelineOptions) {
		this.#writer = options.writer;
		this.#label = boundedLabel(options.label ?? null);
		this.#description = boundedLabel(options.description ?? null);
		this.#onSeen = options.onSeen;
		this.#redrawAfterRestore = options.redrawAfterRestore === true;
		// Seeded before any frame can be accepted, and before registration or start can
		// schedule an ownership reconciliation: an unfenced pipeline would be able to claim
		// the broker input slot for a session another writer owns.
		this.#readOnlyReason = boundedLabel(options.authority);
		this.#cols = 80;
		this.#rows = 24;
		// Live output only: a page that reconnects is answered from an exact screen
		// snapshot rather than a replayed byte stream, so nothing here has to
		// reconstruct history the broker still retains.
		this.#stopWatching = this.#writer.watch(event => this.#onWriterEvent(event));
	}

	/** This presentation's generation, as every emitted frame names it. */
	get generation(): string {
		return this.#generation;
	}

	get phase(): TerminalPhase {
		return this.#phase;
	}

	/** Update display-only metadata without changing terminal ownership. */
	noteDescription(description: string): void {
		if (this.#description === description) return;
		this.#description = boundedLabel(description);
		this.#broadcastState();
	}

	get inputOwner(): string | null {
		return this.#ownerId;
	}

	/**
	 * Adopt the writer's own current facts.
	 *
	 * Called once before any page can attach: the broker knows the real grid and the
	 * last sequence number it handed out, so a reconnect never has to guess either.
	 */
	async start(): Promise<TerminalWriterStatus> {
		const ownerRevision = this.#ownerRevision;
		const status = await this.#writer.status();
		this.#applyStatus(status, ownerRevision);
		if (status.state === "exited") {
			this.#phase = "stopped";
			this.#exit = { code: status.exitCode, signal: status.signal };
		}
		return status;
	}

	/** A page whose own identity the extension host has already verified. */
	register(id: string, send: (message: TerminalHostMessage) => void): void {
		if (this.#disposed) return;
		this.#frontends.set(id, { id, send, focused: false, visible: false, attachRevision: 0, snapshot: null, redrawOwed: false });
	}

	unregister(id: string): void {
		if (!this.#frontends.delete(id)) return;
		if (this.#ownerId === id) {
			this.#ownership = this.#ownership.then(async () => {
				await this.#writer.releaseInput(id);
				await this.#currentStatus();
			}).catch(() => undefined);
		}
		this.#scheduleOwnership();
	}

	/**
	 * The ownership reconciliations this pipeline has scheduled, in order.
	 *
	 * A focus or visibility report arrives from a page and returns immediately, so the
	 * reconciliation it triggers is serialized here: two reports cannot fight over the
	 * writer, and a caller that needs the settled ownership (a test, or the host before
	 * it answers a new attach) can await it.
	 */
	get settled(): Promise<void> {
		return this.#ownership;
	}

	#scheduleOwnership(takeoverId: string | null = null): void {
		this.#ownership = this.#ownership.then(() => this.#recomputeOwner(takeoverId)).catch(() => undefined);
		this.#scheduleRedraw();
	}

	/** This host's own knowledge of whether the editor is showing. */
	notePanelVisible(visible: boolean): void {
		if (this.#panelVisible === visible) return;
		this.#panelVisible = visible;
		this.#scheduleOwnership();
	}

	/**
	 * Mark this pane read-only, or restore it.
	 *
	 * Used for a non-controlling editor after a conflicting native switch: input and
	 * resize stop being accepted and the broker's input slot is released, while output
	 * keeps flowing so the screen stays readable.
	 */
	noteReadOnly(reason: string | null): void {
		const bounded = reason === null ? null : reason.slice(0, MAX_LABEL_CHARS);
		if (this.#readOnlyReason === bounded) return;
		this.#readOnlyReason = bounded;
		// Publish the fence itself, not just a later broker-owner change. A temporary
		// fence can be lifted before queued ownership work runs; the pane must still
		// forget its last reported fit and restate it when input is restored.
		this.#broadcastState();
		// Ownership must be recomputed: a read-only pane can never be the candidate.
		this.#scheduleOwnership();
	}

	noteFocus(id: string, focused: boolean, intent = false): void {
		const frontend = this.#frontends.get(id);
		if (frontend === undefined || (frontend.focused === focused && !intent)) return;
		frontend.focused = focused;
		this.#scheduleOwnership(focused && intent ? id : null);
	}

	noteVisibility(id: string, visible: boolean): void {
		const frontend = this.#frontends.get(id);
		if (frontend === undefined || frontend.visible === visible) return;
		frontend.visible = visible;
		this.#scheduleOwnership();
	}

	/**
	 * Answer one attach.
	 *
	 * A page that names another generation is told the generation this host actually has,
	 * with the state and a snapshot for it: the renderer then resets and renders what
	 * really exists instead of keeping a screen from a writer that is gone.
	 */
	async attach(id: string, request: TerminalAttachRequest): Promise<void> {
		const frontend = this.#frontends.get(id);
		if (frontend === undefined) return;
		const revision = ++frontend.attachRevision;
		await this.#currentStatus();
		if (this.#disposed || this.#frontends.get(id) !== frontend || frontend.attachRevision !== revision) return;
		const live = this.#phase === "attached";
		const pending: SnapshotBuffer = { initialSeq: this.#lastSeq, output: [], bytes: 0, overflow: false, stateChanged: false };
		frontend.snapshot = live ? pending : null;
		frontend.send(this.#stateMessage(frontend, live ? "follows" : "none"));
		if (!live) return;
		let cut: number | null = null;
		let failure = SNAPSHOT_READ_FAILED;
		try {
			let snapshotData: TerminalWriterSnapshot;
			for (let attempt = 1; ; attempt++) {
				snapshotData = await this.#writer.snapshot();
				if (this.#disposed || this.#frontends.get(id) !== frontend || frontend.snapshot !== pending) return;
				if (!pending.overflow) break;
				// Output arrived faster than the screen could be read back, so the live frames
				// after the first reading were not retained. Restart the buffer from where
				// output stands now and read the screen again.
				if (attempt >= MAX_SNAPSHOT_ATTEMPTS) {
					failure = SNAPSHOT_OUTPACED;
					throw new Error(failure);
				}
				pending.output.length = 0;
				pending.bytes = 0;
				pending.overflow = false;
				pending.initialSeq = this.#lastSeq;
			}
			const bytes = fitTerminalSnapshot(snapshotData.data, snapshotData.rows);
			if (bytes === null) {
				failure = SNAPSHOT_TOO_LARGE;
				throw new Error(failure);
			}
			cut = snapshotData.seq;
			let consumed = pending.initialSeq;
			for (const entry of pending.output) {
				if (entry.position + entry.data.length <= cut) consumed = entry.message.seq;
			}
			frontend.send({
				type: "omp:terminal-snapshot",
				generation: this.#generation,
				seq: consumed,
				bytes: bytes.toString("base64"),
			});
			frontend.redrawOwed = this.#redrawAfterRestore;
		} catch {
			if (!this.#disposed && this.#frontends.get(id) === frontend && frontend.snapshot === pending) {
				frontend.send(this.#stateMessage(frontend, "failed", failure));
				pending.stateChanged = false;
			}
		} finally {
			if (!this.#disposed && this.#frontends.get(id) === frontend && frontend.snapshot === pending) {
				for (const entry of pending.output) {
					if (cut !== null && entry.position + entry.data.length <= cut) continue;
					const offset = cut === null ? 0 : Math.max(0, cut - entry.position);
					frontend.send(offset === 0 ? entry.message : { ...entry.message, bytes: Buffer.from(entry.data.slice(offset), "utf8").toString("base64") });
				}
				frontend.snapshot = null;
				if (this.#phase === "stopped" && this.#exit !== null) {
					frontend.send({ type: "omp:terminal-exit", generation: this.#generation, seq: this.#lastSeq, code: this.#exit.code, signal: this.#exit.signal });
				}
				if (pending.stateChanged) frontend.send(this.#stateMessage(frontend, "none"));
				this.#scheduleRedraw();
			}
		}
	}

	/** Verify liveness without resetting an intact screen or its scroll position. */
	async probe(id: string, request: TerminalProbeRequest): Promise<void> {
		const frontend = this.#frontends.get(id);
		if (frontend === undefined || this.#disposed) return;
		await this.#currentStatus();
		if (frontend.snapshot !== null) return;
		if (this.#phase === "attached" && (request.generation !== this.#generation || request.seq > this.#lastSeq)) {
			await this.attach(id, { generation: request.generation, cols: this.#cols, rows: this.#rows });
			return;
		}
		frontend.send(this.#stateMessage(frontend, "none"));
	}

	/** One keystroke or paste chunk from the owning page. */
	async input(id: string, request: TerminalInputRequest): Promise<void> {
		if (!this.#mayDrive(id, request.generation)) return;
		const bytes = decodeTerminalBytes(request.data, MAX_DATA_BYTES);
		if (bytes === null) return;
		await this.#writer.write(bytes.toString("utf8"), id).catch(() => undefined);
	}

	/**
	 * Paste `text` into the program as one bracketed paste, without Enter.
	 *
	 * Used by "OMP: Add Selection to Session" and "OMP: Add File to Session" for a native
	 * editor. It writes as the visible input owner, exactly like a paste in the pane, and
	 * only while the program itself has enabled bracketed paste: the native TUI does so
	 * for its prompt input and resets it on exit, so a shell prompt or a program that is
	 * still starting never receives the text. The bytes carry no carriage return or
	 * newline, so the TUI inserts them at its caret and cannot submit them. Whatever
	 * stops the paste is reported in the outcome.
	 */
	async pasteText(text: string): Promise<TerminalPasteOutcome> {
		const payload = bracketedPaste(text);
		if (payload === null) return "refused";
		if (this.#disposed || this.#readOnlyReason !== null || this.#phase !== "attached") return "unavailable";
		const id = this.#ownerId;
		if (id === null || !this.#visibleOwnership()) return "not-owner";
		if (this.#bracketedPaste === null) {
			// A pipeline created after the program started has not seen its mode-setting
			// output. The screen serializes the mode only when it is on, so "nothing named"
			// is an answer too: it is remembered so a polling caller never serializes the
			// screen twice, and live output replaces it at once. A mode change that arrived
			// while the screen was being read is newer than the reading and wins.
			const screen = await this.#writer.snapshot().catch(() => null);
			if (screen !== null && this.#bracketedPaste === null) this.#bracketedPaste = scanBracketedPasteMode(screen.data, null) ?? false;
		}
		if (this.#bracketedPaste !== true) return "not-ready";
		// The reading above can outlive the ownership it started under.
		if (this.#disposed || this.#ownerId !== id || !this.#visibleOwnership() || this.#phase !== "attached") return "not-owner";
		try {
			await this.#writer.write(payload, id);
		} catch {
			return "unavailable";
		}
		return "pasted";
	}

	/**
	 * A grid change from the owning page.
	 *
	 * Grid writes (this and the repaint nudge) run one at a time: a nudge that shrank the
	 * grid by a column and meets a page's resize halfway would otherwise grow it back to
	 * a size the page has already replaced. A request for the grid the broker already
	 * has sends nothing, so a page that merely restates its fit does not wake the program.
	 */
	async resize(id: string, request: TerminalResizeRequest): Promise<void> {
		if (!this.#mayDrive(id, request.generation)) return;
		if (!Number.isSafeInteger(request.cols) || !Number.isSafeInteger(request.rows)) return;
		// The renderer's own bounds: a grid outside them would be dropped by the page
		// rather than rendered, so it is refused here.
		if (request.cols < 2 || request.cols > 512 || request.rows < 1 || request.rows > 256) return;
		await this.#exclusiveGrid(async () => {
			if (!this.#mayDrive(id, request.generation)) return;
			const status = await this.#currentStatus();
			if (status.state !== "running" || (status.cols === request.cols && status.rows === request.rows)) return;
			this.#cols = request.cols;
			this.#rows = request.rows;
			await this.#writer.resize(request.cols, request.rows, id).catch(() => undefined);
			this.#broadcastState();
		});
	}

	/** Run one grid write after every earlier one has finished; a failure never blocks the next. */
	#exclusiveGrid(run: () => Promise<void>): Promise<void> {
		const next = this.#grid.then(run, run);
		this.#grid = next.catch(() => undefined);
		return next;
	}

	/**
	 * A completion the pane displayed.
	 *
	 * Only the owning page, showing the terminal in a focused visible panel, may
	 * report this: a hidden or passive pane must not make an answer look seen.
	 */
	seen(id: string, request: TerminalSeenRequest): void {
		if (request.outcome === null) return;
		if (this.#ownerId !== id || !this.#visibleOwnership() || !this.#frontends.get(id)?.focused) return;
		if (request.generation !== null && request.generation !== this.#generation) return;
		this.#onSeen?.(request.outcome);
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		if (this.#ownerId !== null && this.#frontends.has(this.#ownerId)) {
			void this.#writer.releaseInput(this.#ownerId).catch(() => undefined);
		}
		this.#stopWatching();
		this.#frontends.clear();
		this.#ownerId = null;
	}

	#onWriterEvent(event: TerminalWriterEvent): void {
		if (this.#disposed) return;
		if (event.kind === "input-owner") {
			this.#noteOwner(event.frontendId);
			return;
		}
		if (event.kind === "closed") {
			this.#noteOwner(null);
			if (this.#exit === null) {
				this.#phase = "unavailable";
				this.#reason = "OMP's terminal connection closed. Reload the session to reconnect.";
			}
			this.#broadcastState();
			return;
		}
		if (event.kind === "exit") {
			this.#seq = Math.max(this.#seq, event.seq);
			this.#phase = "stopped";
			this.#exit = { code: event.code, signal: event.signal };
			for (const frontend of this.#frontends.values()) {
				if (frontend.snapshot !== null) continue;
				frontend.send({
					type: "omp:terminal-exit",
					generation: this.#generation,
					seq: this.#lastSeq,
					code: event.code,
					signal: event.signal,
				});
			}
			this.#broadcastState();
			return;
		}
		this.#seq = Math.max(this.#seq, event.seq);
		// A sequence may be split across two output events, so the tail of the previous one is scanned again.
		const scanned = this.#modeTail + event.data;
		this.#bracketedPaste = scanBracketedPasteMode(scanned, this.#bracketedPaste);
		this.#modeTail = scanned.slice(-MODE_TAIL_CHARS);
		let position = event.seq;
		for (const chunk of chunkTerminalText(event.data)) {
			const bytes = Buffer.from(chunk, "utf8");
			const message: TerminalDataMessage = {
				type: "omp:terminal-data", generation: this.#generation, seq: ++this.#lastSeq, bytes: bytes.toString("base64"),
			};
			for (const frontend of this.#frontends.values()) {
				const pending = frontend.snapshot;
				if (pending === null) { frontend.send(message); continue; }
				if (pending.overflow) continue;
				pending.bytes += bytes.length;
				if (pending.bytes > MAX_SNAPSHOT_BYTES) {
					pending.overflow = true;
					pending.output.length = 0;
				} else pending.output.push({ message, position, data: chunk });
			}
			position += chunk.length;
		}
	}

	async #currentStatus(): Promise<TerminalWriterStatus> {
		// A proved child exit survives retirement of its broker. The retained editor
		// can still answer liveness probes without turning that exit into a disconnect.
		if (this.#exit !== null) {
			return {
				state: "exited", exitCode: this.#exit.code, signal: this.#exit.signal,
				cols: this.#cols, rows: this.#rows, alt: this.#lastAlt, title: this.#lastTitle,
				seq: this.#seq, oldestSeq: this.#oldestSeq, inputOwner: null, notices: [],
			};
		}
		try {
			const ownerRevision = this.#ownerRevision;
			const status = await this.#writer.status();
			this.#applyStatus(status, ownerRevision);
			return status;
		} catch {
			this.#phase = "unavailable";
			this.#reason = "OMP's terminal is not answering. Reload the session to reconnect.";
			return {
				state: "exited",
				exitCode: null,
				signal: null,
				cols: this.#cols,
				rows: this.#rows,
				alt: this.#lastAlt,
				title: this.#lastTitle,
				seq: this.#seq,
				oldestSeq: this.#oldestSeq,
				inputOwner: null,
				notices: [],
			};
		}
	}

	#applyStatus(status: TerminalWriterStatus, ownerRevision: number): void {
		this.#cols = status.cols;
		this.#rows = status.rows;
		this.#seq = Math.max(this.#seq, status.seq);
		this.#oldestSeq = status.oldestSeq;
		this.#lastAlt = status.alt;
		this.#lastTitle = status.title;
		if (ownerRevision === this.#ownerRevision) this.#noteOwner(status.inputOwner);
		if (status.state === "running") {
			this.#phase = "attached";
			this.#reason = null;
		}
		if (status.state === "exited") this.#phase = "stopped";
	}

	#noteOwner(owner: string | null): void {
		this.#ownerRevision += 1;
		if (this.#ownerId === owner) return;
		this.#ownerId = owner;
		this.#broadcastState();
		if (owner !== null) this.#scheduleRedraw();
	}

	#mayDrive(id: string, generation: string): boolean {
		if (this.#disposed || this.#readOnlyReason !== null || this.#phase !== "attached") return false;
		if (generation !== this.#generation) return false;
		return this.#ownerId === id && this.#visibleOwnership();
	}

	#visibleOwnership(): boolean {
		if (this.#readOnlyReason !== null) return false;
		if (!this.#panelVisible || this.#ownerId === null) return false;
		const frontend = this.#frontends.get(this.#ownerId);
		return frontend !== undefined && frontend.visible;
	}

	/** A visible, authorized page may acquire an unowned broker without takeover. */
	#candidateOwner(): string | null {
		// A read-only pane never takes input, so it is never a candidate owner and the
		// broker's input slot is released rather than handed to it.
		if (this.#readOnlyReason !== null) return null;
		if (!this.#panelVisible) return null;
		for (const frontend of this.#frontends.values()) {
			if (frontend.visible) return frontend.id;
		}
		return null;
	}

	async #recomputeOwner(takeoverId: string | null): Promise<void> {
		if (this.#disposed) return;
		const previous = this.#ownerId;
		if (previous !== null && this.#frontends.has(previous) && !this.#visibleOwnership()) {
			const revision = this.#ownerRevision;
			await this.#writer.releaseInput(previous);
			if (revision === this.#ownerRevision) await this.#currentStatus();
		}
		const requested = takeoverId === null ? undefined : this.#frontends.get(takeoverId);
		const takeover = requested !== undefined && requested.visible && requested.focused
			&& this.#panelVisible && this.#readOnlyReason === null;
		const next = takeover ? requested.id : this.#ownerId === null ? this.#candidateOwner() : null;
		if (next === null || next === this.#ownerId) return;
		const revision = this.#ownerRevision;
		const confirmed = await this.#writer.claimInput(next, takeover);
		if (revision === this.#ownerRevision) this.#noteOwner(confirmed);
	}

	#scheduleRedraw(): void {
		if (!this.#redrawAfterRestore || this.#disposed) return;
		this.#ownership = this.#ownership.then(() => this.#redraw()).catch(() => undefined);
	}

	/**
	 * Repaint on request (`OMP: Redraw Terminal`): the same one-column shrink and regrow a
	 * restore performs, for the visible page that owns input right now. It exists for the
	 * moments the program's own differential renderer and the terminal disagree about
	 * where rows are for a reason this pipeline cannot see. Nothing is hidden or
	 * rewritten: the program redraws its screen from its own state. Returns `false` when
	 * no visible owner can be repainted, so the caller can say so.
	 */
	async redrawNow(): Promise<boolean> {
		const id = this.#ownerId;
		const frontend = id === null ? undefined : this.#frontends.get(id);
		if (!this.#redrawAfterRestore || this.#disposed || frontend === undefined || this.#phase !== "attached" || !this.#visibleOwnership() || frontend.snapshot !== null) return false;
		frontend.redrawOwed = true;
		this.#ownership = this.#ownership.then(() => this.#redraw()).catch(() => undefined);
		await this.#ownership;
		return true;
	}

	/**
	 * Make OMP repaint its whole screen, once, for the owning page that was just given a
	 * restored screen.
	 *
	 * A snapshot is the broker mirror's picture of the screen, not the program's memory of
	 * it. OMP's renderer is differential: it moves relative to where it believes the
	 * hardware cursor is and rewrites only the rows it believes changed. Anything the
	 * picture does not reproduce exactly (a mirror of an older build whose widths or modes
	 * differ, a trimmed scrollback, a cursor row parked mid-frame) leaves every later
	 * frame landing off the rows it was meant for, and stale copies of an animated row
	 * stay behind. A size change is the one request every full-screen program honours by
	 * repainting its whole viewport, so the broker is told the grid shrank by a column and
	 * grew back (a SIGWINCH-equivalent through the existing owner-only resize).
	 *
	 * The nudge works on the grid the broker has at that moment, read inside the
	 * serialized grid write. The fit a page named when it attached is not used: it is
	 * measured while the editor is still being laid out and is often a row or two off the
	 * settled one, so resizing the program to it would only make it repaint at a grid that
	 * is replaced a few milliseconds later.
	 *
	 * It runs only for the visible input owner, so a hidden or passive page never resizes
	 * a terminal someone else is watching, and a page that becomes the owner later is
	 * repainted then. The flag is consumed before the first request, which is what makes
	 * one restore cause exactly one repaint.
	 */
	async #redraw(): Promise<void> {
		const id = this.#ownerId;
		if (this.#disposed || id === null || this.#phase !== "attached" || !this.#visibleOwnership()) return;
		const frontend = this.#frontends.get(id);
		if (frontend === undefined || !frontend.redrawOwed || frontend.snapshot !== null) return;
		frontend.redrawOwed = false;
		await this.#exclusiveGrid(async () => {
			const status = await this.#currentStatus();
			if (this.#disposed || status.state !== "running" || this.#ownerId !== id || status.cols < REDRAW_MIN_COLS) return;
			await this.#writer.resize(status.cols - 1, status.rows, id);
			await this.#writer.resize(status.cols, status.rows, id);
		});
	}

	#broadcastState(): void {
		for (const frontend of this.#frontends.values()) {
			if (frontend.snapshot === null) frontend.send(this.#stateMessage(frontend, "none"));
			else frontend.snapshot.stateChanged = true;
		}
	}

	#stateMessage(frontend: Frontend, snapshot: TerminalStateMessage["snapshot"], reason?: string): TerminalStateMessage {
		const base: TerminalStateMessage = {
			type: "omp:terminal-state",
			generation: this.#generation,
			seq: this.#lastSeq,
			phase: this.#phase,
			input: this.#ownerId === frontend.id && this.#visibleOwnership(),
			cols: this.#cols,
			rows: this.#rows,
			snapshot,
		};
		const withLabel = { ...base, ...(this.#label === null ? {} : { sessionLabel: this.#label }),
			...(this.#description === null ? {} : { description: this.#description }) };
		const named = reason ?? (this.#phase === "attached" ? this.#readOnlyReason ?? undefined : this.#stoppedReason());
		return named === undefined ? withLabel : { ...withLabel, reason: named };
	}

	#stoppedReason(): string {
		if (this.#phase === "unavailable") return this.#reason ?? "this terminal is not available";
		if (this.#exit === null) return "the terminal process has stopped";
		const by = this.#exit.signal === null ? `exit code ${this.#exit.code ?? "unknown"}` : `signal ${this.#exit.signal}`;
		return `the terminal process has stopped (${by})`;
	}
}

/** Bounded display text, with control characters removed rather than shown. */
function boundedLabel(value: string | null): string | null {
	if (value === null) return null;
	const stripped = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim();
	if (stripped.length === 0) return null;
	return stripped.length > MAX_LABEL_CHARS ? stripped.slice(0, MAX_LABEL_CHARS) : stripped;
}

/** Decode base64 bytes a page sent, or `null` when it is not the canonical form. */
function decodeTerminalBytes(data: string, limit: number): Buffer | null {
	if (typeof data !== "string" || data.length === 0 || data.length % 4 !== 0) return null;
	if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return null;
	const bytes = Buffer.from(data, "base64");
	if (bytes.length === 0 || bytes.length > limit) return null;
	// A non-canonical encoding would decode to something the page did not send.
	if (bytes.toString("base64") !== data) return null;
	return bytes;
}

/**
 * What the terminal pane shows, and which frames it refuses.
 *
 * The host owns the terminal: it starts the process, writes the PTY and decides
 * which frontend may type into it. This module owns the *screen* — the sequence it
 * has applied, whether it is waiting for a consistent screen before applying more,
 * and what it tells the user when it cannot keep up. It is deliberately free of DOM
 * and of xterm.js so the rules below can be exercised directly.
 *
 * Three rules make it honest:
 *
 * - **A generation is a fence.** Every frame names one presentation. A different
 *   generation is adopted only by an explicit promised snapshot, never by ordinary
 *   output or a health/ownership report.
 * - **A screen is applied whole.** A pane that attaches, or that detects a gap in
 *   the sequence, waits for the host's screen instead of writing a partial stream
 *   into an empty one. Output that arrives meanwhile is covered by that screen.
 * - **Only current problems are shown.** Screen damage lasts until a valid screen
 *   repairs it; host availability and exit are represented by the current phase.
 *
 * The pane never stops a process, never re-attaches to another session and never
 * claims a capability: `owner` is the host's answer, and a pane that does not own
 * input stays read-only and copyable.
 */
import type {
	GuestHostMessage,
	GuestTerminalDataMessage,
	GuestTerminalExitMessage,
	GuestTerminalPhase,
	GuestTerminalSnapshotMessage,
	GuestTerminalStateMessage,
} from "../messages.ts";
import { decodeBase64 } from "./bytes-base64.ts";

/** Every host message this state machine accepts, in the order it arrived. */
export type TerminalFrame = GuestTerminalStateMessage | GuestTerminalSnapshotMessage | GuestTerminalDataMessage | GuestTerminalExitMessage;

/**
 * True for the four frames that describe a terminal.
 *
 * The pane subscribes to the panel's message stream, which carries every host
 * message; this is the one place that decides which of them are the terminal's.
 */
export function isTerminalFrame(message: GuestHostMessage): message is TerminalFrame {
	return (
		message.type === "omp:terminal-state" ||
		message.type === "omp:terminal-snapshot" ||
		message.type === "omp:terminal-data" ||
		message.type === "omp:terminal-exit"
	);
}

/** The grid the screen is rendered at. */
export interface TerminalGrid {
	readonly cols: number;
	readonly rows: number;
}

/** The host's phases, plus the state before any report has arrived. */
export type TerminalPanePhase = GuestTerminalPhase | "unattached";

export interface TerminalPaneState {
	/** The generation this screen belongs to; `null` before the first report. */
	readonly generation: string | null;
	/** Bounded retired namespaces; late frames must not trigger recovery. */
	readonly retiredGenerations: readonly string[];
	/** The last output sequence applied to this screen. */
	readonly seq: number;
	readonly phase: TerminalPanePhase;
	/** True when this document may write input and resize; the host's decision. */
	readonly owner: boolean;
	/**
	 * The pane's own proposal, from its fit of the container.
	 *
	 * It is what an attach asks for and what a resize reports, and it is the grid the
	 * screen shows while this pane owns input. While it does not own input the host's
	 * grid is what the screen shows, and this one is kept for whenever that changes.
	 */
	readonly fit: TerminalGrid;
	/** The grid the screen is rendered at: the pane's `fit` while it owns input, else the host's. */
	readonly grid: TerminalGrid;
	readonly sessionLabel: string | null;
	readonly reason: string | null;
	/** The exit the host reported for this generation; the screen is kept after it. */
	readonly exit: { readonly code: number | null; readonly signal: string | null } | null;
	/** True while a consistent screen for this generation is expected. */
	readonly awaitingSnapshot: boolean;
	/** True while this pane has asked to be re-verified after losing output. */
	readonly syncing: boolean;
	/** True when a terminal request went unanswered; this does not prove host loss. */
	readonly hostSilent: boolean;
	/** Bounded current screen problems, cleared by a replacement or valid snapshot. */
	readonly notices: readonly string[];
}

/** What the renderer must do with the frame that produced this state. */
export interface TerminalEffects {
	/** True when a new screen starts here: the renderer resets before writing. */
	readonly reset: boolean;
	/** Bytes to write, in order. */
	readonly writes: readonly Uint8Array[];
	/** True when the pane must ask the host to verify it and describe the terminal. */
	readonly attach: boolean;
}

const NO_EFFECTS: TerminalEffects = { reset: false, writes: [], attach: false };

/** Bound unresolved screen problems; availability and exit are separate state. */
const MAX_TERMINAL_NOTICES = 6;

function appendNotice(notices: readonly string[], notice: string): readonly string[] {
	if (notices[notices.length - 1] === notice) return notices;
	const next = [...notices, notice];
	return next.length > MAX_TERMINAL_NOTICES ? next.slice(next.length - MAX_TERMINAL_NOTICES) : next;
}

function requestFreshScreen(state: TerminalPaneState, notice: string): { state: TerminalPaneState; effects: TerminalEffects } {
	return {
		state: { ...state, syncing: true, notices: appendNotice(state.notices, notice) },
		effects: state.syncing || state.awaitingSnapshot ? NO_EFFECTS : { reset: false, writes: [], attach: true },
	};
}

/**
 * The state of a pane that has heard nothing yet.
 *
 * `grid` is the pane's own fit of its container: it is both what the first attach
 * asks for and what the screen is rendered at until the host reports its own.
 */
export function initialTerminalPane(grid: TerminalGrid): TerminalPaneState {
	return {
		generation: null,
		retiredGenerations: [],
		seq: 0,
		phase: "unattached",
		owner: false,
		fit: grid,
		grid,
		sessionLabel: null,
		reason: null,
		exit: null,
		awaitingSnapshot: false,
		syncing: false,
		hostSilent: false,
		notices: [],
	};
}

/**
 * Note the pane's own new fit of its container.
 *
 * The screen follows it only while this pane owns input; a passive pane keeps
 * rendering the host's grid, and this value is what it asks for if it takes over.
 */
export function resizeTerminalPane(state: TerminalPaneState, grid: TerminalGrid): TerminalPaneState {
	return { ...state, fit: grid, grid: state.owner ? grid : state.grid };
}

/**
 * Apply one frame.
 *
 * The returned state is what the pane renders and reports; the effects are the
 * writes and the re-attach the caller must perform, in this order, before anything
 * else arrives.
 */
export function reduceTerminalFrame(state: TerminalPaneState, frame: TerminalFrame): { state: TerminalPaneState; effects: TerminalEffects } {
	if (state.retiredGenerations.includes(frame.generation)
		&& (frame.type !== "omp:terminal-state" || frame.phase === "attached")) return { state, effects: NO_EFFECTS };
	if (frame.type === "omp:terminal-state") {
		const promised = frame.phase === "attached" && frame.snapshot === "follows";
		if (frame.phase === "attached" && frame.generation !== state.generation && !promised) {
			return requestFreshScreen({ ...state, owner: false }, "the terminal presentation changed; a fresh screen was requested");
		}
		const replaced = frame.generation !== state.generation;
		const owner = frame.phase === "attached" && frame.input;
		const failed = frame.snapshot === "failed";
		const gap = frame.phase === "attached" && !replaced && !promised && !failed
			&& !state.awaitingSnapshot && !state.syncing && frame.seq > state.seq;
		let notices = replaced ? [] : state.notices;
		if (gap) notices = appendNotice(notices, "output was missed, so this pane asked for a fresh screen");
		if (failed) notices = appendNotice(notices, frame.reason ?? "the host could not provide a fresh screen");
		return {
			state: {
				...state,
				generation: frame.generation,
				retiredGenerations: replaced && state.generation !== null
					? [...state.retiredGenerations.slice(-5), state.generation] : state.retiredGenerations,
				// A status cannot claim output was consumed. A promised replacement alone
				// establishes the new namespace; snapshot arrival applies the screen.
				seq: promised ? (replaced ? frame.seq : Math.max(state.seq, frame.seq)) : state.seq,
				phase: frame.phase,
				owner,
				grid: owner ? state.fit : { cols: frame.cols, rows: frame.rows },
				sessionLabel: frame.sessionLabel ?? null,
				reason: frame.reason ?? null,
				exit: replaced ? null : state.exit,
				awaitingSnapshot: frame.phase === "attached" && !failed && (promised || state.awaitingSnapshot),
				syncing: frame.phase === "attached" && !failed && !promised && (state.syncing || gap),
				hostSilent: false,
				notices,
			},
			effects: gap ? { reset: false, writes: [], attach: true } : NO_EFFECTS,
		};
	}

	if (frame.type === "omp:terminal-snapshot") {
		// A screen for another generation, or one the pane has already moved past, is
		// not the screen the pane is rendering: writing it would roll the terminal back.
		if (frame.generation !== state.generation || frame.seq < state.seq) return { state, effects: NO_EFFECTS };
		const bytes = decodeBase64(frame.bytes);
		if (bytes === null) {
			return { state: { ...state, notices: appendNotice(state.notices, "the host sent a screen this pane could not decode") }, effects: NO_EFFECTS };
		}
		return {
			state: { ...state, seq: frame.seq, awaitingSnapshot: false, syncing: false, hostSilent: false, notices: [] },
			effects: { reset: true, writes: [bytes], attach: false },
		};
	}

	if (frame.type === "omp:terminal-data") {
		if (frame.generation !== state.generation && state.phase === "attached") {
			return requestFreshScreen({ ...state, owner: false }, "the terminal presentation changed; a fresh screen was requested");
		}
		// After an exit the screen is final: late output cannot change it.
		if (frame.generation !== state.generation || state.exit !== null) return { state, effects: NO_EFFECTS };
		if (state.awaitingSnapshot || state.syncing) return { state, effects: NO_EFFECTS };
		if (frame.seq <= state.seq) return { state, effects: NO_EFFECTS };
		if (frame.seq > state.seq + 1) {
			// Dense sequences make a gap visible; the pane does not guess at the missing
			// bytes and does not write this frame, because the next thing written would
			// be a screen that never existed.
			return {
				state: { ...state, syncing: true, notices: appendNotice(state.notices, "output was missed, so this pane asked for a fresh screen") },
				effects: { reset: false, writes: [], attach: true },
			};
		}
		const bytes = decodeBase64(frame.bytes);
		if (bytes === null) {
			return { state: { ...state, notices: appendNotice(state.notices, "the host sent output this pane could not decode") }, effects: NO_EFFECTS };
		}
		return { state: { ...state, seq: frame.seq }, effects: { reset: false, writes: [bytes], attach: false } };
	}

	if (frame.generation !== state.generation) return { state, effects: NO_EFFECTS };
	const missed = state.exit === null && !state.awaitingSnapshot && !state.syncing && frame.seq > state.seq + 1;
	let notices = state.notices;
	if (missed) notices = appendNotice(notices, "output was missed before the terminal exited");
	return {
		state: {
			...state,
			seq: Math.max(state.seq, frame.seq),
			phase: "stopped",
			owner: false,
			exit: { code: frame.code, signal: frame.signal },
			awaitingSnapshot: false,
			syncing: false,
			hostSilent: false,
			notices,
		},
		effects: NO_EFFECTS,
	};
}

/**
 * Record that an attach was not answered within the pane's bounded wait.
 *
 * This proves only that the terminal request has not received an answer. An
 * authenticated host may still be connected, so the UI establishes host loss
 * separately. The caller arms this for an outstanding request and clears it
 * on any terminal frame; stale input is disabled while the screen stays copyable.
 */
export function timeoutTerminalAttach(
	state: TerminalPaneState,
	outstanding = state.awaitingSnapshot || state.syncing || state.phase === "unattached",
): TerminalPaneState {
	if (!outstanding || state.hostSilent) return state;
	return {
		...state,
		owner: false,
		awaitingSnapshot: false,
		syncing: false,
		hostSilent: true,
	};
}

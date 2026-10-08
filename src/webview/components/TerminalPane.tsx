/**
 * The terminal pane: the genuine native OMP TUI, inside the session editor tab.
 *
 * What this component does *not* do is the important part. It never starts, stops or
 * restarts a process, never re-attaches to another session and never settles a native
 * prompt: the terminal it renders belongs to a process the extension host owns, and
 * this pane is one frontend of it. When the host says this document may not type into
 * it, the pane stays read-only, keeps the screen and offers it for copying — it never
 * takes input over, and it never closes an editor or a process on the user's behalf.
 *
 * Everything about *which* frames count lives in `../lib/terminal-pane.ts`; this
 * component is the adapter between that state and the renderer: it drives xterm,
 * reports presence (focus and visibility) so a completion shown here can be
 * distinguished from one shown in the chat, and turns keystrokes into byte messages.
 * No frame, keystroke or clipboard interaction carries a secret, and none is
 * persisted.
 */
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { guestTransport } from "../bridge";
import { encodeUtf8Chunks } from "../lib/bytes-base64";
import { initialTerminalPane, isTerminalFrame, reduceTerminalFrame, resizeTerminalPane, timeoutTerminalAttach } from "../lib/terminal-pane";
import type { TerminalGrid, TerminalPaneState, TerminalFrame } from "../lib/terminal-pane";
import { createTerminalRenderer } from "../lib/terminal-renderer";
import type { TerminalRenderer } from "../lib/terminal-renderer";
import { reportTerminalPresence } from "../lib/terminal-presence";
import { writeTerminalClipboard } from "../lib/terminal-clipboard";
import { fitsTerminalCopyReply, MAX_TERMINAL_INPUT_BYTES } from "../messages";
import type { GuestTerminalCopyReplyMessage } from "../messages";
import { TerminalLinkClient } from "../lib/terminal-link-client";

/**
 * A terminal request can stall while the extension host is still connected.
 * Its timeout disables stale input and reports only that missing response;
 * host connection loss is established separately by the authenticated bridge.
 */
const ATTACH_TIMEOUT_MS = 4000;
const HOST_PROBE_INTERVAL_MS = 10000;
/**
 * How long the owner's fit must hold still before the PTY is resized to it. An editor that was
 * just revived is laid out over several frames, so its fit passes through a row or two of
 * intermediate values; reporting each one makes the program repaint (and the emulator reflow)
 * once per value, and that burst is what leaves stale rows behind.
 */
const RESIZE_SETTLE_MS = 120;
/** The grid the pane assumes before its first fit reports one. */
const INITIAL_GRID: TerminalGrid = { cols: 80, rows: 24 };

export interface TerminalPaneProps {
	/** True when this pane is the surface the document displays. */
	readonly active: boolean;
	/**
	 * True when this editor may not act on the session at all.
	 *
	 * The host already refuses input for such an editor (`input: false` in its state), and
	 * this is the second half: a passive pane does not ask for a resize either, so nothing
	 * it does can change the screen the owning editor is looking at.
	 */
	readonly passive: boolean;
	/** What the terminal belongs to (a session or a folder), for the pane header. */
	readonly title: string | undefined;
	/** Bumped when a person selects this surface, so keyboard focus can follow. */
	readonly focusSignal: string | number | null;
	/** Session recovery differs from a separate folder shell's Reconnect action. */
	readonly managedSession?: boolean;
	/** A native successor can be published after this pane's first attach request. */
	readonly hostAvailable?: boolean;
	/** The host is still admitting or launching a native successor. */
	readonly starting?: boolean;
}

/** The one-line state a user reads, and how alarming it is. */
function paneStatus(pane: TerminalPaneState, managedSession: boolean, hostConnectionLost: boolean): { readonly text: string; readonly level: "ok" | "warn" | "err" } {
	if (hostConnectionLost) return {
		text: managedSession ? "Lost contact with OMP in VS Code. Reload the window to reconnect; the session itself keeps running." : "Lost contact with OMP in VS Code. Use “Reconnect Terminal” on the folder to attach again.",
		level: "err",
	};
	if (pane.hostSilent) return { text: "the terminal has not responded yet", level: "warn" };
	if (pane.phase === "unattached") {
		return { text: "Starting…", level: "ok" };
	}
	if (pane.phase === "unavailable") return { text: pane.reason ?? "the terminal is unavailable", level: "err" };
	if (pane.phase === "stopped") {
		const ended = pane.exit === null ? "" : pane.exit.code === null ? ` (${pane.exit.signal ?? "signalled"})` : ` (exit code ${pane.exit.code})`;
		return { text: `stopped${ended} — the screen below is kept and copyable`, level: "warn" };
	}
	if (managedSession) return pane.reason === null
		? { text: "", level: "ok" }
		: { text: pane.reason, level: "warn" };
	return pane.owner
		? { text: "live — this editor is driving it", level: "ok" }
		: { text: "live — read-only here; another editor owns this terminal", level: "warn" };
}

export function TerminalPane({ active, title, focusSignal, passive, managedSession = false, hostAvailable, starting: hostStarting = false }: TerminalPaneProps): ReactNode {
	const hostRef = useRef<HTMLDivElement | null>(null);
	const rendererRef = useRef<TerminalRenderer | null>(null);
	const paneRef = useRef<TerminalPaneState>(initialTerminalPane(INITIAL_GRID));
	const [pane, setPane] = useState<TerminalPaneState>(paneRef.current);
	const hostConnectionLost = useSyncExternalStore(guestTransport.onRouteChange, guestTransport.hostConnectionLost);
	const [focused, setFocused] = useState(false);
	const [copyNote, setCopyNote] = useState<string | null>(null);
	const [description, setDescription] = useState<string | undefined>();
	/** The grid this pane last resized the host to, so a repeat is not sent. */
	const reportedGridRef = useRef<TerminalGrid | null>(null);
	const attachTimerRef = useRef<NodeJS.Timeout | null>(null);
	const resizeTimerRef = useRef<NodeJS.Timeout | undefined>(undefined);
	/** The presence last published, so only a change is reported to the host. */
	const publishedRef = useRef<{ readonly visible: boolean; readonly focused: boolean } | null>(null);
	const presenceRef = useRef({ active, focused });
	presenceRef.current = { active, focused };
	const replayPresenceRef = useRef(false);
	const consumedFocusRef = useRef<string | number | null>(null);
	const pendingFocusRef = useRef<string | number | null>(null);

	const publishFocus = useCallback((next: boolean): void => {
		const visible = presenceRef.current.active && document.visibilityState !== "hidden";
		const currentFocus = next && visible && document.hasFocus();
		presenceRef.current = { ...presenceRef.current, focused: currentFocus };
		const published = publishedRef.current;
		if (published?.visible !== visible) guestTransport.post({ type: "omp:terminal-visibility", visible });
		// Publish genuine renderer intent immediately, even when React already holds
		// `true`: the first click must reacquire an externally taken broker owner.
		guestTransport.post({ type: "omp:terminal-focus", focused: currentFocus, intent: currentFocus });
		publishedRef.current = { visible, focused: currentFocus };
		reportTerminalPresence({ visible, focused: currentFocus, generation: paneRef.current.generation });
		setFocused(currentFocus);
	}, []);

	const adopt = useCallback((next: TerminalPaneState): void => {
		paneRef.current = next;
		setPane(next);
	}, []);

	/**
	 * Tell the host the owner's fit once it has settled. What is compared is the fit at the time
	 * the timer fires, against the grid last reported to *this* host binding: the report is
	 * forgotten whenever the pane is not the owner or asks for a screen again, because the host
	 * refuses a resize from a page that does not own input and another owner may have changed the
	 * grid since.
	 */
	const reportFit = useCallback((): void => {
		clearTimeout(resizeTimerRef.current);
		resizeTimerRef.current = setTimeout(() => {
			resizeTimerRef.current = undefined;
			const state = paneRef.current;
			if (passive || !state.owner || state.phase !== "attached" || state.generation === null) return;
			const reported = reportedGridRef.current;
			if (reported?.cols === state.fit.cols && reported?.rows === state.fit.rows) return;
			reportedGridRef.current = state.fit;
			guestTransport.post({ type: "omp:terminal-resize", generation: state.generation, cols: state.fit.cols, rows: state.fit.rows });
		}, RESIZE_SETTLE_MS);
	}, [passive]);

	const attach = useCallback((requestScreen = true): void => {
		if (attachTimerRef.current !== null) return;
		if (requestScreen) {
			replayPresenceRef.current = true;
			reportedGridRef.current = null;
		}
		const current = paneRef.current;
		if (requestScreen) {
			guestTransport.post({ type: "omp:terminal-attach", generation: current.generation, cols: current.fit.cols, rows: current.fit.rows });
		} else {
			guestTransport.post({ type: "omp:terminal-probe", generation: current.generation, seq: current.seq });
		}
		// A health response proves liveness without resetting a healthy screen.
		attachTimerRef.current = setTimeout(() => {
			attachTimerRef.current = null;
			const settled = timeoutTerminalAttach(paneRef.current, true);
			if (settled !== paneRef.current) {
				rendererRef.current?.setInputEnabled(false);
				adopt(settled);
			}
		}, ATTACH_TIMEOUT_MS);
	}, [adopt]);

	const apply = useCallback(
		(frame: TerminalFrame): void => {
			const { state, effects } = reduceTerminalFrame(paneRef.current, frame);
			adopt(state);
			if (frame.type === "omp:terminal-state" && replayPresenceRef.current) {
				replayPresenceRef.current = false;
				// A rebound host has no old focus/visibility state. Replay it after the
				// terminal exists even if this surviving document's presence never changed.
				const presence = presenceRef.current;
				guestTransport.post({ type: "omp:terminal-visibility", visible: presence.active && document.visibilityState !== "hidden" });
				guestTransport.post({ type: "omp:terminal-focus", focused: presence.focused, intent: false });
			}
			if (!state.owner) reportedGridRef.current = null;
			const renderer = rendererRef.current;
			if (renderer !== null) {
				if (effects.reset) renderer.resetScreen();
				for (const bytes of effects.writes) renderer.write(bytes);
				// The renderer's own refusal is the second half of "one frontend owns input":
				// a pane the host did not authorize cannot type, whatever a caller does.
				renderer.setInputEnabled(state.owner && !passive);
				// The terminal always renders the pane's grid: the host's for a pane that does not
				// own input (two editors of one terminal never disagree about the screen they show),
				// and its own fit for the owner. The owner case matters as much: the screen is first
				// painted at the host's grid (this pane was not yet the owner), and the PTY is then
				// resized to this pane's fit; unless the renderer follows, OMP draws for one grid
				// while xterm shows another and every relative cursor move lands off.
				renderer.renderAt(state.grid);
				if (!passive && state.owner && state.phase === "attached" && state.generation !== null) reportFit();
			}
			// An answer of any kind ends the wait for one.
			if (attachTimerRef.current !== null) {
				clearTimeout(attachTimerRef.current);
				attachTimerRef.current = null;
			}
			if (effects.attach) attach();
		},
		[adopt, attach, passive, reportFit],
	);

	const fitPane = useCallback((): void => {
		const renderer = rendererRef.current;
		if (renderer === null) return;
		const grid = renderer.fitToContainer();
		if (grid === null) return;
		const state = resizeTerminalPane(paneRef.current, grid);
		adopt(state);
		if (passive || !state.owner) {
			renderer.renderAt(state.grid);
			return;
		}
		reportFit();
	}, [adopt, passive, reportFit]);

	// The renderer is created once, the first time this pane is displayed: a renderer
	// opened in a hidden element measures its font from a zero-sized box, and every
	// later fit would be relative to that.
	useEffect(() => {
		const host = hostRef.current;
		if (host === null || rendererRef.current !== null) return;
		const linkClient = new TerminalLinkClient(guestTransport);
		const renderer = createTerminalRenderer(host, {
			newlineOnShiftEnter: managedSession,
			// A native OMP session never sends Ctrl+C; a folder shell keeps the interrupt.
			ctrlCInterrupts: !managedSession,
			copyText: async text => {
				const copied = await writeTerminalClipboard(text);
				if (!copied) setCopyNote("the clipboard refused the copy — select the text and copy it");
				return copied;
			},
			onData: text => {
				const current = paneRef.current;
				// Input is only ever sent by the pane the host authorized, and only for the
				// generation it authorized: a keystroke must not reach a successor process.
				if (!current.owner || current.generation === null) return;
				const generation = current.generation;
				for (const chunk of encodeUtf8Chunks(text, MAX_TERMINAL_INPUT_BYTES)) {
					guestTransport.post({ type: "omp:terminal-input", generation, data: chunk });
				}
			},
			onFocus: publishFocus,
			onLink: (target, mode) => linkClient.open(target, mode),
			validateLink: target => linkClient.validate(target),
		});
		rendererRef.current = renderer;
		renderer.setInputEnabled(false);
		// Measure before the first attach: the grid travels with it, and a pane that asked for
		// a size it did not mean would cost the PTY a resize round trip on every open.
		const measured = renderer.fitToContainer();
		if (measured !== null) adopt(resizeTerminalPane(paneRef.current, measured));
		return () => {
			// The pane is going away: the terminal is left exactly as it is, and only the
			// renderer stops existing.
			renderer.dispose();
			linkClient.dispose();
			rendererRef.current = null;
		};
	}, [adopt, managedSession, publishFocus]);

	// Frames stay in arrival order. A native page can mount before its successor
	// exists, so host publication starts a fresh attach even after an unavailable
	// answer or while the first request's timeout is still pending.
	useEffect(() => {
		const unsubscribe = guestTransport.subscribe(message => {
			if (message.type === "omp:terminal-font" && rendererRef.current?.setFont(message)) fitPane();
			if (isTerminalFrame(message)) apply(message);
			if (message.type === "omp:terminal-state") setDescription(message.description);
			if (message.type === "omp:terminal-copy-request" && managedSession) {
				const renderer = rendererRef.current;
				const reply: GuestTerminalCopyReplyMessage = {
					type: "omp:terminal-copy-reply", requestId: message.requestId,
					generation: paneRef.current.generation, text: renderer?.plainText() ?? null,
				};
				if (!fitsTerminalCopyReply(reply)) reply.text = null;
				guestTransport.post(reply);
			}
		});
		if (attachTimerRef.current !== null) {
			clearTimeout(attachTimerRef.current);
			attachTimerRef.current = null;
		}
		attach();
		return unsubscribe;
	}, [apply, attach, fitPane, hostAvailable, managedSession]);

	// Quiet terminals verify liveness without resetting their screen or scrollback.
	useEffect(() => {
		if (!active) return;
		const probe = (): void => {
			if (document.visibilityState === "hidden") return;
			const current = paneRef.current;
			attach(current.awaitingSnapshot || current.syncing || current.hostSilent || current.phase !== "attached");
		};
		const timer = setInterval(probe, HOST_PROBE_INTERVAL_MS);
		return () => clearInterval(timer);
	}, [active, attach]);

	// A resize is only reported by the pane that owns input, and never by a passive pane:
	// it is not the one the host sized the terminal for.
	useEffect(() => {
		const host = hostRef.current;
		if (host === null) return;
		let frame: number | null = null;
		const fit = (): void => {
			frame = null;
			fitPane();
		};
		// Fitting writes xterm layout; defer it beyond ResizeObserver delivery to avoid
		// recursively resizing the observed container in the same rendering cycle.
		const observer = new ResizeObserver(() => {
			if (frame === null) frame = requestAnimationFrame(fit);
		});
		observer.observe(host);
		return () => {
			observer.disconnect();
			if (frame !== null) cancelAnimationFrame(frame);
		};
	}, [fitPane]);

	// Where this pane is, told to the host only when it changes, and to this document's
	// own presence store so a completion displayed here is distinguishable from one
	// displayed in the chat.
	useEffect(() => {
		const publish = (): void => {
			const visible = active && document.visibilityState !== "hidden";
			reportTerminalPresence({ visible, focused, generation: paneRef.current.generation });
			const published = publishedRef.current;
			if (published?.visible !== visible) guestTransport.post({ type: "omp:terminal-visibility", visible });
			if (published?.focused !== focused) guestTransport.post({ type: "omp:terminal-focus", focused, intent: false });
			publishedRef.current = { visible, focused };
		};
		publish();
		document.addEventListener("visibilitychange", publish);
		return () => document.removeEventListener("visibilitychange", publish);
	}, [active, focused, pane.generation]);

	// This document is going away: nothing here is displayed any more, and the host is
	// told once, on the way out, so it can hand input to whatever is left.
	useEffect(() => {
		return () => {
			reportTerminalPresence({ visible: false, focused: false, generation: null });
			guestTransport.post({ type: "omp:terminal-visibility", visible: false });
			guestTransport.post({ type: "omp:terminal-focus", focused: false, intent: false });
		};
	}, []);

	// Consume host activation once, only while this native document can receive
	// keyboard focus. Stream/status/model updates never participate in this effect.
	useEffect(() => {
		if (!active) {
			consumedFocusRef.current = focusSignal;
			pendingFocusRef.current = null;
			return;
		}
		if (focusSignal !== null && focusSignal !== 0 && focusSignal !== consumedFocusRef.current) pendingFocusRef.current = focusSignal;
		const clear = (): void => {
			consumedFocusRef.current = focusSignal;
			pendingFocusRef.current = null;
		};
		const focus = (): void => {
			if (document.visibilityState === "hidden") { clear(); return; }
			if (pendingFocusRef.current === null || !document.hasFocus() || rendererRef.current === null) return;
			consumedFocusRef.current = pendingFocusRef.current;
			pendingFocusRef.current = null;
			rendererRef.current.focus();
		};
		const blur = (): void => { clear(); publishFocus(false); };
		focus();
		window.addEventListener("focus", focus);
		window.addEventListener("blur", blur);
		document.addEventListener("visibilitychange", focus);
		return () => {
			window.removeEventListener("focus", focus);
			window.removeEventListener("blur", blur);
			document.removeEventListener("visibilitychange", focus);
		};
	}, [active, focusSignal, publishFocus]);

	useEffect(() => {
		return () => {
			clearTimeout(resizeTimerRef.current);
			if (attachTimerRef.current !== null) clearTimeout(attachTimerRef.current);
			attachTimerRef.current = null;
		};
	}, []);

	const status = paneStatus(pane, managedSession, hostConnectionLost);
	const starting = hostStarting || (pane.phase === "unattached" && !hostConnectionLost && !pane.hostSilent);
	const tooltip = `${title ?? "Terminal"}\n${pane.grid.cols}×${pane.grid.rows}\n${status.text || (pane.owner ? "Live — this editor is driving it" : "Live — read-only here")}${description ? `\n${description}` : ""}`;

	return (
		<div className="omp-terminal" title={tooltip}>
			{starting && <div className="omp-terminal-note" role="status">Starting…</div>}
			{status.level === "ok" || hostStarting ? null : <div className={`omp-terminal-note omp-terminal-state--${status.level}`} role="status">{status.text}</div>}
			{/* The renderer measures this element, so it is the full remaining height. */}
			<div className="omp-terminal-host" ref={hostRef} />
			{pane.notices.length === 0 ? null : (
				<div className="omp-terminal-notes">
					{pane.notices.map((notice, index) => (
						<div key={`${index}:${notice}`} className="omp-terminal-note">
							{notice}
						</div>
					))}
				</div>
			)}
			{copyNote !== null && <div className="omp-terminal-notes"><div className="omp-terminal-note">{copyNote}</div></div>}
		</div>
	);
}

/**
 * Find in the conversation (`Ctrl+F`, or **OMP Desk: Find in Chat**).
 *
 * The transcript keeps most rows out of the page, so the find bar searches the loaded conversation itself (`lib/transcript-find.ts`)
 * and only then looks at the DOM: the match's row is brought into the transcript's window and scrolled to (through the scroll
 * controller, as Rewind does), what hides the text (a group, a call's output, a thinking block) is opened, and the occurrences that
 * are mounted are painted (`lib/find-dom.ts`). The bar starts at the newest match; `Enter`/`F3` go to the next, `Shift+Enter`/`Shift+F3`
 * to the previous, both wrapping; `Esc` closes it and returns the focus to where it was.
 */
import type { ReactNode, RefObject } from "react";
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { TranscriptCard } from "../../chat/transcript";
import type { OverviewProjection } from "../../chat/tool-overview";
import { canHighlight, paintFind, rangesIn, rowText } from "../lib/find-dom";
import { reportComposerPopupOpen } from "../lib/composer-overlay";
import { provideFindAction, requestPanelAction } from "../lib/panel-actions";
import { findIdOf, findPattern, findUnitsOf, matchAt, positionOf, searchUnits, segmentOf, type FindMatch, type FindSearch } from "../lib/transcript-find";
import type { TranscriptScrollController } from "../lib/transcript-scroll";
import { markdownShownText } from "./Markdown";

export interface TranscriptFindParams {
	/** Only the conversation's own transcript has Find; a child agent's transcript inside a call does not. */
	enabled: boolean;
	/** Every loaded card, and the ones the window mounts. */
	canonical: readonly TranscriptCard[];
	rows: readonly TranscriptCard[];
	overview: OverviewProjection;
	/** Whether tool calls are grouped into collapsed runs (Overview) or listed flat (Detailed). */
	grouped: boolean;
	shown: ReadonlyMap<string, boolean>;
	namespace: string;
	cwd: string | undefined;
	/** Screen-reader paging: the window is a page, not a tail. */
	paged: boolean;
	/** Rows still on disk above the loaded ones, and whether a context reset hides earlier loaded history. */
	olderCount: number;
	beforeReset: boolean;
	rootRef: RefObject<HTMLDivElement | null>;
	controllerRef: RefObject<TranscriptScrollController | null>;
	/** Load the window from this card on (the tail window starts there), or show the page that begins at it. */
	pinTop(cardId: string): void;
	showPage(cardId: string): void;
	disclose(key: string, open: boolean): void;
}

/** Frames a reveal waits for the row, its opened parts and the match to be in the page; after `SETTLE_FRAMES` with the row mounted it settles for what is there. */
const REVEAL_FRAMES = 40;
const SETTLE_FRAMES = 12;

/** The row that draws unit `id`, if it is mounted. */
function rowOf(root: Element | null, id: string): HTMLElement | null {
	return root?.querySelector<HTMLElement>(`[data-find-id="${CSS.escape(id)}"]`) ?? null;
}

function statusText(query: string, search: FindSearch, position: number): string {
	if (query.length === 0) return "";
	if (search.total === 0) return "No results";
	return position < 0 ? `${search.total.toLocaleString("en-US")} found` : `${(position + 1).toLocaleString("en-US")} of ${search.total.toLocaleString("en-US")}`;
}

/** The find bar's state and keys; the bar to draw (`null` while closed). */
export function useTranscriptFind(params: TranscriptFindParams): ReactNode {
	const { enabled } = params;
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [caseSensitive, setCaseSensitive] = useState(false);
	const [current, setCurrent] = useState<FindMatch | null>(null);
	const [focusRequest, setFocusRequest] = useState(0);
	const [fieldFocused, setFieldFocused] = useState(false);
	const deferredQuery = useDeferredValue(query);
	const inputRef = useRef<HTMLInputElement | null>(null);
	const barRef = useRef<HTMLDivElement | null>(null);
	const returnFocus = useRef<HTMLElement | null>(null);
	const revealToken = useRef(0);
	const patternKey = useRef("");
	const painting = useRef<number | null>(null);
	const latest = useRef(params);
	latest.current = params;

	const units = useMemo(() => open && enabled ? findUnitsOf(params.canonical, params.cwd, markdownShownText) : [], [open, enabled, params.canonical, params.cwd]);
	const pattern = useMemo(() => findPattern(deferredQuery, caseSensitive), [deferredQuery, caseSensitive]);
	const search = useMemo(() => searchUnits(units, pattern), [units, pattern]);
	const position = current === null ? -1 : positionOf(search, current);
	const state = useRef({ search, current, open });
	state.current = { search, current, open };

	/** Paint every occurrence in the mounted rows and the current match over them. */
	const paint = useCallback((): void => {
		const root = latest.current.rootRef.current, { search: now, current: match, open: showing } = state.current;
		root?.querySelector("[data-find-current]")?.removeAttribute("data-find-current");
		if (!showing || root === null || now.pattern === null) { paintFind([], null); return; }
		const all: Range[] = [];
		let currentRange: Range | null = null, currentRow: Element | null = null;
		for (const row of root.querySelectorAll<HTMLElement>("[data-find-id]")) {
			if (row.parentElement?.closest("[data-find-id]") !== null) continue;
			const ranges = rangesIn(rowText(row), now.pattern);
			all.push(...ranges);
			if (match !== null && row.dataset.findId === match.id) { currentRow = row; currentRange = ranges[match.occurrence] ?? null; }
		}
		paintFind(all, currentRange);
		// A match whose text is not drawn (deep in a long output), or a page that cannot paint, still shows which row holds it.
		if (currentRow !== null && (currentRange === null || !canHighlight())) currentRow.setAttribute("data-find-current", "");
	}, []);
	const schedulePaint = useCallback((): void => {
		if (painting.current !== null) return;
		painting.current = requestAnimationFrame(() => { painting.current = null; paint(); });
	}, [paint]);

	/** Bring the match into view: load its row, open what hides it, scroll to its line. */
	const reveal = useCallback((match: FindMatch): void => {
		const token = ++revealToken.current;
		const { search: now } = state.current;
		const unit = now.units.find(candidate => candidate.id === match.id);
		const needle = now.pattern;
		if (unit === undefined || needle === null) return;
		const segment = segmentOf(unit, match.occurrence);
		const hasThinking = unit.segments.some((candidate, index) => candidate.part === "thinking" && (unit.memo?.counts[index] ?? 0) > 0);
		const first = latest.current;
		if (!first.rows.some(card => findIdOf(card) === unit.id)) {
			if (first.paged) first.showPage(unit.cardId); else first.pinTop(unit.cardId);
		}
		/** Opens the group and the call a match hides in. Each opening re-captures the reader's place, so the scroll is asked for again after it. */
		const openHidden = (): boolean => {
			const view = latest.current;
			if (unit.callId === undefined) return false;
			let opened = false;
			const run = view.grouped ? view.overview.runs.find(candidate => candidate.members.some(member => member.kind === "tool" && member.tool.call.id === unit.callId)) : undefined;
			if (run !== undefined && view.shown.get(run.id) !== true) { view.disclose(run.id, true); opened = true; }
			const call = `call:${view.namespace}:${unit.callId}`;
			if (segment?.part === "output" && view.shown.get(call) !== true) { view.disclose(call, true); opened = true; }
			return opened;
		};
		openHidden();
		latest.current.controllerRef.current?.reveal(unit.sources);
		let frames = 0, seen = 0;
		const tick = (): void => {
			if (revealToken.current !== token) return;
			frames++;
			if (frames > 1 && openHidden()) {
				latest.current.controllerRef.current?.reveal(unit.sources);
				requestAnimationFrame(tick);
				return;
			}
			const row = rowOf(latest.current.rootRef.current, unit.id);
			if (row !== null) {
				seen++;
				const closed = hasThinking ? [...row.querySelectorAll<HTMLDetailsElement>("details.omp-thinking:not([open])")] : [];
				if (closed.length > 0) for (const details of closed) details.open = true;
				else {
					const target = rangesIn(rowText(row), needle)[match.occurrence] ?? null;
					if (target !== null || seen >= SETTLE_FRAMES) {
						// The row's top went a third of the way down; a match deep inside a tall row goes there instead.
						const root = latest.current.rootRef.current, controller = latest.current.controllerRef.current, anchor = row.closest<HTMLElement>("[data-anchor-key]");
						if (target !== null && root !== null && controller !== null && anchor !== null) {
							controller.reveal(unit.sources, Math.round(root.clientHeight / 3 - (target.getBoundingClientRect().top - anchor.getBoundingClientRect().top)));
						}
						schedulePaint();
						return;
					}
				}
			}
			if (frames < REVEAL_FRAMES) requestAnimationFrame(tick);
		};
		requestAnimationFrame(tick);
	}, [schedulePaint]);

	const goTo = useCallback((match: FindMatch | null): void => {
		setCurrent(match);
		if (match !== null) reveal(match);
	}, [reveal]);

	const step = useCallback((delta: 1 | -1): void => {
		const { search: now, current: match } = state.current;
		if (now.total === 0) return;
		const at = match === null ? -1 : positionOf(now, match);
		goTo(matchAt(now, at < 0 ? (delta > 0 ? 0 : now.total - 1) : (at + delta + now.total) % now.total));
	}, [goTo]);

	const openFind = useCallback((): void => {
		const view = latest.current;
		const selection = window.getSelection();
		const seed = selection !== null && !selection.isCollapsed && view.rootRef.current?.contains(selection.anchorNode) === true ? selection.toString() : "";
		if (seed.length > 0 && seed.length <= 200 && !seed.includes("\n")) setQuery(seed);
		if (!state.current.open) {
			const active = document.activeElement;
			returnFocus.current = active instanceof HTMLElement && active !== document.body && barRef.current?.contains(active) !== true ? active : null;
			patternKey.current = "";
			setOpen(true);
		}
		setFocusRequest(count => count + 1);
	}, []);

	const close = useCallback((): void => {
		revealToken.current++;
		paintFind([], null);
		setOpen(false);
		setCurrent(null);
		setFieldFocused(false);
		const back = returnFocus.current;
		returnFocus.current = null;
		if (back?.isConnected === true) back.focus({ preventScroll: true });
		else requestPanelAction("focus-composer");
	}, []);

	useEffect(() => {
		if (!enabled) return;
		const release = provideFindAction(openFind);
		const onKeyDown = (event: KeyboardEvent): void => {
			if (event.isComposing || event.keyCode === 229) return;
			if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "f") { event.preventDefault(); openFind(); return; }
			if (event.key === "F3" && !event.ctrlKey && !event.altKey && !event.metaKey && state.current.open) { event.preventDefault(); step(event.shiftKey ? -1 : 1); }
		};
		document.addEventListener("keydown", onKeyDown, true);
		return () => { release(); document.removeEventListener("keydown", onKeyDown, true); };
	}, [enabled, openFind, step]);

	useEffect(() => {
		if (!open) return;
		inputRef.current?.focus();
		inputRef.current?.select();
	}, [open, focusRequest]);

	// While the field has the focus Escape belongs to it: the host's stop-turn key stays disarmed for that press.
	useEffect(() => {
		reportComposerPopupOpen("find", open && fieldFocused);
		return () => reportComposerPopupOpen("find", false);
	}, [open, fieldFocused]);

	// A new query starts at the newest match; the same query keeps its match while the conversation changes under it.
	useEffect(() => {
		if (!open) return;
		const key = search.pattern === null ? "" : `${search.pattern.flags}:${search.pattern.source}`;
		const changed = patternKey.current !== key;
		patternKey.current = key;
		if (search.total === 0) { if (current !== null) setCurrent(null); return; }
		if (changed) goTo(matchAt(search, search.total - 1));
		else if (position < 0) setCurrent(matchAt(search, search.total - 1));
	}, [open, search, current, position, goTo]);

	useEffect(() => { schedulePaint(); }, [open, search, current, schedulePaint]);
	useEffect(() => {
		const root = params.rootRef.current;
		if (!open || root === null) return;
		const observer = new MutationObserver(schedulePaint);
		observer.observe(root, { childList: true, characterData: true, subtree: true });
		return () => observer.disconnect();
	}, [open, params.rootRef, schedulePaint]);
	useEffect(() => () => {
		revealToken.current++;
		if (painting.current !== null) cancelAnimationFrame(painting.current);
		paintFind([], null);
	}, []);

	if (!open || !enabled) return null;
	const notes = [
		params.olderCount > 0 ? `${params.olderCount.toLocaleString("en-US")} earlier messages are not loaded` : "",
		params.beforeReset ? "Messages before the context reset are not searched" : "",
	].filter(note => note !== "");
	return (
		<div ref={barRef} className="omp-find" role="search" aria-label="Find in conversation">
			<div className="omp-find-row">
				<input ref={inputRef} className="omp-find-input" type="text" aria-label="Find in conversation" placeholder="Find" spellCheck={false} autoComplete="off" value={query}
					onChange={event => setQuery(event.target.value)} onFocus={() => setFieldFocused(true)} onBlur={() => setFieldFocused(false)}
					onKeyDown={event => {
						if (event.nativeEvent.isComposing || event.keyCode === 229) return;
						if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
						else if (event.key === "Enter") { event.preventDefault(); step(event.shiftKey ? -1 : 1); }
						else if (event.altKey && !event.ctrlKey && !event.metaKey && event.key.toLowerCase() === "c") { event.preventDefault(); setCaseSensitive(value => !value); }
					}} />
				<span className="omp-find-status" role="status" aria-live="polite">{statusText(query, search, position)}</span>
				<button type="button" className="omp-find-button" aria-label="Match case" aria-pressed={caseSensitive} aria-keyshortcuts="Alt+C" title="Match Case (Alt+C)" onClick={() => { setCaseSensitive(value => !value); inputRef.current?.focus(); }}><span className="codicon codicon-case-sensitive" aria-hidden="true" /></button>
				<button type="button" className="omp-find-button" aria-label="Previous match" aria-keyshortcuts="Shift+Enter Shift+F3" title="Previous Match (Shift+Enter)" disabled={search.total === 0} onClick={() => step(-1)}><span className="codicon codicon-arrow-up" aria-hidden="true" /></button>
				<button type="button" className="omp-find-button" aria-label="Next match" aria-keyshortcuts="Enter F3" title="Next Match (Enter)" disabled={search.total === 0} onClick={() => step(1)}><span className="codicon codicon-arrow-down" aria-hidden="true" /></button>
				<button type="button" className="omp-find-button" aria-label="Close find" aria-keyshortcuts="Escape" title="Close (Escape)" onClick={close}><span className="codicon codicon-close" aria-hidden="true" /></button>
			</div>
			{query.length > 0 && notes.length > 0 && <div className="omp-find-note">{notes.join(". ")}.</div>}
		</div>
	);
}

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
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { TranscriptCard } from "../../chat/transcript";
import type { OverviewProjection } from "../../chat/tool-overview";
import { canHighlight, MAX_PAINTED, paintFind, rangesIn, rangesOf, rowText } from "../lib/find-dom";
import { reportComposerPopupOpen } from "../lib/composer-overlay";
import { provideFindAction, requestPanelAction } from "../lib/panel-actions";
import { clearFindCache, findIdOf, findPattern, findUnitsOf, isLetterKey, matchAt, positionOf, searchUnits, segmentOf, type FindMatch, type FindSearch, type FindSegment, type FindUnit } from "../lib/transcript-find";
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
/** How long typing must pause before the conversation is searched, and the least time between mutation-driven repaints. */
const QUERY_DEBOUNCE_MS = 150;
const PAINT_INTERVAL = 200;

/** The row that draws unit `id`, if it is mounted. */
function rowOf(root: Element | null, id: string): HTMLElement | null {
	return root?.querySelector<HTMLElement>(`[data-find-id="${CSS.escape(id)}"]`) ?? null;
}

function statusText(query: string, search: FindSearch, position: number): string {
	if (query.length === 0) return "";
	if (search.total === 0) return "No results";
	return position < 0 ? `${search.total.toLocaleString("en-US")} found` : `${(position + 1).toLocaleString("en-US")} of ${search.total.toLocaleString("en-US")}`;
}

/** The state keys of what hides `segment` of `unit`: its tool group in the Overview and, for output text, the call. */
function containerKeys(view: TranscriptFindParams, unit: FindUnit, segment: FindSegment | null): string[] {
	if (unit.callId === undefined) return [];
	const keys: string[] = [];
	const run = view.grouped ? view.overview.runs.find(candidate => candidate.members.some(member => member.kind === "tool" && member.tool.call.id === unit.callId)) : undefined;
	if (run !== undefined) keys.push(run.id);
	if (segment?.part === "output") keys.push(`call:${view.namespace}:${unit.callId}`);
	return keys;
}

/** The thinking block that holds `segment`: the one of its position among the unit's thinking blocks when the row draws as many, else every block of the row. */
function thinkingBlocks(row: HTMLElement, unit: FindUnit, segment: FindSegment | null): HTMLDetailsElement[] {
	if (segment?.part !== "thinking") return [];
	const blocks = [...row.querySelectorAll<HTMLDetailsElement>("details.omp-thinking")].filter(details => details.closest("[data-find-id]") === row);
	const thinking = unit.segments.filter(candidate => candidate.part === "thinking");
	const block = blocks.length === thinking.length ? blocks[thinking.indexOf(segment)] : undefined;
	return block === undefined ? blocks : [block];
}

/** The find bar's state and keys; the bar to draw (`null` while closed). */
export function useTranscriptFind(params: TranscriptFindParams): ReactNode {
	const { enabled } = params;
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	/** The query the search runs for: the field's value once typing has paused. */
	const [settled, setSettled] = useState("");
	const [caseSensitive, setCaseSensitive] = useState(false);
	const [current, setCurrent] = useState<FindMatch | null>(null);
	const [focusRequest, setFocusRequest] = useState(0);
	const [barFocused, setBarFocused] = useState(false);
	const barId = useId();
	const inputRef = useRef<HTMLInputElement | null>(null);
	const barRef = useRef<HTMLDivElement | null>(null);
	const returnFocus = useRef<HTMLElement | null>(null);
	const revealToken = useRef(0);
	const patternKey = useRef("");
	const painting = useRef<number | null>(null);
	const paintTimer = useRef<number | undefined>(undefined);
	const lastPaint = useRef(0);
	/** The match whose containers are held open, whether the reader closed one of them since its jump, and the keys seen open. */
	const held = useRef("");
	const userClosed = useRef(false);
	const seenOpen = useRef(new Set<string>());
	const latest = useRef(params);
	latest.current = params;

	const units = useMemo(() => open && enabled ? findUnitsOf(params.canonical, params.cwd, markdownShownText) : [], [open, enabled, params.canonical, params.cwd]);
	const pattern = useMemo(() => findPattern(settled, caseSensitive), [settled, caseSensitive]);
	const search = useMemo(() => searchUnits(units, pattern), [units, pattern]);
	const position = current === null ? -1 : positionOf(search, current);
	const state = useRef({ search, current, open });
	state.current = { search, current, open };

	/**
	 * Opens the tool group and the call output a match hides in (state the transcript keeps by key); `true` when it opened one. A block the
	 * reader collapsed by hand after the jump is left alone: a key seen open that is closed now was closed by the reader, since only this
	 * code opens them and nothing here closes them.
	 */
	const openContainers = useCallback((unit: FindUnit, segment: FindSegment | null): boolean => {
		const view = latest.current;
		let opened = false;
		for (const key of containerKeys(view, unit, segment)) {
			if (view.shown.get(key) === true) seenOpen.current.add(key);
			else if (seenOpen.current.has(key)) userClosed.current = true;
		}
		if (userClosed.current) return false;
		for (const key of containerKeys(view, unit, segment)) if (view.shown.get(key) !== true) { view.disclose(key, true); opened = true; }
		return opened;
	}, []);
	/** The current match's own containers are open again when its row is back (it scrolled out and in, or a repaint rebuilt it), unless the reader closed one. */
	const keepOpen = useCallback((): void => {
		const { search: now, current: match } = state.current;
		if (match === null) return;
		const id = `${match.id}:${match.occurrence}`;
		if (held.current !== id) { held.current = id; userClosed.current = false; seenOpen.current.clear(); }
		const unit = now.units.find(candidate => candidate.id === match.id);
		if (unit === undefined) return;
		const segment = segmentOf(unit, match.occurrence);
		openContainers(unit, segment);
		if (userClosed.current) return;
		const row = rowOf(latest.current.rootRef.current, unit.id);
		if (row !== null) for (const details of thinkingBlocks(row, unit, segment)) if (!details.open) details.open = true;
	}, [openContainers]);

	/** Paint every occurrence in the mounted rows and the current match over them. */
	const paint = useCallback((): void => {
		const root = latest.current.rootRef.current, { search: now, current: match, open: showing } = state.current;
		root?.querySelector("[data-find-current]")?.removeAttribute("data-find-current");
		if (!showing || root === null || now.pattern === null) { paintFind([], null); return; }
		keepOpen();
		const all: Range[] = [];
		let currentRange: Range | null = null, currentRow: Element | null = null;
		for (const row of root.querySelectorAll<HTMLElement>("[data-find-id]")) {
			if (row.parentElement?.closest("[data-find-id]") !== null) continue;
			const holdsCurrent = match !== null && row.dataset.findId === match.id;
			const room = MAX_PAINTED - all.length;
			// The current match's own range is made even past the cap; the others are painted until it is spent.
			const ranges = rangesOf(row, rowText(row), now.pattern, holdsCurrent ? Math.max(room, match.occurrence + 1) : Math.max(room, 0));
			if (room > 0) for (let index = 0; index < ranges.length && index < room; index++) all.push(ranges[index]!);
			if (holdsCurrent) { currentRow = row; currentRange = ranges[match.occurrence] ?? null; }
		}
		paintFind(all, currentRange);
		// A match whose text is not drawn (deep in a long output), or a page that cannot paint, still shows which row holds it.
		if (currentRow !== null && (currentRange === null || !canHighlight())) currentRow.setAttribute("data-find-current", "");
	}, [keepOpen]);
	/** `throttled`: a mutation-driven repaint (streaming output) runs at most once per `PAINT_INTERVAL`; a change of query or match paints on the next frame. */
	const schedulePaint = useCallback((throttled = false): void => {
		if (painting.current !== null || paintTimer.current !== undefined) return;
		const frame = (): void => { painting.current = requestAnimationFrame(() => { painting.current = null; lastPaint.current = performance.now(); paint(); }); };
		const wait = throttled ? PAINT_INTERVAL - (performance.now() - lastPaint.current) : 0;
		if (wait > 0) paintTimer.current = window.setTimeout(() => { paintTimer.current = undefined; frame(); }, wait);
		else frame();
	}, [paint]);

	/** Bring the match into view: load its row, open what hides it, scroll to its line. */
	const reveal = useCallback((match: FindMatch): void => {
		const token = ++revealToken.current;
		const { search: now } = state.current;
		const unit = now.units.find(candidate => candidate.id === match.id);
		const needle = now.pattern;
		if (unit === undefined || needle === null) return;
		const segment = segmentOf(unit, match.occurrence);
		held.current = `${match.id}:${match.occurrence}`;
		userClosed.current = false;
		seenOpen.current.clear();
		const hasThinking = segment?.part === "thinking";
		const first = latest.current;
		if (!first.rows.some(card => findIdOf(card) === unit.id)) {
			if (first.paged) first.showPage(unit.cardId); else first.pinTop(unit.cardId);
		}
		/** Opens the group and the call a match hides in. Each opening re-captures the reader's place, so the scroll is asked for again after it. */
		openContainers(unit, segment);
		latest.current.controllerRef.current?.reveal(unit.sources);
		let frames = 0, seen = 0;
		const tick = (): void => {
			if (revealToken.current !== token) return;
			frames++;
			if (frames > 1 && frames < REVEAL_FRAMES && openContainers(unit, segment)) {
				latest.current.controllerRef.current?.reveal(unit.sources);
				requestAnimationFrame(tick);
				return;
			}
			const row = rowOf(latest.current.rootRef.current, unit.id);
			if (row !== null) {
				seen++;
				const closed = hasThinking && !userClosed.current ? thinkingBlocks(row, unit, segment).filter(details => !details.open) : [];
				if (closed.length > 0) for (const details of closed) details.open = true;
				else {
					const target = rangesIn(rowText(row), needle, match.occurrence + 1)[match.occurrence] ?? null;
					if (target !== null || seen >= SETTLE_FRAMES) {
						// The row's top went a third of the way down; a match deep inside a tall row goes there instead, and never under the bar.
						const root = latest.current.rootRef.current, controller = latest.current.controllerRef.current, anchor = row.closest<HTMLElement>("[data-anchor-key]"), bar = barRef.current;
						if (target !== null && root !== null && controller !== null && anchor !== null) {
							const floor = bar === null ? 0 : bar.getBoundingClientRect().bottom - root.getBoundingClientRect().top + 12;
							controller.reveal(unit.sources, Math.round(Math.max(root.clientHeight / 3, floor) - (target.getBoundingClientRect().top - anchor.getBoundingClientRect().top)));
						}
						schedulePaint();
						return;
					}
				}
			}
			if (frames < REVEAL_FRAMES) requestAnimationFrame(tick);
		};
		requestAnimationFrame(tick);
	}, [schedulePaint, openContainers]);

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

	/**
	 * Both the page's own Ctrl+F and the host's keybinding (which VS Code forwards for the same press) end here, so a press that finds the field
	 * already focused changes nothing: it must not reselect text the reader has begun to type.
	 */
	const openFind = useCallback((): void => {
		if (state.current.open && inputRef.current !== null && document.activeElement === inputRef.current) return;
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
		clearFindCache();
		setOpen(false);
		setCurrent(null);
		setBarFocused(false);
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
			if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && isLetterKey(event, "f")) { event.preventDefault(); openFind(); return; }
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

	// While the bar has the focus (its field or one of its buttons) Escape belongs to it: the host's stop-turn key stays disarmed for that press.
	useEffect(() => {
		reportComposerPopupOpen("find", open && barFocused);
		return () => reportComposerPopupOpen("find", false);
	}, [open, barFocused]);

	// The query is searched once typing pauses; the field keeps the raw value meanwhile, and an empty query clears at once.
	useEffect(() => {
		if (query === settled) return;
		if (query === "") { setSettled(""); return; }
		const timer = setTimeout(() => setSettled(query), QUERY_DEBOUNCE_MS);
		return () => clearTimeout(timer);
	}, [query, settled]);

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
		const observer = new MutationObserver(() => schedulePaint(true));
		observer.observe(root, { childList: true, characterData: true, subtree: true });
		return () => observer.disconnect();
	}, [open, params.rootRef, schedulePaint]);
	// A block the reader closes by hand (a click, Esc inside it, the thinking toggle) is theirs from then on, until the next jump.
	useEffect(() => {
		const root = params.rootRef.current;
		if (!open || root === null) return;
		const onToggle = (event: Event): void => {
			const block = event.target;
			if (!(block instanceof HTMLDetailsElement) || block.open || !block.classList.contains("omp-thinking")) return;
			const match = state.current.current;
			if (match !== null && block.closest("[data-find-id]")?.getAttribute("data-find-id") === match.id) userClosed.current = true;
		};
		root.addEventListener("toggle", onToggle, true);
		return () => root.removeEventListener("toggle", onToggle, true);
	}, [open, params.rootRef]);
	useEffect(() => () => {
		revealToken.current++;
		if (painting.current !== null) cancelAnimationFrame(painting.current);
		clearTimeout(paintTimer.current);
		paintFind([], null);
		clearFindCache();
	}, []);

	if (!open || !enabled) return null;
	const notes = [
		params.olderCount > 0 ? `${params.olderCount.toLocaleString("en-US")} earlier messages are not loaded` : "",
		params.beforeReset ? "Messages before the context reset are not searched" : "",
	].filter(note => note !== "");
	const showNote = query.length > 0 && notes.length > 0;
	const noteId = `${barId}-note`;
	return (
		<div ref={barRef} className="omp-find" role="search" aria-label="Find in conversation" onFocus={() => setBarFocused(true)}
			onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setBarFocused(false); }}
			onKeyDown={event => {
				// Escape closes the bar from the field and from every button in it; the stop-turn key stays disarmed for the press.
				if (event.nativeEvent.isComposing || event.keyCode === 229) return;
				if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
			}}>
			<div className="omp-find-row">
				<input ref={inputRef} className="omp-find-input" type="text" aria-label="Find in conversation" aria-keyshortcuts="Enter F3 Shift+Enter Shift+F3 Alt+C Escape" aria-describedby={showNote ? noteId : undefined}
					placeholder="Find" spellCheck={false} autoComplete="off" value={query}
					onChange={event => setQuery(event.target.value)}
					onKeyDown={event => {
						if (event.nativeEvent.isComposing || event.keyCode === 229) return;
						if (event.key === "Enter") {
							event.preventDefault();
							// A key pressed before the query settled searches for what is in the field first.
							if (query !== settled) setSettled(query); else step(event.shiftKey ? -1 : 1);
						}
						else if (event.altKey && !event.ctrlKey && !event.metaKey && isLetterKey(event.nativeEvent, "c")) { event.preventDefault(); setCaseSensitive(value => !value); }
					}} />
				<span className="omp-find-status" role="status" aria-live="polite">{statusText(settled, search, position)}</span>
				<button type="button" className="omp-find-button" aria-label="Match case" aria-pressed={caseSensitive} aria-keyshortcuts="Alt+C" title="Match Case (Alt+C)" onClick={() => { setCaseSensitive(value => !value); inputRef.current?.focus(); }}><span className="codicon codicon-case-sensitive" aria-hidden="true" /></button>
				<button type="button" className="omp-find-button" aria-label="Previous match" aria-keyshortcuts="Shift+Enter Shift+F3" title="Previous Match (Shift+Enter)" aria-disabled={search.total === 0} onClick={() => step(-1)}><span className="codicon codicon-arrow-up" aria-hidden="true" /></button>
				<button type="button" className="omp-find-button" aria-label="Next match" aria-keyshortcuts="Enter F3" title="Next Match (Enter)" aria-disabled={search.total === 0} onClick={() => step(1)}><span className="codicon codicon-arrow-down" aria-hidden="true" /></button>
				<button type="button" className="omp-find-button" aria-label="Close find" aria-keyshortcuts="Escape" title="Close (Escape)" onClick={close}><span className="codicon codicon-close" aria-hidden="true" /></button>
			</div>
			{showNote && <div id={noteId} className="omp-find-note">{notes.join(". ")}.</div>}
		</div>
	);
}

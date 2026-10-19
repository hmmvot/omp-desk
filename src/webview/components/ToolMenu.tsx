/**
 * The `⋯` menu of an open tool card's output bar: a menu button, a `role="menu"` list of actions, and the status line a Copy
 * action says what it did on. A disabled item stays in the list, focusable, with the reason it does not apply written under it.
 * Arrow keys, Home and End move, Enter and Space act, `Esc` closes and returns focus to the button (the shared dismissible
 * layer), a press outside closes, Tab leaves.
 *
 * The list is `position: fixed` and placed against the viewport, not the card: a card clips its own box (`overflow: clip`) and
 * the transcript scrolls, so an absolute list at the bottom of either would be cut off. It opens below the button, above it when
 * only there is room, and scrolls inside itself when neither side fits it. It follows the button while the transcript scrolls.
 */
import type { KeyboardEvent, ReactNode } from "react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useDismissibleLayer } from "../lib/dismissible-layer";

/** Space kept between the list and the viewport edge, and between the list and its button. */
const EDGE = 4;
const GAP = 2;

/** Puts the open list beside its button: below, else above, else on the larger side with its own scroll; right-aligned, kept on screen. */
function placeMenu(list: HTMLElement, button: HTMLElement): void {
	const viewportWidth = document.documentElement.clientWidth, viewportHeight = document.documentElement.clientHeight;
	list.style.maxHeight = ""; list.style.overflowY = "";
	const anchor = button.getBoundingClientRect();
	const height = list.offsetHeight, width = list.offsetWidth;
	const below = viewportHeight - anchor.bottom - GAP - EDGE, above = anchor.top - GAP - EDGE;
	let top: number;
	if (height <= below) top = anchor.bottom + GAP;
	else if (height <= above) top = anchor.top - GAP - height;
	else {
		const room = Math.max(below, above);
		list.style.maxHeight = `${Math.max(0, Math.floor(room))}px`; list.style.overflowY = "auto";
		top = below >= above ? anchor.bottom + GAP : anchor.top - GAP - Math.min(height, room);
	}
	// A button scrolled to or past a viewport edge still gets a list wholly on screen.
	const shown = list.offsetHeight;
	list.style.top = `${Math.round(Math.max(EDGE, Math.min(top, viewportHeight - shown - EDGE)))}px`;
	list.style.left = `${Math.round(Math.max(EDGE, Math.min(anchor.right - width, viewportWidth - width - EDGE)))}px`;
}

export interface ToolMenuItem {
	readonly id: string;
	readonly label: string;
	readonly icon: string;
	/** Why the item does not apply; `null` for an item that does. */
	readonly disabled: string | null;
	/** Runs the action. A returned string is announced (what a Copy copied). */
	readonly run: () => void | string | Promise<void | string>;
}

export function ToolMenu({ items }: { items: readonly ToolMenuItem[] }): ReactNode {
	const [open, setOpen] = useState(false);
	const [status, setStatus] = useState<string | null>(null);
	const wrapperRef = useRef<HTMLSpanElement>(null);
	const buttonRef = useRef<HTMLButtonElement>(null);
	const listRef = useRef<HTMLDivElement>(null);
	const menuId = useId();
	/** Where focus goes when the list opens: the first item, or the last for ArrowUp on the button. */
	const entry = useRef<"first" | "last">("first");
	useDismissibleLayer({ open, inside: [wrapperRef], onDismiss: () => setOpen(false), returnFocusTo: buttonRef, owner: "tool-menu" });
	// Placed before the first paint, and again when the page resizes or anything scrolls (the transcript moves the button under the open list).
	useLayoutEffect(() => {
		if (!open) return;
		const place = (event?: Event): void => {
			const list = listRef.current, button = buttonRef.current;
			if (list === null || button === null || (event?.target instanceof Node && list.contains(event.target))) return;
			const rect = button.getBoundingClientRect();
			if (event !== undefined && (rect.bottom < 0 || rect.top > document.documentElement.clientHeight)) { setOpen(false); return; }
			placeMenu(list, button);
		};
		place();
		window.addEventListener("resize", place);
		window.addEventListener("scroll", place, { capture: true, passive: true });
		return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, { capture: true }); };
	}, [open]);
	useEffect(() => {
		if (!open) return;
		const entries = listRef.current?.querySelectorAll<HTMLElement>("[role=menuitem]");
		(entry.current === "last" ? entries?.[entries.length - 1] : entries?.[0])?.focus();
	}, [open]);
	useEffect(() => {
		if (status === null) return;
		const timer = setTimeout(() => setStatus(null), 2_400);
		return () => clearTimeout(timer);
	}, [status]);

	const choose = async (item: ToolMenuItem): Promise<void> => {
		if (item.disabled !== null) return;
		setOpen(false);
		buttonRef.current?.focus();
		const said = await item.run();
		if (typeof said === "string") setStatus(said);
	};
	const onButtonKey = (event: KeyboardEvent<HTMLButtonElement>): void => {
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			entry.current = event.key === "ArrowUp" ? "last" : "first";
			setOpen(true);
		}
	};
	const onListKey = (event: KeyboardEvent<HTMLDivElement>): void => {
		const entries = [...(listRef.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])];
		const at = entries.indexOf(document.activeElement as HTMLElement);
		const move = (to: number): void => { event.preventDefault(); entries[(to + entries.length) % entries.length]?.focus(); };
		switch (event.key) {
			case "ArrowDown": move(at + 1); return;
			case "ArrowUp": move(at - 1); return;
			case "Home": move(0); return;
			case "End": move(entries.length - 1); return;
			case "Tab": setOpen(false); return;
		}
	};
	return <span className="omp-tool-menu" ref={wrapperRef}>
		<button type="button" ref={buttonRef} className="omp-iconbtn" aria-label="More actions" title="More actions" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}
			onClick={event => { event.stopPropagation(); entry.current = "first"; setOpen(!open); }} onKeyDown={onButtonKey}>
			<span className="codicon codicon-ellipsis" aria-hidden="true" />
		</button>
		{open && <div id={menuId} className="omp-tool-menu-list" role="menu" aria-label="Tool actions" ref={listRef} onKeyDown={onListKey}>
			{items.map(item => <button key={item.id} type="button" role="menuitem" className="omp-tool-menu-item" data-menu-item={item.id} aria-disabled={item.disabled !== null ? true : undefined} title={item.disabled ?? undefined}
				onClick={() => { void choose(item); }}>
				<span className={`codicon codicon-${item.icon}`} aria-hidden="true" />
				<span className="omp-tool-menu-label">{item.label}{item.disabled !== null && <span className="omp-tool-menu-reason">{item.disabled}</span>}</span>
			</button>)}
		</div>}
		{status !== null && <span className="omp-sr-only" role="status">{status}</span>}
	</span>;
}

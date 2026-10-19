/**
 * The `⋯` menu of an open tool card's output bar: a menu button, a `role="menu"` list of actions, and the status line a Copy
 * action says what it did on. A disabled item stays in the list, focusable, with the reason it does not apply written under it.
 * Arrow keys, Home and End move, Enter and Space act, `Esc` closes and returns focus to the button (the shared dismissible
 * layer), a press outside closes, Tab leaves.
 */
import type { KeyboardEvent, ReactNode } from "react";
import { useEffect, useId, useRef, useState } from "react";
import { useDismissibleLayer } from "../lib/dismissible-layer";

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

/** The composer toolbar's Commands button and its searchable list (`lib/command-list.ts`). */
import type { KeyboardEvent, ReactNode } from "react";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ChatSlashCommand } from "../../chat/model";
import { useDismissibleLayer } from "../lib/dismissible-layer";
import { commandAvailability, commandRows, filterCommandRows, type CommandContext, type CommandRow } from "../lib/command-list";

/** The popup never grows past this, nor past the room above the composer. */
const MAX_POPUP_PX = 420;
const MIN_POPUP_PX = 140;

export function CommandsMenu({ commands, context, disabled, onPick }: {
	commands: readonly ChatSlashCommand[];
	context: CommandContext;
	disabled: boolean;
	/** Run one available row; the menu has already closed. */
	onPick(row: CommandRow): void;
}): ReactNode {
	const [open, setOpen] = useState(false);
	const [search, setSearch] = useState("");
	const [active, setActive] = useState(0);
	const [maxHeight, setMaxHeight] = useState(MAX_POPUP_PX);
	const wrapperRef = useRef<HTMLDivElement>(null);
	const buttonRef = useRef<HTMLButtonElement>(null);
	const popupRef = useRef<HTMLDivElement>(null);
	const searchRef = useRef<HTMLInputElement>(null);
	const pointerRef = useRef(false);
	const listId = useId();
	const rows = useMemo(() => commandRows(commands), [commands]);
	const shown = useMemo(() => filterCommandRows(rows, search), [rows, search]);
	const reasons = useMemo(() => shown.map(row => commandAvailability(row, context)), [shown, context]);
	const activeIndex = shown.length === 0 ? -1 : Math.min(active, shown.length - 1);

	const close = (): void => {
		setOpen(false);
		setSearch("");
		setActive(0);
	};
	useDismissibleLayer({ open, inside: [wrapperRef], onDismiss: close, returnFocusTo: buttonRef, owner: "commands" });
	useEffect(() => { if (disabled && open) close(); }, [disabled, open]);

	// The search box takes the focus as the list opens.
	useEffect(() => { if (open) searchRef.current?.focus(); }, [open]);
	// The popup opens upward from the composer card: it takes the room above it, never more than a comfortable list.
	useLayoutEffect(() => {
		if (!open) return;
		const fit = (): void => {
			const card = wrapperRef.current?.closest(".omp-composer");
			if (card instanceof HTMLElement) setMaxHeight(Math.max(MIN_POPUP_PX, Math.min(MAX_POPUP_PX, Math.floor(card.getBoundingClientRect().top - 14))));
		};
		fit();
		window.addEventListener("resize", fit);
		return () => window.removeEventListener("resize", fit);
	}, [open]);
	// Keyboard navigation keeps the active row inside the list's scrollport; a pointer never scrolls under itself.
	useLayoutEffect(() => {
		if (pointerRef.current) { pointerRef.current = false; return; }
		if (!open || activeIndex < 0) return;
		const option = document.getElementById(`${listId}-${activeIndex}`);
		const list = option?.parentElement;
		if (!option || !list) return;
		if (activeIndex === 0) list.scrollTop = 0;
		else if (option.offsetTop < list.scrollTop) list.scrollTop = option.offsetTop;
		else if (option.offsetTop + option.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = option.offsetTop + option.offsetHeight - list.clientHeight;
	}, [open, activeIndex, shown, listId]);

	const pick = (index: number): void => {
		const row = shown[index];
		if (row === undefined || reasons[index] !== null) return;
		close();
		onPick(row);
	};
	const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
		if (event.nativeEvent.isComposing) return;
		const last = shown.length - 1;
		switch (event.key) {
			case "ArrowDown":
			case "ArrowUp":
				event.preventDefault();
				if (last >= 0) setActive(event.key === "ArrowDown" ? (activeIndex + 1) % shown.length : (activeIndex <= 0 ? last : activeIndex - 1));
				return;
			case "Home":
			case "End":
				if (last >= 0 && search.length === 0) { event.preventDefault(); setActive(event.key === "Home" ? 0 : last); }
				return;
			case "Enter":
				event.preventDefault();
				pick(activeIndex);
				return;
			case "Tab":
				event.preventDefault();
				close();
				buttonRef.current?.focus();
				return;
		}
	};

	return (
		<div className="omp-commands" ref={wrapperRef}>
			<button
				type="button"
				ref={buttonRef}
				className="omp-btn omp-composer-commands"
				aria-label="Commands"
				aria-haspopup="dialog"
				aria-expanded={open}
				aria-controls={open ? `${listId}-popup` : undefined}
				disabled={disabled}
				title="Commands (or type / in the message box)"
				onClick={() => (open ? close() : setOpen(true))}
			>
				<span aria-hidden="true" className="codicon codicon-terminal-cmd" />
			</button>
			{open && (
				<div id={`${listId}-popup`} className="omp-commands-popup" role="dialog" aria-label="Commands" ref={popupRef} style={{ maxHeight }}>
					<input
						ref={searchRef}
						className="omp-input omp-commands-search"
						type="text"
						role="combobox"
						aria-label="Search commands"
						aria-autocomplete="list"
						aria-expanded
						aria-controls={listId}
						aria-activedescendant={activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined}
						placeholder="Search commands"
						spellCheck={false}
						value={search}
						onChange={event => { setSearch(event.target.value); setActive(0); }}
						onKeyDown={onKeyDown}
					/>
					<ul id={listId} role="listbox" aria-label="Commands" className="omp-commands-list">
						{shown.map((row, index) => {
							const reason = reasons[index]!;
							const firstOfGroup = index === 0 || shown[index - 1]!.group !== row.group;
							return [
								firstOfGroup && <li key={`group:${row.group}`} role="presentation" className="omp-commands-heading">{row.group === "gui" ? "With a VS Code UI" : "Run by OMP from chat text"}</li>,
								<li
									key={`${row.group}:${row.name}`}
									id={`${listId}-${index}`}
									role="option"
									aria-selected={index === activeIndex}
									aria-disabled={reason !== null ? true : undefined}
									data-group={row.group}
									className={`omp-commands-option${index === activeIndex ? " omp-commands-option--active" : ""}${reason !== null ? " omp-commands-option--disabled" : ""}`}
									title={reason ?? undefined}
									onMouseEnter={() => { pointerRef.current = true; setActive(index); }}
									onClick={() => pick(index)}
								>
									<span className="omp-slash-label">
										<strong>/{row.name}</strong>
										<span className="omp-native-badge">{row.source}</span>
										{row.gui !== null && <span className="omp-commands-gui codicon codicon-window" role="img" aria-label={`VS Code UI: ${row.gui.ui}`} title={row.gui.ui} />}
									</span>
									{row.description && <span className="omp-slash-description">{row.description}</span>}
									{row.inputHint && row.gui === null && <span className="omp-native-muted omp-slash-hint">{row.inputHint}</span>}
									{reason !== null && <span className="omp-commands-reason">{reason}</span>}
								</li>,
							];
						})}
						{shown.length === 0 && <li role="presentation" className="omp-commands-empty">No command matches.</li>}
					</ul>
					<div className="omp-commands-note">Terminal-only commands are not listed; switch the editor to Terminal to use them.</div>
				</div>
			)}
		</div>
	);
}

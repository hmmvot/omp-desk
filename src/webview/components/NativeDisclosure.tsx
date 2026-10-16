import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";

export interface NativeDisclosureProps { title: ReactNode; children: ReactNode; className?: string; initiallyOpen?: boolean; forceOpen?: { open: boolean; generation: number }; expanded?: boolean; onExpandedChange?: (expanded: boolean) => void }

/** Materialize large Markdown and archive bodies only on disclosure. */
export function NativeDisclosure({ title, children, className = "", initiallyOpen = false, forceOpen, expanded, onExpandedChange }: NativeDisclosureProps) {
	const [open, setOpen] = useState(initiallyOpen);
	const ref = useRef<HTMLDetailsElement | null>(null);
	const applied = useRef(forceOpen?.generation);
	// A global press (the thinking toggle) opens or closes this block once; the user's own clicks win afterwards.
	useEffect(() => {
		if (forceOpen === undefined || applied.current === forceOpen.generation) return;
		applied.current = forceOpen.generation;
		if (ref.current !== null) ref.current.open = forceOpen.open;
		setOpen(forceOpen.open);
	}, [forceOpen?.generation, forceOpen?.open]);
	return <details ref={ref} open={(expanded ?? initiallyOpen) || undefined} className={`omp-native-disclosure ${className}`} onToggle={event => { setOpen(event.currentTarget.open); if (expanded !== event.currentTarget.open) onExpandedChange?.(event.currentTarget.open); }} onKeyDown={event => {
		if (event.key !== "Escape" || !event.currentTarget.open || !event.currentTarget.contains(document.activeElement)) return;
		event.preventDefault(); event.stopPropagation(); event.currentTarget.querySelector<HTMLElement>(":scope > summary")?.focus(); event.currentTarget.open = false;
	}}>
		<summary>{title}</summary>
		{(expanded ?? open) ? children : null}
	</details>;
}

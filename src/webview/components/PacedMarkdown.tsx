import { useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { TextReveal, nextTextRevealFrame } from "../lib/text-reveal.ts";
import { Markdown } from "./Markdown.tsx";

export interface PacedMarkdownProps { text: string; streaming: boolean; bypass?: boolean }

/** Reveals a live message's appended text gradually. The canonical text is never altered; pacing is skipped for reduced motion, a hidden document or an active selection. */
export function PacedMarkdown({ text, streaming, bypass = false }: PacedMarkdownProps) {
	const reveal = useRef<TextReveal | null>(null);
	if (reveal.current === null) reveal.current = new TextReveal(text);
	const [visible, setVisible] = useState(text);
	const root = useRef<HTMLDivElement>(null);
	const selected = useRef(false);
	const frame = useRef<number | null>(null);
	const lastFrame = useRef<number | null>(null);
	const reduced = useRef<MediaQueryList | null>(null);

	useLayoutEffect(() => {
		const policy = reveal.current!;
		const cancel = () => { if (frame.current !== null) cancelAnimationFrame(frame.current); frame.current = null; lastFrame.current = null; };
		const paint = () => { if (!selected.current) setVisible(policy.visible); };
		const flush = () => { cancel(); policy.flush(); paint(); };
		const tick = (timestamp: number) => {
			frame.current = null;
			if (selected.current) return;
			const next = nextTextRevealFrame(lastFrame.current, timestamp);
			if (next !== null) { lastFrame.current = next.at; if (policy.advance(next.elapsed)) paint(); }
			if (policy.pending) frame.current = requestAnimationFrame(tick);
		};
		const schedule = () => { if (policy.pending && frame.current === null && !selected.current) frame.current = requestAnimationFrame(tick); };
		reduced.current = matchMedia("(prefers-reduced-motion: reduce)");
		const pace = () => streaming && !bypass && !document.hidden && !reduced.current!.matches;
		policy.retarget(text, pace());
		paint();
		if (pace()) schedule(); else flush();
		if (!streaming && !selected.current) return cancel;

		const selectionChanged = () => {
			const selection = document.getSelection();
			const owns = selection !== null && !selection.isCollapsed && root.current !== null &&
				(root.current.contains(selection.anchorNode) || root.current.contains(selection.focusNode));
			if (owns === selected.current) return;
			selected.current = owns;
			if (owns) cancel();
			else { policy.flush(); paint(); }
		};
		const environmentChanged = () => { if (!pace()) flush(); else schedule(); };
		document.addEventListener("selectionchange", selectionChanged);
		document.addEventListener("visibilitychange", environmentChanged);
		reduced.current.addEventListener("change", environmentChanged);
		return () => {
			cancel(); document.removeEventListener("selectionchange", selectionChanged);
			document.removeEventListener("visibilitychange", environmentChanged);
			reduced.current?.removeEventListener("change", environmentChanged);
		};
	}, [text, streaming, bypass]);

	return <div ref={root} className="omp-paced-slot" onPointerDown={() => {
		// Flush before the browser begins a native selection, then leave the selected DOM
		// untouched until `selectionchange` releases it.
		if (!selected.current && reveal.current!.flush()) flushSync(() => setVisible(reveal.current!.visible));
	}}><Markdown text={visible} /></div>;
}

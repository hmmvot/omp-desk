/**
 * The Wrap lines switch of an output pane: the one control of fenced code blocks ({@link WrapButton}) and the pane that carries it
 * for the output of a tool card ({@link WrapPane}). A pane never wraps until the reader asks; the choice is kept per pane for the
 * page's lifetime ({@link ../lib/code-wrap}), and the button shows only while a line is wider than its box, or while the pane wraps.
 */
import type { ReactNode } from "react";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { codeWrapKey, isCodeWrapped, setCodeWrapped, showsWrapToggle } from "../lib/code-wrap.ts";
import { CodeWrapScopeContext } from "./CodeWrapScope.tsx";

/** Whether the pane around the rows wraps its lines (the reader's choice): rows of a wrapped pane are not windowed, as with the card's own Wrap. */
export const OutputWrapContext = createContext(false);

export function WrapButton({ wrapped, onToggle }: { wrapped: boolean; onToggle: () => void }): ReactNode {
	return (
		<button type="button" className="omp-copy-button omp-code-wrap" aria-pressed={wrapped} aria-label="Wrap lines" title={wrapped ? "Wrap lines: on. Press to scroll sideways instead" : "Wrap lines: off. Press to wrap long lines"} onClick={onToggle}>
			<span className="codicon codicon-word-wrap" aria-hidden="true" />
		</button>
	);
}

/** What scrolls sideways inside a pane. The rows of a windowed list sit in the window, which scrolls for them. */
const SCROLLERS = "pre.omp-pre, pre.omp-native-output, pre.omp-native-code, .omp-window";

function overflowsSideways(box: HTMLElement): boolean {
	for (const element of box.querySelectorAll<HTMLElement>(SCROLLERS)) {
		if (element.tagName === "PRE" && element.closest(".omp-window") !== null) continue;
		if (showsWrapToggle(false, element.scrollWidth, element.clientWidth)) return true;
	}
	return false;
}

/**
 * Output text (rows, code, a diff) with its Wrap lines switch. `name` is the pane's place in its row: with the row's scope it names
 * the pane, so the choice outlives the row's unmount. Width is read where the browser has just laid the pane out: a resize of the pane and any
 * change of its content (streaming, colour arriving, a window of rows moving) schedule one measure per frame.
 */
export function WrapPane({ name, className, data, children }: { name: string; className?: string; data?: Readonly<Record<`data-${string}`, string | undefined>>; children: ReactNode }): ReactNode {
	const scope = useContext(CodeWrapScopeContext);
	const key = codeWrapKey(scope, name);
	const [wrapped, setWrapped] = useState(() => isCodeWrapped(key));
	const [overflows, setOverflows] = useState(false);
	const box = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const element = box.current;
		// While wrapped nothing is measured and the last answer stays, so the button does not blink away under the pointer when it unwraps.
		if (element === null || wrapped) return;
		let frame = 0;
		const measure = (): void => { frame = 0; setOverflows(overflowsSideways(element)); };
		const schedule = (): void => { if (frame === 0) frame = requestAnimationFrame(measure); };
		const resize = new ResizeObserver(schedule);
		resize.observe(element);
		const mutation = new MutationObserver(schedule);
		mutation.observe(element, { childList: true, subtree: true, characterData: true });
		measure();
		return () => { resize.disconnect(); mutation.disconnect(); if (frame !== 0) cancelAnimationFrame(frame); };
	}, [wrapped]);
	const toggle = (): void => {
		const next = !wrapped;
		setWrapped(next);
		setCodeWrapped(key, next);
	};
	return (
		<div ref={box} className={className === undefined ? "omp-wrap-pane" : `omp-wrap-pane ${className}`} data-wrapped={wrapped ? "" : undefined} {...data}>
			<OutputWrapContext.Provider value={wrapped}>{children}</OutputWrapContext.Provider>
			{(wrapped || overflows) && <div className="omp-code-actions"><WrapButton wrapped={wrapped} onToggle={toggle} /></div>}
		</div>
	);
}

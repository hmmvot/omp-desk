import type { ReactNode, RefObject } from "react";
import { useCallback, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { agentsSummaryText, fitAgentNames } from "../../chat/hud-summary";
import { guestTransport } from "../bridge";
import type { DetailTarget } from "../../protocol/detail-target";

/**
 * Opens a detail tab. Only a page on the host's own panel route can: a surviving bridge page keeps
 * its fixed message allow-list (which does not carry `omp:open-detail`), so its buttons are
 * disabled and say why.
 */
export function useDetailOpener(): { available: boolean; open: (target: DetailTarget) => void } {
	const route = useSyncExternalStore(guestTransport.onRouteChange, guestTransport.routeKind);
	const open = useCallback((target: DetailTarget) => {
		guestTransport.post(target.kind === "agent" ? { type: "omp:open-detail", kind: "agent", agentId: target.agentId } : { type: "omp:open-detail", kind: target.kind });
	}, []);
	return { available: route !== "bridge", open };
}

export const DETAIL_UNAVAILABLE_TEXT = "Reload the window to open detail tabs";

export interface HudHeaderProps {
	/** `TODO` or `Agents`. */
	name: string;
	/** The Codicon the same tool's transcript row uses (`todo` and `task`). */
	icon: string;
	summary: string;
	/**
	 * Names the summary lists after `head`: as many as the row's width holds are written out and the rest become `+N`.
	 * The tooltip and the accessible name never use `+N`: they are `head` and then `detail`, which lists every name.
	 */
	fit?: { head: string; names: readonly string[] };
	/** Facts the one-line summary leaves out, appended to the row's tooltip. */
	detail?: string;
	warn?: boolean;
	/** The one counter, with its full accessible name. */
	counter?: { text: string; title: string };
	expanded: boolean;
	controls: string;
	onToggle: () => void;
	/** The detail tab's button beside the toggle; a row with no detail tab gives `action` instead. */
	openLabel?: string;
	onOpen?: () => void;
	openAvailable?: boolean;
	/** A control beside the toggle (never inside it), in place of the detail-tab button. */
	action?: ReactNode;
}

/** The width a text takes in the font of `element`, from one shared canvas (no layout involved). */
let measuring: CanvasRenderingContext2D | null | undefined;
function textWidth(element: HTMLElement, text: string): number {
	measuring ??= document.createElement("canvas").getContext("2d");
	if (measuring === null) return text.length * 8;
	const style = getComputedStyle(element);
	measuring.font = style.font || `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
	return measuring.measureText(text).width;
}

/**
 * How many of `fit.names` the summary can write out. The room is the toggle's content box minus what its other
 * children take, so it does not depend on the text now shown: one measurement per change of the names, the text
 * or the row's size (a `ResizeObserver`), never per frame.
 */
function useFittedNames(fit: HudHeaderProps["fit"], toggle: RefObject<HTMLButtonElement | null>, summary: RefObject<HTMLSpanElement | null>): number {
	const total = fit?.names.length ?? 0;
	const [shown, setShown] = useState(total);
	const key = fit === undefined ? "" : `${fit.head}\u0000${fit.names.join("\u0000")}`;
	useLayoutEffect(() => {
		const button = toggle.current, line = summary.current;
		if (fit === undefined || button === null || line === null) { setShown(total); return; }
		const measure = (): void => {
			const style = getComputedStyle(button);
			const gap = Number.parseFloat(style.columnGap) || 0;
			const others = [...button.children].filter(child => child !== line);
			const used = others.reduce((sum, child) => sum + child.getBoundingClientRect().width, 0) + gap * others.length;
			const room = button.clientWidth - (Number.parseFloat(style.paddingLeft) || 0) - (Number.parseFloat(style.paddingRight) || 0) - used;
			setShown(fitAgentNames(fit.head, fit.names, Math.floor(room) - 1, text => textWidth(line, text)));
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(button);
		return () => observer.disconnect();
	}, [key]); // eslint-disable-line react-hooks/exhaustive-deps -- `fit` is read through its content key
	return Math.min(shown, total);
}

/** One tool-style row: a disclosure button, and beside it (never inside it) a button that opens the detail tab. */
export function HudHeader(props: HudHeaderProps): ReactNode {
	const toggle = useRef<HTMLButtonElement | null>(null);
	const summary = useRef<HTMLSpanElement | null>(null);
	const shown = useFittedNames(props.fit, toggle, summary);
	const text = props.fit === undefined ? props.summary : agentsSummaryText(props.fit.head, props.fit.names, shown);
	// Hidden names never reach the tooltip: with `fit` it is the counts, then one `Name: activity` line per running agent.
	const full = props.fit === undefined ? `${props.name}: ${props.summary}` : `${props.name}: ${props.fit.head}`;
	const tooltip = props.detail ? `${full}\n${props.detail}` : full;
	return (
		<div className="omp-hud-head">
			<button ref={toggle} type="button" className="omp-hud-toggle" aria-expanded={props.expanded} aria-controls={props.expanded ? props.controls : undefined} aria-label={props.fit === undefined ? undefined : tooltip.replaceAll("\n", "; ")} title={tooltip} onClick={props.onToggle}>
				<span className={`codicon codicon-chevron-${props.expanded ? "down" : "right"}`} aria-hidden="true" />
				<span className={`codicon codicon-${props.icon}`} aria-hidden="true" />
				<span className="omp-hud-label">{props.name}</span>
				<span ref={summary} className={`omp-hud-summary${props.warn === true ? " omp-hud-summary--warn" : ""}`}>{text}</span>
				{props.counter !== undefined && <span className="omp-hud-counter" title={props.counter.title}><span aria-hidden="true">{props.counter.text}</span><span className="omp-sr-only">{props.counter.title}</span></span>}
			</button>
			{props.action ?? (
				<button type="button" className="omp-hud-open" aria-label={props.openAvailable ? props.openLabel : `${props.openLabel} (${DETAIL_UNAVAILABLE_TEXT})`} title={props.openAvailable ? props.openLabel : DETAIL_UNAVAILABLE_TEXT} disabled={props.openAvailable !== true} onClick={props.onOpen}>
					<span className="codicon codicon-link-external" aria-hidden="true" />
				</button>
			)}
		</div>
	);
}

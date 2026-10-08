import type { ReactNode } from "react";
import { useCallback, useSyncExternalStore } from "react";
import { guestTransport } from "../bridge";
import type { DetailTarget } from "../detail-target";

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
	warn?: boolean;
	/** The one counter, with its full accessible name. */
	counter?: { text: string; title: string };
	expanded: boolean;
	controls: string;
	onToggle: () => void;
	openLabel: string;
	onOpen: () => void;
	openAvailable: boolean;
}

/** One tool-style row: a disclosure button, and beside it (never inside it) a button that opens the detail tab. */
export function HudHeader(props: HudHeaderProps): ReactNode {
	return (
		<div className="omp-hud-head">
			<button type="button" className="omp-hud-toggle" aria-expanded={props.expanded} aria-controls={props.expanded ? props.controls : undefined} title={`${props.name}: ${props.summary}`} onClick={props.onToggle}>
				<span className={`codicon codicon-chevron-${props.expanded ? "down" : "right"}`} aria-hidden="true" />
				<span className={`codicon codicon-${props.icon}`} aria-hidden="true" />
				<span className="omp-hud-label">{props.name}</span>
				<span className={`omp-hud-summary${props.warn === true ? " omp-hud-summary--warn" : ""}`}>{props.summary}</span>
				{props.counter !== undefined && <span className="omp-hud-counter" title={props.counter.title}><span aria-hidden="true">{props.counter.text}</span><span className="omp-sr-only">{props.counter.title}</span></span>}
			</button>
			<button type="button" className="omp-hud-open" aria-label={props.openAvailable ? props.openLabel : `${props.openLabel} (${DETAIL_UNAVAILABLE_TEXT})`} title={props.openAvailable ? props.openLabel : DETAIL_UNAVAILABLE_TEXT} disabled={!props.openAvailable} onClick={props.onOpen}>
				<span className="codicon codicon-link-external" aria-hidden="true" />
			</button>
		</div>
	);
}

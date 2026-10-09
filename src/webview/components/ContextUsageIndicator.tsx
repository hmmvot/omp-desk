/** Project-owned DOM/SVG implementation of the Paseo context-ring visual design. */
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useDismissibleLayer } from "../lib/dismissible-layer";
import { contextTokenLabel, quotaWindowLabel, sessionCostLabel } from "../lib/context-indicator";
import { fmtPercent } from "../lib/format";
import type { FooterQuotaWindow } from "../footer-metadata";

const CIRCUMFERENCE = 2 * Math.PI * 6;

export function ContextUsageIndicator({ tokens, contextWindow, percent, cost, windows, quotaTooltip, onCompact, onShake, maintenanceBlocked, compactHint }: {
	tokens: number | null | undefined;
	contextWindow: number | null;
	percent: number | null | undefined;
	cost: number | undefined;
	windows: readonly FooterQuotaWindow[];
	quotaTooltip: string;
	/** Ask the host to compact the conversation (it asks for the mode, and for a summary the instructions, first). */
	onCompact?: () => void;
	/** Ask the host to shake heavy content out of the context (it asks for the mode first). */
	onShake?: () => void;
	/** Why Compact and Shake are unavailable now (a maintenance pass already running, a read-only page), or `null`. */
	maintenanceBlocked?: string | null;
	/** What Compact will do when it differs from the usual: during a turn it interrupts and then resumes it. */
	compactHint?: string;
}) {
	const [open, setOpen] = useState(false);
	const [now, setNow] = useState(Date.now);
	const show = (): void => { setNow(Date.now()); setOpen(true); };
	const tooltipId = useId();
	const wrapperRef = useRef<HTMLDivElement>(null);
	const popoverRef = useRef<HTMLDivElement>(null);
	const [shift, setShift] = useState(0);
	const used = percent != null && Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : null;
	const usedLabel = used === null ? "Usage unavailable" : `${fmtPercent(used)} used`;
	const costLabel = sessionCostLabel(cost);
	useEffect(() => {
		if (!open || !windows.some(window => window.resetsAt !== null)) return;
		setNow(Date.now());
		const timer = setInterval(() => setNow(Date.now()), 60_000);
		return () => clearInterval(timer);
	}, [open, windows]);
	useLayoutEffect(() => {
		if (!open || !wrapperRef.current || !popoverRef.current) return;
		const wrapper = wrapperRef.current;
		const popover = popoverRef.current;
		const align = (): void => {
			const preferredLeft = wrapper.getBoundingClientRect().right - popover.offsetWidth;
			const left = Math.max(12, Math.min(preferredLeft, window.innerWidth - popover.offsetWidth - 12));
			setShift(left - preferredLeft);
		};
		align();
		const observer = new ResizeObserver(align);
		observer.observe(popover);
		if (wrapper.parentElement) observer.observe(wrapper.parentElement);
		window.addEventListener("resize", align);
		return () => { observer.disconnect(); window.removeEventListener("resize", align); };
	}, [open]);
	// Outside press, Escape and window blur follow the shared chat-layer rule. Hover can open the popover
	// while focus stays in the textarea, so Escape keeps focus where it is (no `returnFocusTo`).
	useDismissibleLayer({ open, inside: [wrapperRef], onDismiss: () => setOpen(false), owner: "context" });
	return <div className="omp-context-indicator" ref={wrapperRef}
		onPointerEnter={show}
		onPointerLeave={event => { if (!event.currentTarget.contains(document.activeElement)) setOpen(false); }}
		onBlur={event => { if (!event.currentTarget.matches(":hover") && !event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
		<button type="button" className="omp-context-trigger"
			aria-label={`Context window ${usedLabel.toLowerCase()}`} aria-expanded={open}
			aria-controls={tooltipId} aria-describedby={open ? tooltipId : undefined}
			onFocus={show} onClick={show}>
			<svg aria-hidden="true" width="14" height="14" viewBox="0 0 14 14" fill="none">
				<circle className="omp-context-track" cx="7" cy="7" r="6" strokeWidth="2" />
				{used !== null && <circle className={`omp-context-progress${used > 90 ? " omp-context-progress--critical" : used >= 70 ? " omp-context-progress--warning" : ""}`}
					cx="7" cy="7" r="6" strokeWidth="2" strokeLinecap="butt" transform="rotate(-90 7 7)"
					strokeDasharray={CIRCUMFERENCE} strokeDashoffset={CIRCUMFERENCE * (1 - used / 100)} />}
			</svg>
			{used !== null && <span className="omp-context-percent" aria-hidden="true">{fmtPercent(used)}</span>}
		</button>
		{open && <div className="omp-context-popover" id={tooltipId} role={onCompact === undefined ? "tooltip" : "group"} aria-label={onCompact === undefined ? undefined : "Context window"} ref={popoverRef} style={{ transform: `translateX(${shift}px)` }}>
			<strong>Context window</strong>
			<div>{usedLabel}</div>
			<div>{contextTokenLabel(tokens)} / {contextTokenLabel(contextWindow)} tokens</div>
			{costLabel !== null && <div className="omp-context-cost">{costLabel}</div>}
			{windows.map(window => <div className="omp-context-quota" key={window.label}
				aria-label={window.resetsAt === null ? undefined : `${quotaWindowLabel(window, now)}; resets at ${new Date(window.resetsAt).toLocaleString()}`}
				title={window.resetsAt === null ? quotaTooltip : `Resets at ${new Date(window.resetsAt).toLocaleString()}${quotaTooltip ? `\n\n${quotaTooltip}` : ""}`}>
				{quotaWindowLabel(window, now)}
			</div>)}
			{(onCompact !== undefined || onShake !== undefined) && <div className="omp-context-actions">
				{onCompact !== undefined && <button type="button" className="omp-btn omp-context-compact" disabled={maintenanceBlocked != null}
					title={maintenanceBlocked ?? compactHint ?? "Free context: archive the earlier conversation onto images (snapcompact) or summarize it"}
					onClick={() => { setOpen(false); onCompact(); }}>
					<span aria-hidden="true" className="codicon codicon-fold" />Compact…
				</button>}
				{onShake !== undefined && <button type="button" className="omp-btn omp-context-shake" disabled={maintenanceBlocked != null}
					title={maintenanceBlocked ?? "Drop heavy content from the context: tool results and large blocks (elide), images or thinking"}
					onClick={() => { setOpen(false); onShake(); }}>
					<span aria-hidden="true" className="codicon codicon-clear-all" />Shake…
				</button>}
			</div>}
		</div>}
	</div>;
}

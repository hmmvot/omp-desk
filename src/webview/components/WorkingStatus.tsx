import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import type { BackgroundWait } from "../../chat/background-wait";
import type { MaintenanceState } from "../../chat/events";
import { fmtDuration } from "../../shared/format";
import { useSecondTick } from "../lib/live-clock";

/** A permanent final row: only its text changes, never its height or scroll identity. */
export function WorkingStatus({ working, intent, waitingForAnswer, maintenance, startedAt, backgroundWait }: {
	working: boolean;
	intent?: string | null;
	waitingForAnswer?: boolean;
	maintenance?: MaintenanceState | null;
	startedAt?: number | null;
	/** Only background work keeps the turn open: its sentence and the time the wait began replace the intent and the turn timer. */
	backgroundWait?: BackgroundWait | null;
}): ReactNode {
	const waiting = backgroundWait != null && working && !waitingForAnswer && maintenance?.status !== "working";
	const text = waitingForAnswer && working ? "Waiting for your answer"
		: maintenance?.status === "working" ? `${maintenance.action} · ${maintenance.reason ?? "compacting context"}…`
		: waiting ? backgroundWait.text
		: working ? intent || "Working" : "";
	const since = waiting ? backgroundWait.since : startedAt;
	useSecondTick(working && since != null);
	const [announcement, setAnnouncement] = useState("");
	const latest = useRef(text);
	latest.current = text;
	const announcedAt = useRef(0);
	const timer = useRef<number | undefined>(undefined);
	useEffect(() => {
		if (!text) {
			window.clearTimeout(timer.current);
			timer.current = undefined;
			setAnnouncement("");
			return;
		}
		if (timer.current !== undefined) return;
		timer.current = window.setTimeout(() => {
			timer.current = undefined;
			announcedAt.current = Date.now();
			setAnnouncement(latest.current);
		}, Math.max(0, 1_000 - (Date.now() - announcedAt.current)));
	}, [text]);
	useEffect(() => () => { window.clearTimeout(timer.current); }, []);
	return <div className="omp-working-status" role="status" aria-live="polite" aria-atomic="true">
		<span className="omp-working-status-text" aria-hidden="true" title={text}>{text}</span>
		{working && since != null && <span className="omp-working-status-elapsed" aria-hidden="true">{fmtDuration(Math.max(0, Date.now() - since))}</span>}
		<span className="omp-sr-only">{announcement}</span>
	</div>;
}

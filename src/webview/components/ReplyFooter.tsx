import { useEffect, useState } from "react";
import type { ReplyFooter as ReplyFooterData } from "../../chat/reply-turns.ts";
import { formatTurnUsage } from "../../chat/reply-usage.ts";
import { servedModelLabel, type ServedModelMismatch } from "../../chat/served-model.ts";
import { fmtDuration } from "../../shared/format";

export function ReplyFooter({ reply, served = [] }: { reply: ReplyFooterData; served?: readonly ServedModelMismatch[] }) {
	const [copyStatus, setCopyStatus] = useState<string | null>(null);
	useEffect(() => setCopyStatus(null), [reply.id, reply.text]);
	const duration = reply.durationMs === null ? "duration unavailable" : fmtDuration(reply.durationMs);
	const timingExplanation = reply.durationKind === "response" ? "Final model request; total turn duration unavailable" : reply.durationKind === "history" ? "History user→reply interval; historical steer/follow-up attribution is unavailable" : reply.durationKind === "turn" ? "Observed agent invocation" : "No attributable start and completion timing is available";
	const time = reply.endTime ?? reply.startedTime;
	const localTime = time === null ? "time unavailable" : `${reply.endTime === null ? "started " : ""}${new Date(time).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
	// Totals of the whole turn, as the terminal UI: only the span of the prompt to the answer is the turn's own time, so a response-only duration stays out of the tooltip.
	const usage = reply.usage === null ? null : formatTurnUsage(reply.usage, reply.durationKind === "turn" || reply.durationKind === "history" ? duration : undefined);
	return <footer className="omp-reply-footer" aria-label="Finished reply">
		<span title={timingExplanation}>{duration}</span>
		{usage !== null && <span className="omp-reply-usage" title={usage.title}>{usage.text}</span>}
		<span className="omp-reply-time" title={reply.endTime === null ? "Model request started; completion time unavailable" : "Reply completed"}>{localTime}</span>
		<button type="button" className="omp-reply-copy" disabled={reply.imageOnly} aria-label="Copy reply" title={reply.imageOnly ? "Image-only reply: no text to copy" : "Copy reply"} onClick={async () => {
			try { await navigator.clipboard.writeText(reply.text); setCopyStatus("Copied"); }
			catch { setCopyStatus("Copy failed. Select the reply text to copy it manually."); }
		}}><i className="codicon codicon-copy" aria-hidden="true" /></button>
		{reply.imageOnly && <span>No text to copy</span>}
		{copyStatus !== null && <span role="status">{copyStatus}</span>}
		{served.map(mismatch => <span key={`${mismatch.provider}\0${mismatch.requested}\0${mismatch.served}`} className="omp-served-model" role="note" title="The provider answered with a different model than the one requested">
			<i className="codicon codicon-warning" aria-hidden="true" />{servedModelLabel(mismatch)}
		</span>)}
	</footer>;
}

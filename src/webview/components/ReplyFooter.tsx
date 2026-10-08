import { useEffect, useState } from "react";
import type { ReplyFooter as ReplyFooterData } from "../../chat/reply-turns.ts";
import { fmtDuration } from "../lib/format";

export function ReplyFooter({ reply }: { reply: ReplyFooterData }) {
	const [copyStatus, setCopyStatus] = useState<string | null>(null);
	useEffect(() => setCopyStatus(null), [reply.id, reply.text]);
	const duration = reply.durationMs === null ? "duration unavailable" : fmtDuration(reply.durationMs);
	const timingExplanation = reply.durationKind === "response" ? "Final model request; total turn duration unavailable" : reply.durationKind === "history" ? "History user→reply interval; historical steer/follow-up attribution is unavailable" : reply.durationKind === "turn" ? "Observed agent invocation" : "No attributable start and completion timing is available";
	const time = reply.endTime ?? reply.startedTime;
	const localTime = time === null ? "time unavailable" : `${reply.endTime === null ? "started " : ""}${new Date(time).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
	return <footer className="omp-reply-footer" aria-label="Finished reply">
		<span title={timingExplanation}>{duration}</span>
		<span title={reply.endTime === null ? "Model request started; completion time unavailable" : "Reply completed"}>{localTime}</span>
		<button type="button" className="omp-reply-copy" disabled={reply.imageOnly} title={reply.imageOnly ? "Image-only reply: no text to copy" : "Copy canonical reply Markdown"} onClick={async () => {
			try { await navigator.clipboard.writeText(reply.text); setCopyStatus("Copied"); }
			catch { setCopyStatus("Copy failed. Select the reply text to copy it manually."); }
		}}><i className="codicon codicon-copy" aria-hidden="true" />Copy</button>
		{reply.imageOnly && <span>No text to copy</span>}
		{copyStatus !== null && <span role="status">{copyStatus}</span>}
	</footer>;
}

import type { ReactNode } from "react";
import { useEffect, useState } from "react";

/**
 * A hover Copy button that copies exactly `text` (source text, never rendered HTML) and says briefly whether it
 * worked. Used on fenced code blocks and on the user's own messages.
 */
export function CopyButton({ text, label, className = "" }: { text: string; label: string; className?: string }): ReactNode {
	const [status, setStatus] = useState<"copied" | "failed" | null>(null);
	useEffect(() => {
		if (status === null) return;
		const timer = setTimeout(() => setStatus(null), 1_500);
		return () => clearTimeout(timer);
	}, [status]);
	const title = status === "copied" ? "Copied" : status === "failed" ? "Copy failed. Select the text to copy it manually." : label;
	return (
		<button type="button" className={`omp-copy-button ${className}`} aria-label={label} title={title} onClick={async event => {
			event.stopPropagation();
			try { await navigator.clipboard.writeText(text); setStatus("copied"); }
			catch { setStatus("failed"); }
		}}>
			<span className={`codicon codicon-${status === "copied" ? "check" : status === "failed" ? "warning" : "copy"}`} aria-hidden="true" />
			{status !== null && <span className="omp-copy-status" role="status">{status === "copied" ? "Copied" : "Copy failed"}</span>}
		</button>
	);
}

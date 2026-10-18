import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import type { AssistantMessage } from "../../chat/messages.ts";
import { copyableError, errorStatusOf, isLongError } from "../../chat/provider-error.ts";
import { openModelPicker, useModelPickerAvailable } from "../lib/model-picker.ts";

/**
 * A failed request, as the terminal UI draws it: the error with its HTTP status chip, the provider's message once (cut to a few
 * lines when it is long, until the reader asks for all of it), and the ways forward: Copy error, Switch model and Retry.
 * Switch model and Retry belong to the newest failed reply of an idle session, where `retry` is given; an earlier failure keeps
 * Copy error only.
 */
export function ProviderErrorFrame({ message, retry, expanded, onExpandedChange }: {
	message: AssistantMessage;
	/** The Retry button, present only on the failed last reply while idle. */
	retry: ReactNode;
	expanded: boolean;
	onExpandedChange(expanded: boolean): void;
}): ReactNode {
	const status = errorStatusOf(message);
	const body = message.errorMessage;
	const long = body !== undefined && isLongError(body);
	const clamped = long && !expanded;
	const [copied, setCopied] = useState<"copied" | "failed" | null>(null);
	useEffect(() => {
		if (copied === null) return;
		const timer = setTimeout(() => setCopied(null), 2_000);
		return () => clearTimeout(timer);
	}, [copied]);
	const pickerAvailable = useModelPickerAvailable();
	return <>
		<div className={`omp-error omp-turn-error${clamped ? " omp-turn-error--clamped" : ""}`} role="status">
			<strong>Provider error</strong>
			{status !== undefined && <span className="omp-turn-error-status" title={`The provider answered HTTP ${status}`}>{status}</span>}
			{body && <span className="omp-turn-error-body">{body}</span>}
		</div>
		<div className="omp-turn-error-actions">
			{long && <button type="button" className="omp-error-action" aria-expanded={expanded} title={expanded ? "Show the first lines of the error only" : "Show the whole error"} onClick={() => onExpandedChange(!expanded)}>
				<span className={`codicon codicon-chevron-${expanded ? "up" : "down"}`} aria-hidden="true" />{expanded ? "Show less" : "Show all"}
			</button>}
			<button type="button" className="omp-error-action omp-error-copy" title="Copy the error text" onClick={async () => {
				try { await navigator.clipboard.writeText(copyableError(message)); setCopied("copied"); }
				catch { setCopied("failed"); }
			}}>
				<span className={`codicon codicon-${copied === "copied" ? "check" : copied === "failed" ? "warning" : "copy"}`} aria-hidden="true" />Copy error
			</button>
			{copied !== null && <span className="omp-turn-error-copied" role="status">{copied === "copied" ? "Copied" : "Copy failed. Select the text to copy it manually."}</span>}
			{retry !== null && retry !== false && <button type="button" className="omp-error-action omp-error-switch-model" disabled={!pickerAvailable} title={pickerAvailable ? "Pick another model for this session, then Retry" : "The model cannot be changed now"} onClick={() => { openModelPicker(); }}>
				<span className="codicon codicon-arrow-swap" aria-hidden="true" />Switch model
			</button>}
			{retry}
		</div>
	</>;
}

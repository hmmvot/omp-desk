import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import type { ChatModel } from "../../chat/model";

/**
 * OMP extension `setWidget` blocks at their placement, one block per key with every line kept, as the TUI draws
 * them above or below its editor. Text only: lines are bounded by the model and never become markup.
 */
export function ExtensionWidgets({ snapshot, placement }: { snapshot: ChatModel; placement: "aboveEditor" | "belowEditor" }): ReactNode {
	const blocks = [...snapshot.widgets].filter(([, widget]) => widget.placement === placement);
	if (blocks.length === 0) return null;
	return (
		<div className={`omp-extension-widgets omp-extension-widgets--${placement}`} aria-label="Extension status">
			{blocks.map(([key, widget]) => (
				<div key={key} className="omp-extension-widget" data-widget-key={key}>
					{widget.lines.map((line, index) => <div key={index} className="omp-extension-widget-line">{line}</div>)}
				</div>
			))}
		</div>
	);
}

/**
 * The latest informational or warning `notify` of an OMP extension, until dismissed or replaced. Errors are not
 * here: the host shows them as VS Code error messages.
 */
export function ExtensionNoticeLine({ snapshot }: { snapshot: ChatModel }): ReactNode {
	const notice = snapshot.extensionNotice;
	const [dismissed, setDismissed] = useState<number | null>(null);
	useEffect(() => { setDismissed(null); }, [notice?.id]);
	if (notice === null || dismissed === notice.id) return null;
	return (
		<div className={`omp-extension-notice omp-extension-notice--${notice.level}`} role="status">
			<span className={`codicon codicon-${notice.level === "warning" ? "warning" : "info"}`} aria-hidden="true" />
			<span className="omp-extension-notice-text">{notice.message}</span>
			<button type="button" className="omp-btn" aria-label="Dismiss notice" title="Dismiss" onClick={() => setDismissed(notice.id)}>
				<span className="codicon codicon-close" aria-hidden="true" />
			</button>
		</div>
	);
}

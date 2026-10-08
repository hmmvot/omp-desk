import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ChatModel } from "../../chat/model";
import type { ChatQueuedRef } from "../chat-messages";
import type { ChatClient } from "../lib/chat-client";
import { chatWritable } from "../lib/chat-client";
import { offerQueuedForEditing } from "../lib/queue-restore";
import { queueNotice, queueRows, queueSummary, queueWindow, restoredEntries, type QueueNotice, type QueueRow } from "../lib/queue-view";

function subscribeViewport(notify: () => void): () => void {
	window.addEventListener("resize", notify);
	return () => window.removeEventListener("resize", notify);
}
const viewportHeight = (): number => window.innerHeight;

const NOT_WRITABLE = "This conversation is not accepting input right now.";

/**
 * The queued-messages row, directly above the composer in the bottom block: OMP's queue readback, one line
 * per pending message (steering, then follow-up), each with Edit and Remove, and Edit all in the header.
 *
 * It lists only what the host read back from OMP (`get_state.queuedMessages`, `queue_update`) and changes
 * the queue only through {@link ChatClient.removeQueued}, whose per-item answer decides what the row reports:
 * an Edit puts a message in the composer only when OMP removed it, and a message OMP had already delivered is
 * reported as sent. The row is ordinary flow in the dock, so the transcript's bottom anchor absorbs its
 * height like the composer's.
 */
export function QueuedMessages({ client, model }: { client: ChatClient; model: ChatModel }): ReactNode {
	const height = useSyncExternalStore(subscribeViewport, viewportHeight);
	const [busy, setBusy] = useState(false);
	const [notice, setNotice] = useState<QueueNotice | null>(null);
	const busyRef = useRef(false);
	const mountedRef = useRef(true);
	const listRef = useRef<HTMLUListElement | null>(null);
	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
		};
	}, []);

	const rows = queueRows(model.state?.queuedMessages);
	const writable = chatWritable(model);
	const unlisted = model.state?.queuedMessages?.unlisted ?? 0;

	const run = useCallback(
		async (purpose: "cancel" | "edit", items: readonly ChatQueuedRef[]): Promise<void> => {
			if (busyRef.current || items.length === 0) return;
			busyRef.current = true;
			setBusy(true);
			setNotice(null);
			const outcome = await client.removeQueued(purpose, items);
			// Messages OMP handed back are the user's: they reach the composer even if this row went away meanwhile.
			if (purpose === "edit" && outcome.ok) offerQueuedForEditing(restoredEntries(outcome.results));
			busyRef.current = false;
			if (!mountedRef.current) return;
			setBusy(false);
			setNotice(queueNotice(purpose, outcome));
			if (purpose === "cancel") queueMicrotask(() => listRef.current?.querySelector<HTMLButtonElement>("button")?.focus());
		},
		[client],
	);

	if (rows.length === 0 && unlisted === 0 && notice === null) return null;
	const { shown, hidden } = queueWindow(rows.length, height);
	const disabled = busy || !writable;
	const why = writable ? undefined : NOT_WRITABLE;
	const refs = (list: readonly QueueRow[]): ChatQueuedRef[] => list.map(row => ({ queue: row.queue, text: row.text }));

	return (
		<section className="omp-queue" aria-label="Queued messages">
			<div className="omp-queue-head">
				<span className="omp-queue-title">
					<span className="codicon codicon-list-ordered" aria-hidden="true" />
					<span className="omp-hud-label">Queued</span>
					<span className="omp-hud-summary" title={unlisted > 0 ? "Pending messages that are too many or too large to list stay queued; they cannot be edited or removed here" : undefined}>{queueSummary(rows, unlisted)}</span>
				</span>
				{rows.length > 0 && (
					<button type="button" className="omp-queue-all" disabled={disabled} title={why ?? "Move every queued message into the composer"} onClick={() => void run("edit", refs(rows))}>
						<span className="codicon codicon-edit" aria-hidden="true" />
						<span>Edit all</span>
					</button>
				)}
			</div>
			{rows.length > 0 && (
				<ul ref={listRef} className="omp-hud-rows omp-queue-rows" aria-label="Queued messages">
					{rows.slice(0, shown).map((row, index) => (
						<li key={`${row.queue}:${index}:${row.text}`} className={`omp-queue-item omp-queue-item--${row.queue}`}>
							{model.state?.queuedMessages?.steering.length !== 0 && <span className="omp-queue-kind" title={row.queue === "steering" ? "Steering: injected into the running turn" : "Follow-up: sent after the turn ends"}>{row.label}</span>}
							<span className="omp-queue-text" title={row.title}>{row.preview}</span>
							<button type="button" className="omp-queue-action omp-queue-edit" disabled={disabled} aria-label={`Edit queued ${row.label.toLowerCase()} message: ${row.preview}`} title={why ?? "Edit: move it into the composer"} onClick={() => void run("edit", refs([row]))}>
								<span className="codicon codicon-edit" aria-hidden="true" />
							</button>
							<button type="button" className="omp-queue-action omp-queue-remove" disabled={disabled} aria-label={`Remove queued ${row.label.toLowerCase()} message: ${row.preview}`} title={why ?? "Remove from the queue"} onClick={() => void run("cancel", refs([row]))}>
								<span className="codicon codicon-close" aria-hidden="true" />
							</button>
						</li>
					))}
					{hidden > 0 && (
						<li className="omp-queue-item omp-queue-more" title="Edit all moves every queued message, including these, into the composer">+{hidden} more</li>
					)}
				</ul>
			)}
			{notice !== null && (
				<div className={`omp-queue-status omp-queue-status--${notice.tone}`} role="status" title={notice.detail === undefined ? notice.text : `${notice.text}\n\n${notice.detail}`}>
					<span className="codicon codicon-warning" aria-hidden="true" />
					<span className="omp-queue-status-text">{notice.text}</span>
					<button type="button" className="omp-queue-action" aria-label="Dismiss" title="Dismiss" onClick={() => setNotice(null)}>
						<span className="codicon codicon-close" aria-hidden="true" />
					</button>
				</div>
			)}
		</section>
	);
}

/** The folder-shell title stays compact; its live cleanup verdict belongs in a tooltip. */

import type { PtyHandle, PtyHandleEvent } from "./pty-client.ts";
import type { PtyOwnerStopState, PtyOwnerStopStatus } from "./pty-protocol.ts";

export function shellEditorTitle(label: string): string {
	return `Terminal: ${label}`;
}

export function shellCleanupDescription(state: PtyOwnerStopState | null | undefined): string {
	if (state === null || state === undefined) return "Automatic cleanup status is not available yet.";
	return state === "disarmed" || state === "not-applicable"
		? "No automatic cleanup. Close the terminal to choose whether to stop it."
		: "Closing all windows of the owning VS Code instance triggers best-effort terminal cleanup.";
}

/** The slice of one attached broker a title watcher observes. */
export type ShellOwnerStopSource = Pick<PtyHandle, "statusValue" | "subscribe">;

/** The verdict one pushed event carries, or `null` for an event that is not about it. */
function pushedOwnerStop(event: PtyHandleEvent): PtyOwnerStopStatus | null {
	if (event.type === "owner-stop") return event.status;
	// Every pushed status carries the verdict, so a transition is seen even when it
	// arrives as part of a broader state change.
	if (event.type === "state") return event.status.ownerStop;
	return null;
}

/**
 * Publish the compact title and live cleanup verdict, and return the unsubscribe.
 * The initial verdict is published immediately; repeated states do not redraw the chrome.
 */
export function watchShellOwnerStop(
	source: ShellOwnerStopSource,
	label: string,
	write: (title: string, status: PtyOwnerStopStatus | null) => void,
): () => void {
	let current: PtyOwnerStopStatus | null = source.statusValue?.ownerStop ?? null;
	write(shellEditorTitle(label), current);
	return source.subscribe(event => {
		const next = pushedOwnerStop(event);
		if (next === null || next.state === current?.state) return;
		current = next;
		write(shellEditorTitle(label), next);
	});
}

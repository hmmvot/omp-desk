/**
 * When the writer a launch started is ready, as the pending-operation display needs to know it: the Sessions row and the Chat
 * page say `Starting…` until then, not until the broker has merely started the process (OMP then boots for seconds: plugins,
 * extensions, model providers). Presentation only: nothing here decides ownership, admission, a lease or run intent.
 *
 * Ready means what the user is waiting for in the view the launch opened:
 *
 * - Chat: the conversation reached its `live` phase (OMP said `ready`, the identity was verified, the first snapshot was
 *   published). While it is `starting`, `attaching` (waiting for OMP's `ready`) or `resyncing` (the first state read) it is booting.
 * - Terminal: host control was verified (the native process loaded OMP Desk's extension and answered), or it never will be:
 *   the launch carried no control, or the verification failed and says why.
 *
 * Nothing here imports `vscode`.
 */
import type { ChatPhase } from "../chat/model.ts";
import type { PendingStep } from "../shared/pending-operation.ts";
import type { LaunchReadiness } from "./pending-operations.ts";

/** What the window knows about the writer of one tab. */
export interface LaunchWriterFacts {
	/** The process this window runs for the tab, or `null` when none (it ended, was never started, or belongs to another window). */
	readonly runtime: {
		readonly kind: "chat" | "terminal";
		/** `false` for a launch that carried no host-control bootstrap: no verification will ever come. */
		readonly carriesControl: boolean;
		/** A native shutdown was accepted: the process is going away. */
		readonly stopping: boolean;
	} | null;
	/** The tab's conversation phase (Chat), or `null` when it has none. */
	readonly chatPhase: ChatPhase | null;
	readonly controlVerified: boolean;
	/** Host control is unavailable and says why: the wait for it is over. */
	readonly controlFailed: boolean;
}

export function launchReadiness(facts: LaunchWriterFacts): LaunchReadiness {
	const { runtime } = facts;
	if (runtime === null) return "gone";
	if (runtime.kind === "chat") {
		switch (facts.chatPhase) {
			case "live": return "ready";
			case "starting":
			case "attaching":
			case "resyncing": return "booting";
			default: return "gone";
		}
	}
	if (runtime.stopping) return "gone";
	if (facts.controlVerified || facts.controlFailed || !runtime.carriesControl) return "ready";
	return "booting";
}

/**
 * The step a launching conversation is in at a chat phase, or `null` when the phase says nothing about starting. `starting` and
 * `attaching` both precede OMP's `ready` frame (the attach to the broker, then the wait for OMP to answer), and OMP reports
 * nothing while it boots, so they are one honest step; `resyncing` is the connection's first state read after `ready`.
 */
export function stepAfterChatPhase(phase: ChatPhase): PendingStep | null {
	switch (phase) {
		case "starting":
		case "attaching": return "boot";
		case "resyncing": return "connect";
		default: return null;
	}
}

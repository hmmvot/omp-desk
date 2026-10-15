/**
 * Which step an operation is in once a launch lap has finished. The laps are the phase boundaries `LocalLauncher` and the
 * entry points already record for the `window timing` lines; "lap X finished" means "the phase after X is current". Presentation
 * only (see `pending-operations.ts`).
 *
 * `LaunchLap` is a closed union and {@link STEP_AFTER_LAP} is a `Record` over it, so a lap that is added or renamed fails to
 * compile here until it is mapped. `null` means the lap does not move the step: the ownership and confirmation steps are named
 * by the entry points themselves, so `panel` (which now precedes them) must not advance anything.
 *
 * Nothing here imports `vscode`.
 */
import type { PendingStep } from "../shared/pending-operation.ts";
import type { LaunchLap, LaunchTimelineObserver } from "./launch-timeline.ts";
import type { PendingOperations } from "./pending-operations.ts";

export const STEP_AFTER_LAP: Record<LaunchLap, PendingStep | null> = {
	draft: null,
	wait: null,
	ownership: null,
	panel: null,
	// The launcher took the launch: staging comes next, then the host-control keys.
	admission: "prepare",
	stage: "prepare",
	"host control keys": "runtime",
	// The broker client waits for the PTY runtime proof, then the editor document and the broker slot are prepared.
	"runtime proof": "runtime",
	"editor document": "runtime",
	// The broker launch call follows: resolution, the Bun probe and trust read, the spawn and the handshake.
	"broker slot": "spawn",
	conversation: "connect",
	"run intent": null,
};

/** The step once the broker launch has returned and its own timings were added. */
export const STEP_AFTER_ADD: PendingStep = "connect";

/** Feeds a registry from a launch timeline: the deep steps of a launch come from the laps it already records. */
export function observeLaunchSteps(pending: PendingOperations): LaunchTimelineObserver {
	return {
		onLap(tabId, lap) {
			const step = STEP_AFTER_LAP[lap];
			if (step !== null) pending.step(tabId, step);
		},
		onAdd(tabId) {
			pending.step(tabId, STEP_AFTER_ADD);
		},
	};
}

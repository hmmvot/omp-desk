/**
 * The one rule for the double `Esc` that opens Rewind, shared by the composer's textarea and the page around it
 * (the transcript, a tool row, a link, the page body), so the timing lives in one place.
 */

/** Two `Esc` presses this close together, with the session idle and the draft empty, open Rewind, as in the TUI. */
export const DOUBLE_ESCAPE_MS = 500;

export interface DoubleEscape {
	/**
	 * Count one `Esc` press. `idle` says whether this press may count (idle session, empty draft, nothing open);
	 * a press that may not count also forgets the one before it. Returns whether this press completes the pair.
	 */
	press(timeStamp: number, idle: boolean): boolean;
}

export function createDoubleEscape(): DoubleEscape {
	let last = Number.NEGATIVE_INFINITY;
	return {
		press(timeStamp, idle) {
			if (idle && timeStamp - last <= DOUBLE_ESCAPE_MS) {
				last = Number.NEGATIVE_INFINITY;
				return true;
			}
			last = idle ? timeStamp : Number.NEGATIVE_INFINITY;
			return false;
		},
	};
}

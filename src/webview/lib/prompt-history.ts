/**
 * The composer's prompt history, as the TUI's editor has it: `↑` on the first line of an empty draft walks back
 * through the conversation's past prompts, `↓` on the last line walks forward and finally restores what the
 * draft held. A recalled prompt is only replaced by the next step while it is unchanged; once edited it is the
 * user's draft and the arrows move the caret again.
 *
 * The list is the user prompts the page already holds (the loaded rows of the active branch), so nothing is
 * stored here. Pure: the composer owns the textarea, the caret rule and the state.
 */
// Explicit `.ts` specifiers: this module is imported by the node:test runner.
import type { ChatEntry } from "../../chat/messages.ts";
import { messageText } from "./format.ts";

/** Where a walk through the history stands. */
export interface HistoryCursor {
	/** 1 is the newest prompt, `list.length` the oldest. */
	readonly index: number;
	/** The text the composer shows for `index`; any other text ends the walk. */
	readonly recalled: string;
	/** The draft before the walk began, restored by stepping past the newest prompt. */
	readonly draft: string;
}

/** The user prompts of the loaded rows, oldest first, an immediate repeat listed once. Image-only prompts are skipped. */
export function sessionPrompts(entries: readonly ChatEntry[]): string[] {
	const prompts: string[] = [];
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "user" || entry.message.synthetic === true) continue;
		const text = messageText(entry.message.content);
		if (text.trim().length === 0 || prompts[prompts.length - 1] === text) continue;
		prompts.push(text);
	}
	return prompts;
}

/**
 * One `↑` (`older`) or `↓` (`newer`) press: the text to show and the next cursor, or `null` when the key is not
 * a history step (the draft is not empty or not the recalled prompt, or the walk is already at its end).
 */
export function historyStep(list: readonly string[], cursor: HistoryCursor | null, direction: "older" | "newer", text: string): { text: string; cursor: HistoryCursor | null } | null {
	const walking = cursor !== null && cursor.recalled === text;
	if (direction === "older") {
		if (!walking && text.trim().length > 0) return null;
		const index = walking ? cursor.index + 1 : 1;
		const recalled = list[list.length - index];
		if (recalled === undefined) return null;
		return { text: recalled, cursor: { index, recalled, draft: walking ? cursor.draft : text } };
	}
	if (!walking) return null;
	const index = cursor.index - 1;
	if (index === 0) return { text: cursor.draft, cursor: null };
	const recalled = list[list.length - index];
	if (recalled === undefined) return null;
	return { text: recalled, cursor: { index, recalled, draft: cursor.draft } };
}

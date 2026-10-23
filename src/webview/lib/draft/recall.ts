/**
 * Prompt-history recall: ↑ and ↓ in the composer walk the session's earlier prompts (docs/designs/2026-10-23-composer-draft-module.md,
 * section 4, row `recall`). The draft owns the walk in progress and the files of the prompt it placed; the arrows belong to the browser
 * unless the caret has no row left to move to (the caller's DOM fact) and the draft can be replaced without losing anything.
 */
import { historyStep } from "../../../chat/prompt-history.ts";
import { draftFromSentText } from "./draft-documents.ts";
import type { Change } from "./field.ts";
import type { Draft } from "./value.ts";

/**
 * The step of `direction` over `prompts` (the session's sent texts, oldest first), or `null` when the arrow is not ours: the draft is
 * held, holds any image at all (retained ones included, so Undo cannot lose one) or the walk has nowhere to go. A prompt that carried
 * files is walked by its prose; the walk owns the documents it placed and swaps them on each step, so ↑ then ↓ returns the draft.
 */
export function recall(draft: Draft, prompts: readonly string[], direction: "older" | "newer", held: boolean): Change | null {
	if (held || draft.images.length > 0) return null;
	const step = historyStep(prompts.map(prompt => draftFromSentText(prompt).text), draft.walk, direction, draft.text);
	if (step === null) return null;
	const recalled = step.cursor === null ? null : draftFromSentText(prompts[prompts.length - step.cursor.index]!);
	const documents = recalled?.documents ?? [];
	return {
		draft: { ...draft, walk: step.cursor, text: step.text, documents, next: { ...draft.next, document: documents.reduce((next, document) => Math.max(next, document.number + 1), 1) } },
		writes: [{ kind: "text", text: step.text, caret: step.text.length, history: "record", focus: true }],
	};
}

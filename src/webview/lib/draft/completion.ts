/**
 * The completions' side of the draft (docs/designs/2026-10-23-composer-draft-module.md, section 4, rows `completionAt`,
 * `acceptCompletion` and `insertCommand`): which token the caret is in, the splice an accepted row makes, and the Commands row `insert`.
 * The rows a popup shows stay the view's, drawn from the catalogue.
 */
import type { ChatSlashCommand } from "../../../chat/model.ts";
import { mentionQueryAt, spliceMention } from "../../../protocol/messages.ts";
import { slashArgumentAt, slashQueryAt, spliceArgument, spliceSlash, type SlashArgument, type SlashQuery } from "../slash-completion.ts";
import type { Change, Op } from "./field.ts";
import type { Draft } from "./value.ts";

/** The token the caret is in; at most one of the three is not `null`. */
export interface CompletionTokens {
	readonly slash: SlashQuery | null;
	readonly argument: SlashArgument | null;
	readonly mention: { readonly start: number; readonly query: string } | null;
}

/**
 * The tokens a completion popup answers at `caret`. `enabled` is false where nothing completes (no prompting, a pending host request, a
 * fenced block or a quote line, a dismissed popup): `/` and `@` there are text and the answer is no token at all.
 */
export function completionAt(draft: Draft, caret: number, commands: readonly ChatSlashCommand[], enabled: boolean): CompletionTokens {
	if (!enabled) return { slash: null, argument: null, mention: null };
	const slash = slashQueryAt(draft.text, caret, commands);
	const argument = slashArgumentAt(commands, draft.text, caret);
	return { slash, argument, mention: slash === null && argument === null ? mentionQueryAt(draft.text, caret) : null };
}

export type CompletionRow = { readonly kind: "file" | "slash" | "argument"; readonly name: string };

/**
 * The row `selected` accepted at `caret`: the token under it replaced, every other character and the attachments untouched, as one
 * undoable step with the caret after the splice. Quoting is the mention grammar's: `spliceMention` emits the bare `@path` form when it
 * parses back to the same path and a quoted form otherwise. Skipped while an IME composition is open or the draft is held (the caller's
 * `Timing`); `null` when the caret is in no token of that kind.
 */
export function acceptCompletion(caret: number, selected: CompletionRow, commands: readonly ChatSlashCommand[]): Op<void> {
	return draft => {
		if (selected.name.length === 0) return null;
		const text = draft.text;
		const slash = selected.kind === "slash" ? slashQueryAt(text, caret, commands) : null;
		const argument = selected.kind === "argument" ? slashArgumentAt(commands, text, caret) : null;
		const mention = selected.kind === "file" ? mentionQueryAt(text, caret) : null;
		if (slash === null && argument === null && mention === null) return null;
		const spliced = slash !== null
			? spliceSlash(text, slash, selected.name)
			: argument !== null
				? spliceArgument(text, argument.start, argument.end, selected.name)
				: spliceMention(text, caret, mention!.start, selected.name);
		return { change: { draft: { ...draft, text: spliced.text }, writes: [{ kind: "text", text: spliced.text, caret: spliced.caret, history: "record", focus: true }] }, result: undefined };
	};
}

/**
 * The draft after `/name ` is put in it. A draft that already starts with a command token has that token replaced (the typed
 * completion's own rule); any other draft keeps all its text after the command, so nothing the user wrote is lost.
 */
function commandInserted(text: string, name: string): { text: string; caret: number } {
	const token = /^\/[\w:-]*(?=\s|$)/.exec(text);
	if (token !== null) return spliceSlash(text, { start: 0, end: token[0].length }, name);
	const prefix = `/${name} `;
	return { text: prefix + text.trimStart(), caret: prefix.length };
}

/** The Commands row `insert`: `/name ` goes into the draft as one undoable step, and the prompt-history walk ends. A text that does not change only moves the caret. */
export function insertCommand(draft: Draft, name: string): Change {
	const spliced = commandInserted(draft.text, name);
	const walked: Draft = { ...draft, walk: null };
	if (spliced.text === draft.text) return { draft: walked, writes: [{ kind: "caret", at: spliced.caret, focus: true }] };
	return { draft: { ...walked, text: spliced.text }, writes: [{ kind: "text", text: spliced.text, caret: spliced.caret, history: "record", focus: true }] };
}

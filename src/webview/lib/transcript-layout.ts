import { entryMessage } from "../../chat/messages.ts";
import type { DensityCard } from "../../chat/tool-overview";
import type { MeasuredRow } from "./transcript-virtualizer";

/** Owned calls keep their mounted detail DOM when live/pending entries acquire durable ids. */
export function presentationRowId(card: DensityCard, namespace: string): string {
	return card.kind === "tool" ? `tool:${namespace}:${card.ownership === "orphan" ? `orphan:${card.id}:` : ""}${card.tool.call.id}` : card.id;
}
/** Conservative layout-only estimates; actual heights replace these and never become user-facing facts. */
/** A call whose card shows everything (`full`) has this many lines, windowed rows of about this height under a toolbar. */
export interface FullView { readonly full: boolean; readonly rows: number }
const FULL_ROW_HEIGHT = 18, FULL_CHROME = 90;
export function measuredTranscriptRows(cards: readonly DensityCard[], sources: ReadonlyMap<string, readonly string[]>, width: number, disclosures: ReadonlyMap<string, boolean>, namespace: string, forcedCalls?: ReadonlyMap<string, boolean>, viewOf?: (key: string) => FullView | undefined): readonly MeasuredRow[] {
	const textHeight = (text: string): number => 36 + Math.max(text.split("\n").length, Math.ceil(text.length / Math.max(24, width / 7))) * 20;
	return cards.map(card => {
		let estimate = 40; const revision: unknown[] = []; let growing = false;
		if (card.kind === "run") {
			revision.push(disclosures.get(card.id) ?? false, card.summary, card.runningCount, card.failureCount);
			estimate = 36;
		} else if (card.kind === "tool") {
			const expanded = (disclosures.get(`call:${namespace}:${card.tool.call.id}`) ?? false) || forcedCalls?.get(card.tool.call.id) === true;
			const view = expanded ? viewOf?.(`call:${namespace}:${card.tool.call.id}`) : undefined;
			revision.push(card.tool.call, card.tool.result, card.tool.active, expanded, view?.full === true, view?.rows ?? 0);
			// A full view is a block of fixed-height rows: its height is its line count, so an unmounted card is estimated, not guessed.
			estimate = view?.full === true ? FULL_CHROME + view.rows * FULL_ROW_HEIGHT : expanded ? 260 : 26;
		} else if (card.kind === "assistant") {
			revision.push(card.message, card.streaming); growing = true;
			estimate = card.content.reduce((height, block) => height + (block.type === "text" ? textHeight(block.text) : block.type === "image" ? 220 : 32), 16);
		} else if (card.kind === "entry") {
			revision.push(card.entry, disclosures.get(`irc:${namespace}:${card.id}`) ?? false);
			if (card.entry.type === "reset_boundary") revision.push(disclosures.get(`cleared:${namespace}:${card.id}`) ?? false);
			const message = entryMessage(card.entry);
			if (message?.role === "user" && typeof message.content === "string") estimate = textHeight(message.content) + 16;
			else if (message?.role === "custom" && message.customType.startsWith("irc:")) estimate = revision[1] === true ? 160 : 32;
			else estimate = 120;
		} else { revision.push(card); estimate = 80; }
		const id = presentationRowId(card, namespace);
		return { id, sources: sources.get(id) ?? sources.get(card.id) ?? card.sourceIds, revision, estimate, growing };
	});
}

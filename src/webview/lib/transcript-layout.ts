import { entryMessage } from "../../chat/messages";
import type { DensityCard } from "../../chat/tool-overview";
import type { MeasuredRow } from "./transcript-virtualizer";

/** Owned calls keep their mounted detail DOM when live/pending entries acquire durable ids. */
export function presentationRowId(card: DensityCard, namespace: string): string {
	return card.kind === "tool" ? `tool:${namespace}:${card.ownership === "orphan" ? `orphan:${card.id}:` : ""}${card.tool.call.id}` : card.id;
}
/** Conservative layout-only estimates; actual heights replace these and never become user-facing facts. */
export function measuredTranscriptRows(cards: readonly DensityCard[], sources: ReadonlyMap<string, readonly string[]>, width: number, disclosures: ReadonlyMap<string, boolean>, namespace: string, forcedCalls?: ReadonlyMap<string, boolean>): readonly MeasuredRow[] {
	const textHeight = (text: string): number => 36 + Math.max(text.split("\n").length, Math.ceil(text.length / Math.max(24, width / 7))) * 20;
	return cards.map(card => {
		let estimate = 40; const revision: unknown[] = []; let growing = false;
		if (card.kind === "run") {
			revision.push(disclosures.get(card.id) ?? false, card.summary, card.runningCount, card.failureCount);
			estimate = 36;
		} else if (card.kind === "tool") {
			const expanded = (disclosures.get(`call:${namespace}:${card.tool.call.id}`) ?? false) || forcedCalls?.get(card.tool.call.id) === true;
			revision.push(card.tool.call, card.tool.result, card.tool.active, expanded);
			estimate = expanded ? 260 : 40;
		} else if (card.kind === "assistant") {
			revision.push(card.message, card.streaming); growing = true;
			estimate = card.content.reduce((height, block) => height + (block.type === "text" ? textHeight(block.text) : block.type === "image" ? 220 : 32), 16);
		} else if (card.kind === "entry") {
			revision.push(card.entry, disclosures.get(`irc:${namespace}:${card.id}`) ?? false);
			const message = entryMessage(card.entry);
			if (message?.role === "user" && typeof message.content === "string") estimate = textHeight(message.content) + 16;
			else if (message?.role === "custom" && message.customType.startsWith("irc:")) estimate = revision[1] === true ? 160 : 32;
			else estimate = 120;
		} else { revision.push(card); estimate = 80; }
		const id = presentationRowId(card, namespace);
		return { id, sources: sources.get(id) ?? sources.get(card.id) ?? card.sourceIds, revision, estimate, growing };
	});
}

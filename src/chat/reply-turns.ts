import { assistantPersistenceKey, entryMessage, userSkill, type AssistantMessage } from "./messages.ts";
import type { ChatPhase, DisplayTurn } from "./model.ts";
import type { TranscriptCard } from "./transcript.ts";

export interface ReplyFooter {
	id: string;
	hostId: string;
	sourceIds: readonly string[];
	text: string;
	imageOnly: boolean;
	durationMs: number | null;
	durationKind: "turn" | "history" | "response" | "unavailable";
	endTime: number | null;
	startedTime: number | null;
}
export interface ReplyTurnOptions { displayTurns?: readonly DisplayTurn[]; working: boolean; settled: boolean; asyncPaused: boolean; phase: ChatPhase }
interface ReplyGroup {
	id: string;
	start: number | null;
	observed?: DisplayTurn;
	cards: Extract<TranscriptCard, { kind: "assistant" }>[];
	candidate: Extract<TranscriptCard, { kind: "assistant" }> | null;
}
const sensible = (value: number | null | undefined): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;

/** A footer belongs to a semantic reply, never a provider request or tool row. */
export function replyFooters(cards: readonly TranscriptCard[], options: ReplyTurnOptions): ReadonlyMap<string, ReplyFooter> {
	const observedByMessage = new Map<string, DisplayTurn>();
	for (const turn of options.displayTurns ?? []) for (const key of turn.memberKeys) observedByMessage.set(key, turn);
	const observedGroups = new Map<number, ReplyGroup>();
	const history: ReplyGroup[] = [];
	let interval: ReplyGroup = { id: "history:truncated", start: null, cards: [], candidate: null };
	history.push(interval);
	for (const card of cards) {
		if (card.kind === "entry") {
			const message = entryMessage(card.entry);
			if (message?.role === "user" && !message.synthetic || message?.role === "custom" && userSkill(message) !== null) {
				interval = { id: `history:${card.id}`, start: sensible(message.timestamp) ? message.timestamp : null, cards: [], candidate: null };
				history.push(interval);
			}
			continue;
		}
		if (card.kind !== "assistant" || card.message.retryRecovery !== undefined) continue;
		const observed = observedByMessage.get(assistantPersistenceKey(card.message));
		let group = interval;
		if (observed) {
			group = observedGroups.get(observed.id)!;
			if (!group) { group = { id: `live:${observed.id}`, start: observed.startedAt, observed, cards: [], candidate: null }; observedGroups.set(observed.id, group); }
		}
		group.cards.push(card);
		if (!card.streaming && card.message.stopReason !== "toolUse" && card.content.some(block => block.type === "image" || block.type === "text" && block.text.trim().length > 0)) group.candidate = card;
	}

	const result = new Map<string, ReplyFooter>();
	const newestObserved = options.displayTurns?.at(-1);
	const unfinished = options.working || options.asyncPaused || !options.settled || newestObserved?.complete === false;
	const live = options.phase === "live" || options.phase === "starting" || options.phase === "attaching" || options.phase === "resyncing";
	for (const group of [...history, ...observedGroups.values()]) {
		const host = group.candidate;
		if (!host || group.observed && !group.observed.complete) continue;
		if (live && unfinished && (group.observed ? group.observed === newestObserved : group === history.at(-1))) continue;
		const text: string[] = [];
		const sources = new Set<string>();
		for (const card of group.cards) {
			for (const id of card.sourceIds) sources.add(id);
			for (const block of card.content) if (block.type === "text" && block.text.trim().length > 0) text.push(block.text);
		}
		const message: AssistantMessage = host.message;
		const end = sensible(message.completedAt) && message.completedAt >= message.timestamp ? message.completedAt : group.observed && sensible(group.observed.completedAt) ? group.observed.completedAt : null;
		const total = sensible(group.start) && end !== null && end >= group.start ? end - group.start : null;
		const response = sensible(message.duration) || message.duration === 0 ? message.duration : null;
		result.set(host.id, {
			id: group.id, hostId: host.id, sourceIds: [...sources], text: text.join("\n\n"), imageOnly: text.length === 0,
			durationMs: total ?? response, durationKind: total !== null ? group.observed ? "turn" : "history" : response !== null ? "response" : "unavailable",
			endTime: end, startedTime: end === null && sensible(message.timestamp) ? message.timestamp : null,
		});
	}
	return result;
}

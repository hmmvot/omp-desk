/** The page's thinking clocks (`chat/thinking-clock.ts`), fed by the transcript that watches the stream and read by each thinking block. */
import { useSyncExternalStore } from "react";
import type { AssistantMessage } from "../../chat/messages";
import { ThinkingClocks, thoughtDuration, type ThinkingSpan } from "../../chat/thinking-clock";
import { useSecondTick } from "./live-clock";

const clocks = new ThinkingClocks();
const listeners = new Set<() => void>();
let revision = 0;

/** Look at the message being streamed; a thinking block that started, or stopped, redraws its title. `attached`: the look came with a fresh snapshot, not with the stream's own update. */
export function observeThinking(scope: string, stream: AssistantMessage | null, attached: boolean): void {
	if (!clocks.observe(scope, stream, Date.now(), attached)) return;
	revision += 1;
	for (const listener of listeners) listener();
}

const subscribe = (listener: () => void): (() => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

/** What a thinking block needs to title itself: its clock identity, and whether the model is still thinking it. */
export interface ThinkingClockRef { key: string; live: boolean }

/**
 * `Thinking… 7s` while the block streams (the seconds tick once a second), `Thought for 7s` once it has ended, and `Thought`
 * when its time was never measured here: saved history, or a block that was already streaming when the page attached.
 */
export function useThinkingTitle(ref: ThinkingClockRef | undefined): string {
	useSyncExternalStore(subscribe, () => revision);
	const span: ThinkingSpan | undefined = ref === undefined ? undefined : clocks.get(ref.key);
	const ticking = ref?.live === true && span?.start != null && span.end === undefined;
	useSecondTick(ticking);
	if (ref?.live === true && span?.end === undefined) {
		const seconds = span?.start == null ? 0 : Math.floor((Date.now() - span.start) / 1000);
		return seconds >= 1 ? `Thinking… ${seconds}s` : "Thinking…";
	}
	return span?.start != null && span.end !== undefined ? `Thought for ${thoughtDuration(span.end - span.start)}` : "Thought";
}

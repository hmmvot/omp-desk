/**
 * How long the model thought, measured where the OMP terminal UI measures it: from the moment a thinking block is seen
 * streaming until something after it appears (text, a tool call) or the message ends. The wire carries no duration for a
 * thinking block, so history that was not watched has none, and says "Thought" rather than a time that was never measured.
 *
 * Pure: the caller supplies the clock. A scope is one conversation of the page.
 */
import type { AssistantMessage } from "./messages.ts";

/** `start` is `null` for a block the page did not watch begin: it was already streaming when the page took a snapshot of the session. */
export interface ThinkingSpan { readonly start: number | null; readonly end?: number }

/** The identity of a thinking block that survives the message becoming a saved entry: the request's own stamp and the block's position. */
export function thinkingKey(scope: string, message: AssistantMessage, index: number): string {
	return `${scope}\0${message.timestamp}\0${message.provider ?? ""}\0${message.model}\0${index}`;
}

/** `Thought for 7s`, rounded up to a whole second like the TUI's wording (at least one), and minutes from a minute on. */
export function thoughtDuration(milliseconds: number): string {
	if (milliseconds < 59_500) return `${Math.max(1, Math.round(milliseconds / 1000))}s`;
	const minutes = Math.floor(Math.round(milliseconds / 1000) / 60);
	const seconds = Math.round(milliseconds / 1000) % 60;
	return minutes < 60 ? `${minutes}m ${String(seconds).padStart(2, "0")}s` : `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export class ThinkingClocks {
	readonly #spans = new Map<string, ThinkingSpan>();
	/** The blocks still streaming in each scope. */
	readonly #open = new Map<string, Set<string>>();

	get(key: string): ThinkingSpan | undefined {
		return this.#spans.get(key);
	}

	/**
	 * Look at the message being streamed (`null` when none is). Returns whether any span changed, so the caller can redraw.
	 * `attached` says this look came with a fresh snapshot of the session rather than with the stream's own updates: a block
	 * first seen then was already streaming, so its beginning was not watched and it stays untimed.
	 */
	observe(scope: string, stream: AssistantMessage | null, now: number, attached = false): boolean {
		const before = this.#open.get(scope) ?? new Set<string>();
		const open = new Set<string>();
		let changed = false;
		if (stream !== null) {
			const last = stream.content.length - 1;
			stream.content.forEach((block, index) => {
				if (block.type !== "thinking") return;
				const key = thinkingKey(scope, stream, index);
				const span = this.#spans.get(key);
				if (index === last) open.add(key);
				// A block first seen already passed over (an update that jumped past it) was never watched: no start to claim.
				if (span === undefined) { this.#spans.set(key, index !== last ? { start: null, end: now } : { start: attached ? null : now }); changed = true; }
				else if (index !== last && span.end === undefined) { this.#spans.set(key, { start: span.start, end: now }); changed = true; }
			});
		}
		// Blocks that were streaming and are no more: the message ended, or another one replaced it.
		for (const key of before) {
			const span = this.#spans.get(key);
			if (!open.has(key) && span !== undefined && span.end === undefined) { this.#spans.set(key, { start: span.start, end: now }); changed = true; }
		}
		this.#open.set(scope, open);
		return changed;
	}
}

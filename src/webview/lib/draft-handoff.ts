/**
 * In-memory, complete text-only handoff between documents of the same editor.
 * Capture locks its source until a matching release or disposal. Image bytes,
 * draft text and recovery records never reach persisted Webview state or logs.
 */
import type { DraftHandoffContent } from "../messages.ts";

export type DraftCapture = DraftHandoffContent;

type DraftProvider = {
	read(requestId: number): DraftCapture | null;
	release(requestId: number): void;
};
type Registration = { provider: DraftProvider; requestId: number | null };
const providers: Registration[] = [];
const restored: ((content: DraftCapture) => void)[] = [];
let pendingRestore: DraftCapture | null = null;
let lastRestoreId: number | null = null;

/** The newest mounted composer owns capture; unmount releases its transaction. */
export function provideDraftHandoff(provider: DraftProvider): () => void {
	const entry: Registration = { provider, requestId: null };
	providers.push(entry);
	return () => {
		const index = providers.indexOf(entry);
		if (index >= 0) providers.splice(index, 1);
		if (entry.requestId !== null) provider.release(entry.requestId);
	};
}

/** Null means a complete, stable capture could not be made, never an empty draft. */
export function captureDraft(requestId: number): DraftCapture | null {
	const entry = providers[providers.length - 1];
	if (entry === undefined) return null;
	const content = entry.provider.read(requestId);
	if (content !== null) entry.requestId = requestId;
	return content;
}

/** A stale cancellation cannot unlock a newer capture. */
export function releaseDraftCapture(requestId: number): void {
	for (const entry of providers) {
		if (entry.requestId !== requestId) continue;
		entry.requestId = null;
		entry.provider.release(requestId);
	}
}

/** Retain before mount or deliver now; replay of the same host transfer is ignored. */
export function offerRestoredDraft(requestId: number, content: DraftCapture): void {
	if (lastRestoreId === requestId) return;
	lastRestoreId = requestId;
	if (restored.length === 0) {
		pendingRestore = content;
		return;
	}
	for (const listener of [...restored]) listener(content);
}

export function takeRestoredDraft(): DraftCapture | null {
	const content = pendingRestore;
	pendingRestore = null;
	return content;
}

export function subscribeRestoredDraft(listener: (content: DraftCapture) => void): () => void {
	restored.push(listener);
	return () => {
		const index = restored.indexOf(listener);
		if (index >= 0) restored.splice(index, 1);
	};
}

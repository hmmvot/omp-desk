/**
 * The page's copy of the keys the empty Chat and the composer's keyboard button show (`omp:chat-keys`).
 *
 * Module-level, like `code-theme-store.ts`: the host posts the message as soon as it has seen the page's announcement, which can
 * be before React has mounted, so `attachKeyHints` runs in `main.tsx` before `omp:ready`. Until the host has said something about a
 * command, the manifest default stands in (a fixture, or a bridge route whose host has not answered).
 */
import { useSyncExternalStore } from "react";
import type { ChatKeyConflict, ChatKeyHint, EmptyStateKeyCommand } from "../../shared/key-hints.ts";
import { isEmptyStateKeyCommand } from "../../shared/key-hints.ts";
import type { GuestHostMessage } from "../../protocol/messages.ts";

interface KeyHintsTransport {
	subscribe(listener: (message: GuestHostMessage) => void): () => void;
}

/** What one hint shows: the effective key (`null`: the user removed it), the other commands that may take it, and how many more were left out. */
export interface KeyHintView {
	key: string | null;
	conflicts: readonly ChatKeyConflict[];
	more: number;
}

/** The manifest's keys, shown until the host answers. `src/webview/lib/key-hints-store.test.ts` and the owner's unit test pin them to package.json. */
export const DEFAULT_KEYS: Record<EmptyStateKeyCommand, string> = {
	"ompDesk.searchPromptHistory": "Ctrl+Alt+Y",
	"ompDesk.stopTurn": "Esc",
	"ompDesk.findInChat": "Ctrl+F",
	"ompDesk.quoteChatSelection": "Alt+Q",
	"ompDesk.toggleThinking": "Ctrl+Alt+T",
	"ompDesk.toggleToolOutput": "Ctrl+O",
	"ompDesk.quoteEditorSelection": "Alt+Q",
	"ompDesk.focusComposer": "Ctrl+Shift+L",
	"ompDesk.goToSession": "Ctrl+Alt+Q",
	"ompDesk.newSession": "Ctrl+Alt+N",
	"ompDesk.showChatKeyboardShortcuts": "Ctrl+/",
};

const NO_CONFLICTS: readonly ChatKeyConflict[] = [];
const listeners = new Set<() => void>();
let hostHints = new Map<EmptyStateKeyCommand, ChatKeyHint>();
let hostKey = "[]";
let version = 0;
let detach: (() => void) | null = null;
const views = new Map<EmptyStateKeyCommand, { version: number; view: KeyHintView }>();

function readHint(value: unknown): ChatKeyHint | null {
	if (typeof value !== "object" || value === null) return null;
	const hint = value as Record<string, unknown>;
	if (!isEmptyStateKeyCommand(hint.command)) return null;
	if (hint.key !== null && typeof hint.key !== "string") return null;
	if (!Array.isArray(hint.conflicts)) return null;
	const conflicts: ChatKeyConflict[] = [];
	for (const entry of hint.conflicts) {
		if (typeof entry !== "object" || entry === null) return null;
		const { by, command } = entry as Record<string, unknown>;
		if (typeof by !== "string" || typeof command !== "string") return null;
		conflicts.push({ by, command });
	}
	if (typeof hint.more !== "number" || !Number.isInteger(hint.more) || hint.more < 0) return null;
	return { command: hint.command, key: hint.key, conflicts, more: hint.more };
}

/** Replace what the host said (tests and the transport share this one path); garbage keeps the previous state, the same content changes nothing. */
export function setKeyHints(value: unknown): void {
	if (!Array.isArray(value)) return;
	const next = new Map<EmptyStateKeyCommand, ChatKeyHint>();
	for (const entry of value) {
		const hint = readHint(entry);
		if (hint === null || next.has(hint.command)) return;
		next.set(hint.command, hint);
	}
	const key = JSON.stringify([...next.values()]);
	if (key === hostKey) return;
	hostKey = key;
	hostHints = next;
	version++;
	for (const listener of listeners) listener();
}

export function attachKeyHints(transport: KeyHintsTransport): void {
	detach?.();
	detach = transport.subscribe(message => {
		if (message.type === "omp:chat-keys") setKeyHints(message.keys);
	});
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

function viewOf(command: EmptyStateKeyCommand): KeyHintView {
	const cached = views.get(command);
	if (cached !== undefined && cached.version === version) return cached.view;
	const hint = hostHints.get(command);
	const view: KeyHintView = hint === undefined
		? { key: DEFAULT_KEYS[command], conflicts: NO_CONFLICTS, more: 0 }
		: { key: hint.key, conflicts: hint.conflicts, more: hint.more };
	views.set(command, { version, view });
	return view;
}

/** The effective key of one Desk command, with its conflicts; the manifest default while the host has said nothing about it. */
export function useKeyHint(command: EmptyStateKeyCommand): KeyHintView {
	return useSyncExternalStore(subscribe, () => viewOf(command), () => viewOf(command));
}

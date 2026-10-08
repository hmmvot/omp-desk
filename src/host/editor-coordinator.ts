/**
 * One tab's actual editors, and which of them this window serves.
 *
 * A tab (`T`) can have more than one editor across one window's life: an explicit
 * Open creates one, VS Code restores a saved one, a legacy panel is migrated onto a
 * versioned successor, and a window reload revives a saved one again. Two of them
 * must never become two live chats for one session, so every candidate goes through
 * one *synchronous* reservation here before anything asynchronous happens, and the
 * loser is told to lose rather than being discovered later.
 *
 * What the reservation tracks per tab: the winning actual editor (`E`), where it
 * came from (a saved editor VS Code revived, or a transient one an explicit Open
 * created), the document incarnation (`D`) it currently shows, the observed
 * close/open sequence at the moment it won, and — while a one-time legacy
 * migration is running — the transition ticket that lets its own continuations
 * re-check that they are still the migration that started.
 *
 * The precedence rules are those of ADR-0019, narrowed by ADR-0023:
 *
 * - a **saved** editor wins over a **transient** one for the same tab, because the
 *   saved editor is the one the user's own layout names;
 * - the **first** candidate wins over later ones of the same provenance, so a
 *   second saved callback (two tabs revived from one identity) loses;
 * - the callback for the **same** editor id *joins* its own reservation instead of
 *   losing: after a full reload that editor exists again and simply needs a new
 *   document incarnation, which is the caller's next step, not a second editor.
 */
// Explicit `.ts` specifier so the node:test runner can load this module directly.
import { isBridgeTabId } from "../bridge-identity.ts";

/** Where the editor a tab is served by came from. */
export type EditorProvenance = "saved" | "transient";

/** One tab's winning editor. */
export interface EditorReservation {
	readonly tabId: string;
	/** Actual editor id (`E`), 32 lowercase hex. */
	readonly editorId: string;
	readonly provenance: EditorProvenance;
	/** The close/open sequence observed when this editor won. */
	readonly sequence: number;
	/** The document incarnation this editor currently shows, or `null`. */
	readonly documentId: string | null;
}

/** How one reservation attempt turned out. */
export type EditorReservationOutcome = "won" | "joined" | "replaced" | "lost";

/** One reservation attempt's result. */
export interface EditorReservationResult {
	readonly reservation: EditorReservation;
	readonly outcome: EditorReservationOutcome;
}

/** The one-winner reservation table of this window's editors. */
export class EditorCoordinator {
	readonly #winners = new Map<string, EditorReservation>();
	/** Transition tickets of a running legacy migration, per tab. */
	readonly #transitions = new Map<string, { readonly editorId: string; readonly ticket: number }>();
	#ticket = 0;

	/**
	 * Reserve one candidate editor for one tab.
	 *
	 * Synchronous by design: two callbacks in the same tick are ordered by this
	 * call, so "the first saved editor wins" is decided before either of them awaits
	 * anything. The caller MUST handle `lost` by not creating a second editor or a
	 * second native attempt.
	 */
	reserve(input: {
		readonly tabId: string;
		readonly editorId: string;
		readonly provenance: EditorProvenance;
		readonly sequence: number;
	}): EditorReservationResult {
		if (!isBridgeTabId(input.tabId)) throw new TypeError("an editor reservation names a canonical tab id");
		const existing = this.#winners.get(input.tabId);
		const candidate: EditorReservation = {
			tabId: input.tabId,
			editorId: input.editorId,
			provenance: input.provenance,
			sequence: input.sequence,
			documentId: null,
		};
		if (existing === undefined) {
			this.#winners.set(input.tabId, candidate);
			return { reservation: candidate, outcome: "won" };
		}
		if (existing.editorId === input.editorId) {
			// The same editor: keep what is already known about it (its document, its
			// original provenance) and let the caller rotate the document.
			return { reservation: existing, outcome: "joined" };
		}
		if (existing.provenance === "transient" && input.provenance === "saved") {
			this.#winners.set(input.tabId, candidate);
			this.#transitions.delete(input.tabId);
			return { reservation: candidate, outcome: "replaced" };
		}
		return { reservation: existing, outcome: "lost" };
	}

	/** The winning editor of one tab, or `null`. */
	winner(tabId: string): EditorReservation | null {
		return this.#winners.get(tabId) ?? null;
	}

	/** Whether one editor is the winner of its tab right now. */
	holds(tabId: string, editorId: string): boolean {
		return this.#winners.get(tabId)?.editorId === editorId;
	}

	/**
	 * The tab whose winner is this exact editor, or `null`.
	 *
	 * This is the slot-keyed lookup a migrated editor needs: once a settled switch
	 * changes the conversation an editor serves, its reservation must be found by its
	 * own immutable id rather than by the conversation it used to show.
	 */
	tabOfEditor(editorId: string): string | null {
		for (const [tabId, reservation] of this.#winners) {
			if (reservation.editorId === editorId) return tabId;
		}
		return null;
	}

	/** The reservation whose winner is this exact editor, or `null`. */
	winnerForEditor(editorId: string): EditorReservation | null {
		for (const reservation of this.#winners.values()) {
			if (reservation.editorId === editorId) return reservation;
		}
		return null;
	}

	/** Whether this exact editor is reserved as some tab's winner. */
	holdsEditor(editorId: string): boolean {
		return this.tabOfEditor(editorId) !== null;
	}

	/**
	 * Move one editor's reservation to the conversation it now serves.
	 *
	 * The editor id is immutable, so the reservation follows it: after a settled
	 * native switch the same panel is the winner of the *new* conversation, and a
	 * later `holds(nextTab, editorId)` — which is what a bridge document or a
	 * serializer checks — must be true. Refused when another, different editor is
	 * already the winner of the destination.
	 */
	rekey(fromTabId: string, editorId: string, toTabId: string): boolean {
		const existing = this.#winners.get(fromTabId);
		if (existing === undefined || existing.editorId !== editorId) return false;
		const destination = this.#winners.get(toTabId);
		if (destination !== undefined && destination.editorId !== editorId) return false;
		this.#winners.delete(fromTabId);
		this.#transitions.delete(fromTabId);
		this.#winners.set(toTabId, { ...existing, tabId: toTabId });
		return true;
	}

	/**
	 * Forget one editor by its own id, wherever it is reserved.
	 *
	 * Used when a close is observed for an editor whose conversation key is no longer
	 * the one it was reserved under (a migrated editor, or a parked reader).
	 */
	releaseEditor(editorId: string): boolean {
		const tabId = this.tabOfEditor(editorId);
		if (tabId === null) return false;
		this.#winners.delete(tabId);
		this.#transitions.delete(tabId);
		return true;
	}

	/** Record the document incarnation one winning editor currently shows. */
	noteDocument(tabId: string, editorId: string, documentId: string | null): void {
		const existing = this.#winners.get(tabId);
		if (existing === undefined || existing.editorId !== editorId) return;
		this.#winners.set(tabId, { ...existing, documentId });
	}

	/**
	 * Forget one editor because its close was observed.
	 *
	 * Only the *winner* can be released: a losing candidate that VS Code disposes
	 * must not free the tab's reservation for the editor that is actually serving it.
	 */
	release(tabId: string, editorId: string): void {
		const existing = this.#winners.get(tabId);
		if (existing === undefined || existing.editorId !== editorId) return;
		this.#winners.delete(tabId);
		this.#transitions.delete(tabId);
	}

	/**
	 * Claim the one-time legacy migration of one tab.
	 *
	 * A second claim while one is in flight returns `null`: the winner's serializer
	 * is already creating the single typed successor, and a second one would be a
	 * second editor for one session.
	 */
	claimTransition(tabId: string, editorId: string): number | null {
		if (this.#transitions.has(tabId)) return null;
		this.#ticket += 1;
		this.#transitions.set(tabId, { editorId, ticket: this.#ticket });
		return this.#ticket;
	}

	/** `true` while this exact transition ticket is still the running migration. */
	transitionHolds(tabId: string, editorId: string, ticket: number): boolean {
		const current = this.#transitions.get(tabId);
		return current !== undefined && current.editorId === editorId && current.ticket === ticket;
	}

	/** End a migration this caller still owns. */
	settleTransition(tabId: string, editorId: string, ticket: number): void {
		if (!this.transitionHolds(tabId, editorId, ticket)) return;
		this.#transitions.delete(tabId);
	}

	/** Tabs whose editors this table still reserves. */
	get tabs(): readonly string[] {
		return [...this.#winners.keys()];
	}
}

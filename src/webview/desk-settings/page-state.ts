import { inputText, sameValue } from "../../host/desk-settings/model.ts";
import type { JsonValue, SettingGroupView, SettingView, Target, WorkspaceFacts } from "../../host/desk-settings/model.ts";

/**
 * The Settings page's state and the rules that keep it truthful while writes, results and live
 * snapshots arrive in any order. Pure, so the orderings are tested without a browser.
 */
export interface Note { readonly requestId: string; readonly ok: boolean; readonly message: string }
/** `left`: the user left the field while a save of this row was unanswered, so the decision on this draft waits for that answer. */
export interface Draft { readonly text: string; readonly base: string; readonly left?: boolean }
/** A write the page has sent: shown instead of the stored value until the host's snapshot confirms it or the request fails. */
export interface Pending { readonly requestId: string; readonly value: JsonValue; readonly settled: boolean }

export interface OwnWrite { readonly requestId: string; readonly text: string; readonly acked: boolean }

export interface PageState {
	readonly groups: readonly SettingGroupView[] | undefined;
	readonly workspace: WorkspaceFacts | undefined;
	readonly pending: Readonly<Record<string, Pending>>;
	readonly drafts: Readonly<Record<string, Draft>>;
	readonly notes: Readonly<Record<string, Note>>;
	/** The latest request this document sent for a row (write, reset or open): only its result is presented. */
	readonly latest: Readonly<Record<string, string>>;
	/** This document's writes of a row that are not finished: sent and unanswered, or answered but not yet read back. Only these can explain a stored value as this document's own save. */
	readonly own: Readonly<Record<string, readonly OwnWrite[]>>;
}

export const initialPageState: PageState = { groups: undefined, workspace: undefined, pending: {}, drafts: {}, notes: {}, latest: {}, own: {} };

export type PageEvent =
	/** A fresh snapshot; `editing` is the key whose text field has the focus right now, if any. */
	| { readonly type: "state"; readonly groups: readonly SettingGroupView[]; readonly workspace: WorkspaceFacts; readonly editing: string | null }
	| { readonly type: "result"; readonly requestId: string; readonly key: string; readonly ok: boolean; readonly message: string }
	| { readonly type: "write"; readonly key: string; readonly requestId: string; readonly value: JsonValue }
	| { readonly type: "draft"; readonly key: string; readonly draft: Draft | undefined }
	/** The user left a field whose value changed elsewhere while they edited: the current value wins. */
	| { readonly type: "adopt"; readonly key: string }
	/** The user left a field while one of this document's saves of the row is unanswered: decide when it is answered. */
	| { readonly type: "defer"; readonly key: string }
	/** Reset: forget the row's draft, pending write and note; the reset is its latest request. */
	| { readonly type: "forget"; readonly key: string; readonly requestId: string }
	/** Open and other row actions: they become the row's latest request. */
	| { readonly type: "request"; readonly key: string; readonly requestId: string }
	/** Fade a success note, only if it is still the note of that request. */
	| { readonly type: "expire"; readonly key: string; readonly requestId: string };

const without = <T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> => {
	const next = { ...record };
	delete next[key];
	return next;
};

export const LOCAL_NOTE = "local";

function viewOf(groups: readonly SettingGroupView[] | undefined, key: string): SettingView | undefined {
	for (const group of groups ?? []) for (const view of group.settings) if (view.key === key) return view;
	return undefined;
}

export function reducePage(state: PageState, event: PageEvent): PageState {
	switch (event.type) {
		case "state": {
			// A settled write is confirmed by this snapshot; an unsettled one may belong to a write the host is still making,
			// so an unrelated snapshot never rolls it back.
			const pending: Record<string, Pending> = {};
			for (const [key, entry] of Object.entries(state.pending)) if (!entry.settled) pending[key] = entry;
			const drafts: Record<string, Draft> = {};
			for (const [key, draft] of Object.entries(state.drafts)) {
				const view = viewOf(event.groups, key);
				if (view === undefined) continue;
				const stored = inputText(view.value);
				if (stored === draft.text) continue;
				if (stored !== draft.base) {
					// This document's own save, acknowledged as written, coming back while the user kept typing: the draft goes on from the new stored value.
					// An unanswered request never counts: if it later fails, the value was somebody else's.
					if (state.own[key]?.some(entry => entry.acked && entry.text === stored)) { drafts[key] = { ...draft, base: stored }; continue; }
					// Changed elsewhere: the user is still typing, or a save of this row is unanswered and decides it; otherwise the current value wins.
					const unanswered = state.own[key]?.some(entry => !entry.acked) === true;
					if (!unanswered && event.editing !== key) continue;
				}
				drafts[key] = draft;
			}
			// An acknowledged write has now been read back: it no longer explains any stored value.
			const own: Record<string, readonly OwnWrite[]> = {};
			for (const [key, entries] of Object.entries(state.own)) {
				const open = entries.filter(entry => !entry.acked);
				if (open.length > 0) own[key] = open;
			}
			return { ...state, groups: event.groups, workspace: event.workspace, pending, drafts, own };
		}
		case "write": {
			const own = [...(state.own[event.key] ?? []), { requestId: event.requestId, text: inputText(event.value), acked: false }];
			return {
				...state,
				pending: { ...state.pending, [event.key]: { requestId: event.requestId, value: event.value, settled: false } },
				notes: without(state.notes, event.key),
				latest: { ...state.latest, [event.key]: event.requestId },
				own: { ...state.own, [event.key]: own },
				// The deferred save intent is consumed by this one submission and never re-armed.
				drafts: state.drafts[event.key]?.left === true ? { ...state.drafts, [event.key]: { text: state.drafts[event.key]!.text, base: state.drafts[event.key]!.base } } : state.drafts,
			};
		}
		case "result": {
			if (event.key === "") return state;
			// Settling is by the request's own id; only presenting its note depends on its being the row's latest request.
			const current = state.pending[event.key];
			let pending = state.pending;
			if (current?.requestId === event.requestId) {
				pending = event.ok ? { ...pending, [event.key]: { ...current, settled: true } } : without(pending, event.key);
			}
			// A failed write never explains a stored value; a successful one does until it is read back.
			const entries = state.own[event.key];
			let own = state.own;
			if (entries !== undefined) {
				const next = event.ok
					? entries.map(entry => (entry.requestId === event.requestId ? { ...entry, acked: true } : entry))
					: entries.filter(entry => entry.requestId !== event.requestId);
				own = next.length > 0 ? { ...state.own, [event.key]: next } : without(state.own, event.key);
			}
			// The readback may already be here (snapshot before result): an acknowledged own save that equals the stored value rebases a newer draft.
			let drafts = state.drafts;
			const draft = state.drafts[event.key];
			const acknowledged = entries?.find(entry => entry.requestId === event.requestId);
			if (event.ok && draft !== undefined && acknowledged !== undefined) {
				const stored = inputText(viewOf(state.groups, event.key)?.value);
				if (stored === acknowledged.text && stored !== draft.base && stored !== draft.text) drafts = { ...drafts, [event.key]: { ...draft, base: stored } };
			}
			let notes = state.notes;
			if (!event.ok && draft?.left === true && entries?.some(entry => entry.requestId === event.requestId) === true) {
				// The save this draft was waiting for failed: an outside change is adopted, otherwise the draft stays as an ordinary unsaved one.
				const stored = inputText(viewOf(state.groups, event.key)?.value);
				if (stored !== draft.base) {
					drafts = without(drafts, event.key);
					notes = { ...notes, [event.key]: { requestId: LOCAL_NOTE, ok: true, message: "This setting changed elsewhere; showing its current value." } };
				} else drafts = { ...drafts, [event.key]: { text: draft.text, base: draft.base } };
			}
			if (state.latest[event.key] !== event.requestId) return { ...state, pending, own, drafts, notes };
			return { ...state, pending, own, drafts, notes: { ...notes, [event.key]: { requestId: event.requestId, ok: event.ok, message: event.message } } };
		}
		case "draft":
			return { ...state, drafts: event.draft === undefined ? without(state.drafts, event.key) : { ...state.drafts, [event.key]: event.draft } };
		case "adopt":
			return {
				...state,
				drafts: without(state.drafts, event.key),
				notes: { ...state.notes, [event.key]: { requestId: LOCAL_NOTE, ok: true, message: "This setting changed elsewhere; showing its current value." } },
			};
		case "defer": {
			const draft = state.drafts[event.key];
			return draft === undefined ? state : { ...state, drafts: { ...state.drafts, [event.key]: { ...draft, left: true } } };
		}
		case "forget":
			return {
				...state,
				drafts: without(state.drafts, event.key),
				pending: without(state.pending, event.key),
				notes: without(state.notes, event.key),
				own: without(state.own, event.key),
				latest: { ...state.latest, [event.key]: event.requestId },
			};
		case "request":
			return { ...state, notes: without(state.notes, event.key), latest: { ...state.latest, [event.key]: event.requestId } };
		case "expire": {
			const note = state.notes[event.key];
			return note !== undefined && note.requestId === event.requestId && note.ok ? { ...state, notes: without(state.notes, event.key) } : state;
		}
	}
}

/**
 * What leaving a text field means: a draft made against a value that has since changed elsewhere is dropped (the
 * current value wins, with a note); otherwise it is saved. While a save of the row is still unanswered the stored value
 * cannot be told from this document's own save, so the decision waits for the answer. Enter is the explicit save and does not ask this.
 */
export function leaveDecision(draft: Draft | undefined, storedText: string, unanswered = false): "none" | "adopt" | "save" | "defer" {
	if (draft === undefined) return "none";
	if (storedText === draft.base) return "save";
	return unanswered ? "defer" : "adopt";
}

/** Drafts the user left while a save was unanswered, now answered and not changed from outside: ready to be saved. */
export function readyToSave(state: PageState): string[] {
	const keys: string[] = [];
	for (const [key, draft] of Object.entries(state.drafts)) {
		if (draft.left !== true || state.own[key]?.some(entry => !entry.acked) === true) continue;
		const stored = inputText(viewOf(state.groups, key)?.value);
		if (stored === draft.base && stored !== draft.text) keys.push(key);
	}
	return keys;
}

/**
 * Whether typing `value` into the selected layer needs a write. The value in effect is not the selected layer's
 * own value, so equality with it only means "nothing to do" when the effective value is the default or comes
 * from that very layer; otherwise the user is deliberately setting the other layer.
 */
export function needsWrite(view: SettingView, value: JsonValue, target: Target): boolean {
	if (!sameValue(value, view.value)) return true;
	return view.source !== "default" && view.source !== target;
}

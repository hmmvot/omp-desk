/**
 * What the host does with the drafts the Chat pages save (docs/designs/2026-11-03-keep-the-chat-draft-across-a-window-reload.md): turns a
 * save into a record of the private store, with the paths of the linked files the page only knows by reference, and a record into the
 * recall a document that has just become ready is offered. It also decides when stale records are swept.
 *
 * A record belongs to an editor slot (the editor's immutable id, restored by VS Code with the editor), so two editors of one conversation
 * each keep their own draft. The store directory is `<global storage>/drafts`, resolved on first use from the activation context; a
 * window without one keeps nothing. Content never reaches the log.
 */
import path from "node:path";
import { DraftStore } from "../host/draft-store.ts";
import type { StoredFile } from "../host/draft-store.ts";
import type { AttachedFileRegistry } from "../host/attached-files.ts";
import type { GuestDraftRecallMessage, GuestDraftSaveMessage, GuestDraftSavedMessage } from "../protocol/messages.ts";
import type { Logger } from "../shared/logger.ts";

/** A record untouched for this long is deleted by the sweep. */
export const DRAFT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
/** The sweep runs at the first save or recall of a window and then at most this often. */
const SWEEP_EVERY_MS = 6 * 60 * 60 * 1000;

export interface DraftPersistenceDeps {
	/** The extension's global storage directory, or `null` before activation or without one. */
	storageDir(): string | null;
	/** The files one tab attached, by the reference a page holds. */
	registryOf(tabId: string): Pick<AttachedFileRegistry, "register" | "resolve">;
	readonly log: Logger;
	readonly now?: () => number;
}

export interface DraftPersistence {
	/** Keeps (or, for an empty draft, deletes) the record of an editor slot; the answer names the image set the record holds. `null` when nothing can be kept. */
	save(slot: string, tabId: string, message: GuestDraftSaveMessage): Promise<GuestDraftSavedMessage | null>;
	/** The record of an editor slot as a recall message, or `null` when it has none. */
	recall(slot: string, tabId: string, recallId: number): Promise<GuestDraftRecallMessage | null>;
	/** Deletes the record of an editor slot: its editor was closed. */
	forget(slot: string): Promise<void>;
}

export function createDraftPersistence(deps: DraftPersistenceDeps): DraftPersistence {
	const now = deps.now ?? Date.now;
	let store: DraftStore | null = null;
	let directory: string | null = null;
	let lastSweep = -Infinity;

	const storeOf = (): DraftStore | null => {
		const base = deps.storageDir();
		if (base === null) return null;
		const wanted = path.join(base, "drafts");
		if (store === null || directory !== wanted) {
			store = new DraftStore({ directory: wanted, log: deps.log, now });
			directory = wanted;
		}
		return store;
	};

	const sweepIfDue = (target: DraftStore): void => {
		const at = now();
		if (at - lastSweep < SWEEP_EVERY_MS) return;
		lastSweep = at;
		void target.sweep({ maxAgeMs: DRAFT_MAX_AGE_MS }).catch(error => {
			deps.log.warn(`drafts: the sweep failed (${error instanceof Error ? error.message : "error"})`);
		});
	};

	return {
		async save(slot, tabId, message) {
			const target = storeOf();
			if (target === null) return null;
			const registry = deps.registryOf(tabId);
			const files: Record<string, StoredFile> = {};
			const documents = message.documents.filter(document => {
				if (document.ref === null) return true;
				// A reference the registry no longer knows names no path to read at send: its marker is left as text.
				const entry = registry.resolve(document.ref);
				if (entry === null) return false;
				files[document.ref] = { path: entry.path };
				return true;
			});
			const held = await target.save(slot, {
				content: { text: message.text, attachments: message.attachments, recoverable: message.recoverable, documents },
				imagesKey: message.imagesKey,
				images: message.images,
				files,
			});
			sweepIfDue(target);
			return { type: "omp:draft-saved", saveId: message.saveId, imagesKey: held };
		},

		async recall(slot, tabId, recallId) {
			const target = storeOf();
			if (target === null) return null;
			const record = await target.load(slot);
			sweepIfDue(target);
			if (record === null) return null;
			const registry = deps.registryOf(tabId);
			const documents = record.content.documents.flatMap(document => {
				if (document.ref === null) return [document];
				const file = record.files[document.ref];
				// Registered under the drop rule, whatever the file was attached by: a record is not proof that the user chose a network path.
				return file === undefined ? [] : [{ ...document, ref: registry.register(file.path, "drop") }];
			});
			return {
				type: "omp:draft-recall",
				recallId,
				text: record.content.text,
				attachments: record.content.attachments,
				recoverable: record.content.recoverable,
				documents,
				imagesKey: record.imagesKey,
				images: [...record.images],
			};
		},

		async forget(slot) {
			await storeOf()?.clear(slot);
		},
	};
}

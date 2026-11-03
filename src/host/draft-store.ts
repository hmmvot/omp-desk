/**
 * The host's private store of the Chat drafts the pages save, so a draft survives Reload Window
 * (docs/designs/2026-11-03-keep-the-chat-draft-across-a-window-reload.md).
 *
 * One record per editor slot (an editor of a session tab; the slot is the editor's immutable id, which VS Code restores with the
 * editor), in two files of the extension's global storage, named by the hash of the slot (no identity in the name and
 * no path to inject). `<key>.draft.json` holds the hand-off's content (text, recovery records, documents), the paths of the linked
 * documents and the key of the image file it expects; `<key>.images.json` holds the images and is rewritten only when the image set
 * changes, so a text edit never rewrites megabytes. The images file is written first: a crash between the two leaves a record whose key
 * does not match its images, which a load reports as images not carried.
 *
 * Content never reaches the log: only the hash prefix of a slot, counts and error codes. Files are created owner-only by
 * `replaceFileAtomic`. Every file read is bounded, and a record that does not validate is deleted. Nothing here imports `vscode`.
 */
import { createHash } from "node:crypto";
import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import {
	MAX_FILE_LABEL_LENGTH,
	imagesKeyCount,
	isImagesKey,
	isSafeBoundaryText,
	parseDraftHandoffContent,
	parsePersistedDraftImages,
} from "../protocol/messages.ts";
import type { DraftHandoffContent, PersistedDraftImage } from "../protocol/messages.ts";
import { isRecord } from "../shared/guards.ts";
import type { Logger } from "../shared/logger.ts";
import { errorCode, readBoundedFile, replaceFileAtomic } from "../wire/atomic-file.ts";

const VERSION = 1;
/** The content file: the text and held files together are at most 2 000 000 characters, which JSON escapes can quadruple. */
const MAX_CONTENT_FILE_BYTES = 24 * 1024 * 1024;
/** The images file: 10 MiB of images are 13.4 MB of base64. */
const MAX_IMAGES_FILE_BYTES = 24 * 1024 * 1024;
const REFERENCE = /^[A-Za-z0-9_-]{8,64}$/;

/** What the host remembers of a linked document's path. Its origin is not kept: a recalled path is read under the drop rule. */
export interface StoredFile {
	readonly path: string;
}

/** A save as the page sent it, after the host mapped the references of its linked documents to paths. */
export interface DraftToStore {
	readonly content: DraftHandoffContent;
	/** The key of the page's image set. */
	readonly imagesKey: string;
	/** The set whole, or `null` when the page says the host already holds the set named by `imagesKey`. */
	readonly images: readonly PersistedDraftImage[] | null;
	/** The path of each linked document, by the reference the content names. */
	readonly files: Readonly<Record<string, StoredFile>>;
}

/** A record read back. `content.attachments` already counts the images that could not be restored. */
export interface StoredDraft {
	readonly savedAt: number;
	readonly content: DraftHandoffContent;
	readonly imagesKey: string;
	readonly images: readonly PersistedDraftImage[];
	readonly files: Readonly<Record<string, StoredFile>>;
}

export interface DraftStoreOptions {
	/** The directory of the records; created on the first write. */
	readonly directory: string;
	readonly log: Logger;
	readonly now?: () => number;
}

/** The file stem of a slot: no identity in the name. */
export function draftKeyOf(owner: string): string {
	return createHash("sha256").update(owner).digest("hex").slice(0, 32);
}

/** Nothing worth keeping: no text, no card, no document, no image and nothing that was not carried. */
function emptySave(save: DraftToStore): boolean {
	const { content } = save;
	return content.text === "" && content.attachments === 0 && content.recoverable.length === 0 && content.documents.length === 0
		&& (save.images === null ? save.imagesKey === "" : save.images.length === 0);
}

function parseFiles(value: unknown): Record<string, StoredFile> | null {
	if (!isRecord(value)) return null;
	const entries = Object.entries(value);
	if (entries.length > 1000) return null;
	const files: Record<string, StoredFile> = {};
	for (const [reference, file] of entries) {
		if (!REFERENCE.test(reference) || !isRecord(file)) return null;
		const { path: filePath } = file;
		if (typeof filePath !== "string" || filePath.length === 0 || filePath.length > MAX_FILE_LABEL_LENGTH || !isSafeBoundaryText(filePath)) return null;
		files[reference] = { path: filePath };
	}
	return files;
}

export class DraftStore {
	readonly #directory: string;
	readonly #log: Logger;
	readonly #now: () => number;
	/** The image-set key each slot's record holds, once this window has read or written it. */
	readonly #held = new Map<string, string>();
	readonly #queues = new Map<string, Promise<unknown>>();

	constructor(options: DraftStoreOptions) {
		this.#directory = options.directory;
		this.#log = options.log;
		this.#now = options.now ?? Date.now;
	}

	#files(owner: string): { readonly draft: string; readonly images: string; readonly label: string } {
		const key = draftKeyOf(owner);
		return { draft: path.join(this.#directory, `${key}.draft.json`), images: path.join(this.#directory, `${key}.images.json`), label: key.slice(0, 8) };
	}

	/** One slot's operations run in the order they were asked: a save never overtakes the clear before it. */
	#serial<T>(owner: string, work: () => Promise<T>): Promise<T> {
		const previous = this.#queues.get(owner) ?? Promise.resolve();
		const next = previous.then(work, work);
		const tail = next.catch(() => undefined);
		this.#queues.set(owner, tail);
		void tail.then(() => {
			if (this.#queues.get(owner) === tail) this.#queues.delete(owner);
		});
		return next;
	}

	/**
	 * Applies a save and returns the image-set key the record holds afterwards (`""` for none), which the page compares with what it
	 * sent. An empty save deletes the record. A key the store does not hold and could not be given the images for leaves no images
	 * (the content counts them as not carried), so a record never pairs a text with another set's images.
	 */
	save(owner: string, save: DraftToStore): Promise<string> {
		return this.#serial(owner, async () => {
			const files = this.#files(owner);
			if (emptySave(save)) {
				await this.#remove(files);
				this.#held.set(owner, "");
				return "";
			}
			let held = await this.#heldKey(owner, files.draft);
			if (save.images !== null) {
				if (save.images.length === 0) {
					await rm(files.images, { force: true }).catch(() => undefined);
					held = "";
				} else {
					try {
						await replaceFileAtomic(files.images, JSON.stringify({ version: VERSION, owner, key: save.imagesKey, images: save.images }));
						held = save.imagesKey;
					} catch (error) {
						this.#log.warn(`draft ${files.label}: the images were not stored (${errorCode(error) ?? "error"})`);
					}
				}
			}
			let attachments = save.content.attachments;
			if (held !== save.imagesKey) {
				attachments += imagesKeyCount(save.imagesKey);
				// What the record holds is not this text's set: it would restore images no marker names.
				if (held !== "") await rm(files.images, { force: true }).catch(() => undefined);
				held = "";
			}
			try {
				await replaceFileAtomic(files.draft, JSON.stringify({
					version: VERSION,
					owner,
					savedAt: this.#now(),
					imagesKey: held,
					draft: { text: save.content.text, attachments, recoverable: save.content.recoverable, documents: save.content.documents },
					files: save.files,
				}));
				this.#held.set(owner, held);
				this.#log.debug(`draft ${files.label}: stored ${save.content.text.length} characters, ${imagesKeyCount(held)} images, ${save.content.documents.length} files`);
			} catch (error) {
				this.#held.delete(owner);
				this.#log.warn(`draft ${files.label}: the draft was not stored (${errorCode(error) ?? "error"})`);
				return held;
			}
			return held;
		});
	}

	/** The key of the images file the record expects: remembered, else read from the content file (small next to the images). */
	async #heldKey(owner: string, draftFile: string): Promise<string> {
		const known = this.#held.get(owner);
		if (known !== undefined) return known;
		const read = await readBoundedFile(draftFile, MAX_CONTENT_FILE_BYTES).catch(() => ({ kind: "invalid" as const }));
		if (read.kind !== "text") return "";
		try {
			const parsed: unknown = JSON.parse(read.text);
			return isRecord(parsed) && parsed.version === VERSION && parsed.owner === owner && isImagesKey(parsed.imagesKey) ? parsed.imagesKey : "";
		} catch {
			return "";
		}
	}

	/** The record of a slot, or `null` when it has none or it does not validate (which deletes it). */
	load(owner: string): Promise<StoredDraft | null> {
		return this.#serial(owner, async () => {
			const files = this.#files(owner);
			const read = await readBoundedFile(files.draft, MAX_CONTENT_FILE_BYTES).catch(() => ({ kind: "invalid" as const }));
			if (read.kind === "missing") return null;
			const record = read.kind === "text" ? this.#parseContent(owner, read.text) : null;
			if (record === null) {
				this.#log.warn(`draft ${files.label}: the record was refused and deleted`);
				await this.#remove(files);
				this.#held.delete(owner);
				return null;
			}
			let content = record.content;
			let images: readonly PersistedDraftImage[] = [];
			if (record.imagesKey !== "") {
				images = await this.#readImages(owner, files.images, record.imagesKey);
				if (images.length === 0) content = { ...content, attachments: content.attachments + imagesKeyCount(record.imagesKey) };
			}
			this.#held.set(owner, images.length === 0 ? "" : record.imagesKey);
			return { savedAt: record.savedAt, content, imagesKey: images.length === 0 ? "" : record.imagesKey, images, files: record.files };
		});
	}

	#parseContent(owner: string, text: string): { savedAt: number; content: DraftHandoffContent; imagesKey: string; files: Record<string, StoredFile> } | null {
		let value: unknown;
		try {
			value = JSON.parse(text);
		} catch {
			return null;
		}
		if (!isRecord(value) || value.version !== VERSION || value.owner !== owner || !isImagesKey(value.imagesKey)) return null;
		if (typeof value.savedAt !== "number" || !Number.isFinite(value.savedAt)) return null;
		const content = parseDraftHandoffContent(value.draft);
		const files = parseFiles(value.files);
		return content === null || files === null ? null : { savedAt: value.savedAt, content, imagesKey: value.imagesKey, files };
	}

	async #readImages(owner: string, file: string, key: string): Promise<readonly PersistedDraftImage[]> {
		const read = await readBoundedFile(file, MAX_IMAGES_FILE_BYTES).catch(() => ({ kind: "invalid" as const }));
		if (read.kind !== "text") return [];
		try {
			const value: unknown = JSON.parse(read.text);
			if (!isRecord(value) || value.version !== VERSION || value.owner !== owner || value.key !== key) return [];
			const images = parsePersistedDraftImages(value.images);
			return images !== null && images.length === imagesKeyCount(key) ? images : [];
		} catch {
			return [];
		}
	}

	/** Deletes the record of a slot (its editor was closed, or its draft was sent). */
	clear(owner: string): Promise<void> {
		return this.#serial(owner, async () => {
			await this.#remove(this.#files(owner));
			this.#held.set(owner, "");
		});
	}

	async #remove(files: { readonly draft: string; readonly images: string }): Promise<void> {
		await Promise.all([files.draft, files.images].map(file => rm(file, { force: true }).catch(() => undefined)));
	}

	/**
	 * Deletes the records older than `maxAgeMs` (by their files' modification time; `0` deletes every record). A stray images file
	 * whose content file is gone goes with its stem. Returns how many records were deleted. A directory that does not exist is nothing
	 * to sweep. There is no other rule: a record of a slot no window holds cannot be told from one whose editor VS Code has not revived yet.
	 */
	async sweep(options: { readonly maxAgeMs: number }): Promise<number> {
		let names: string[];
		try {
			names = await readdir(this.#directory);
		} catch (error) {
			if (errorCode(error) !== "ENOENT") this.#log.warn(`drafts: the folder could not be listed (${errorCode(error) ?? "error"})`);
			return 0;
		}
		const now = this.#now();
		const stems = new Map<string, { draft: boolean; newest: number }>();
		for (const name of names) {
			const match = /^([0-9a-f]{32})\.(draft|images)\.json$/.exec(name);
			if (match === null) continue;
			let modified: number;
			try {
				modified = (await stat(path.join(this.#directory, name))).mtimeMs;
			} catch {
				continue;
			}
			const entry = stems.get(match[1]!) ?? { draft: false, newest: 0 };
			entry.draft ||= match[2] === "draft";
			entry.newest = Math.max(entry.newest, modified);
			stems.set(match[1]!, entry);
		}
		let removed = 0;
		for (const [stem, entry] of stems) {
			const age = now - entry.newest;
			// A lone images file is a save in progress for a moment (the images go first), so it must also be a minute old.
			const stale = age >= options.maxAgeMs || (!entry.draft && age > 60_000);
			if (!stale) continue;
			await Promise.all([`${stem}.draft.json`, `${stem}.images.json`].map(name => rm(path.join(this.#directory, name), { force: true }).catch(() => undefined)));
			if (entry.draft) removed += 1;
		}
		if (removed > 0) {
			// What this window remembered of a record it no longer has would make a later save trust images that are gone.
			this.#held.clear();
			this.#log.debug(`drafts: ${removed} stale records deleted`);
		}
		return removed;
	}
}

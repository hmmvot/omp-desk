/**
 * The host's private draft store (`draft-store.ts`): records per editor slot, the image file written only when the image set changes, the
 * refusals, the sweep. The files are real, in a temporary folder.
 *
 * Runner: `node --test src/host/draft-store.test.ts`.
 */
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import type { DraftHandoffContent, PersistedDraftImage } from "../protocol/messages.ts";
import { recordingLogger } from "../shared/logger.ts";
import type { LoggedLine } from "../shared/logger.ts";
import { DraftStore, draftKeyOf } from "./draft-store.ts";
import type { DraftToStore } from "./draft-store.ts";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const SECRET = "the password is hunter2";

const image = (number: number): PersistedDraftImage => ({ number, name: "shot.png", mimeType: "image/png", bytes: PNG.byteLength, data: PNG.toString("base64"), width: 10, height: 6 });
const content = (text: string, extra: Partial<DraftHandoffContent> = {}): DraftHandoffContent => ({ text, attachments: 0, recoverable: [], documents: [], ...extra });
const save = (text: string, extra: Partial<DraftToStore> = {}, contentExtra: Partial<DraftHandoffContent> = {}): DraftToStore => ({ content: content(text, contentExtra), imagesKey: "", images: [], files: {}, ...extra });

describe("the draft store", () => {
	let folder = "";
	let directory = "";
	let lines: LoggedLine[] = [];
	let clock = Date.now();
	let store: DraftStore;
	before(async () => { folder = await mkdtemp(path.join(tmpdir(), "omp-desk-drafts-")); });
	after(async () => { await rm(folder, { recursive: true, force: true }); });
	beforeEach(async () => {
		directory = path.join(folder, `case-${Math.random().toString(16).slice(2)}`);
		lines = [];
		clock = Date.now();
		store = new DraftStore({ directory, log: recordingLogger(lines), now: () => clock });
	});

	it("loads nothing for an editor that saved nothing", async () => {
		assert.equal(await store.load("slot-a"), null);
	});

	it("keeps a draft whole: text, a held and a linked document, a card, the images and the path of a linked file", async () => {
		const documents = [
			{ number: 1, name: "notes.md", ref: null, label: null, content: "# notes\n", bytes: 8, chars: 8 },
			{ number: 2, name: "plan.md", ref: "AbCdEf012345", label: null, content: null, bytes: 40, chars: 40 },
		];
		const recoverable = [{ text: "refused", attachments: 1, unconfirmed: false }];
		assert.equal(await store.save("slot-a", save("hello", { imagesKey: "3", images: [image(1)], files: { AbCdEf012345: { path: "C:\\work\\plan.md" } } }, { documents, recoverable, attachments: 2 })), "3");
		const record = await store.load("slot-a");
		assert.ok(record !== null);
		assert.equal(record.content.text, "hello");
		assert.deepEqual(record.content.documents, documents);
		assert.deepEqual(record.content.recoverable, recoverable);
		assert.equal(record.content.attachments, 2);
		assert.equal(record.imagesKey, "3");
		assert.deepEqual(record.images, [image(1)]);
		assert.deepEqual(record.files, { AbCdEf012345: { path: "C:\\work\\plan.md" } });
	});

	it("names its files by a hash of the slot, so the slot is not in the folder, and keeps each slot's record apart", async () => {
		await store.save("slot-a", save("first"));
		await store.save("slot-b", save("second"));
		const names = await readdir(directory);
		assert.deepEqual(names.sort(), [`${draftKeyOf("slot-a")}.draft.json`, `${draftKeyOf("slot-b")}.draft.json`].sort());
		assert.ok(names.every(name => !name.includes("slot-")));
		assert.equal((await store.load("slot-a"))?.content.text, "first");
		assert.equal((await store.load("slot-b"))?.content.text, "second");
	});

	it("does not rewrite the images for a text edit, and loads them with the newest text", async () => {
		await store.save("slot-a", save("one", { imagesKey: "3", images: [image(1)] }));
		const imagesFile = path.join(directory, `${draftKeyOf("slot-a")}.images.json`);
		const before = await readFile(imagesFile, "utf8");
		await utimes(imagesFile, new Date(1000), new Date(1000));
		assert.equal(await store.save("slot-a", save("one two", { imagesKey: "3", images: null })), "3");
		assert.equal(await readFile(imagesFile, "utf8"), before);
		assert.equal((await readdir(directory)).length, 2);
		const record = await store.load("slot-a");
		assert.equal(record?.content.text, "one two");
		assert.equal(record?.images.length, 1);
	});

	it("answers with the key it holds when the page leaves the images out of a set it does not have, and counts them as not carried", async () => {
		assert.equal(await store.save("slot-a", save("text", { imagesKey: "5,6", images: null })), "");
		const record = await store.load("slot-a");
		assert.equal(record?.images.length, 0);
		assert.equal(record?.imagesKey, "");
		assert.equal(record?.content.attachments, 2);
	});

	it("replaces the set when the page sends a new one, and drops it when the page sends an empty one", async () => {
		await store.save("slot-a", save("t", { imagesKey: "1", images: [image(1)] }));
		await store.save("slot-a", save("t", { imagesKey: "2,3", images: [image(1), image(2)] }));
		assert.equal((await store.load("slot-a"))?.images.length, 2);
		assert.equal(await store.save("slot-a", save("t", { imagesKey: "", images: [] })), "");
		const record = await store.load("slot-a");
		assert.equal(record?.images.length, 0);
		assert.equal(record?.content.attachments, 0, "nothing was lost: the page chose to drop them");
		assert.deepEqual((await readdir(directory)).sort(), [`${draftKeyOf("slot-a")}.draft.json`]);
	});

	it("deletes both files for an empty draft, and for a clear", async () => {
		await store.save("slot-a", save("t", { imagesKey: "1", images: [image(1)] }));
		assert.equal(await store.save("slot-a", save("")), "");
		assert.deepEqual(await readdir(directory), []);
		await store.save("slot-a", save("again", { imagesKey: "1", images: [image(1)] }));
		await store.clear("slot-a");
		assert.deepEqual(await readdir(directory), []);
		assert.equal(await store.load("slot-a"), null);
	});

	it("runs one slot's operations in the order they were asked: a late clear does not lose a save asked after it", async () => {
		const done = [store.save("slot-a", save("one")), store.clear("slot-a"), store.save("slot-a", save("three"))];
		await Promise.all(done);
		assert.equal((await store.load("slot-a"))?.content.text, "three");
	});

	it("refuses and deletes a record that does not validate, another slot's record and a tampered images file", async () => {
		await store.save("slot-a", save("t", { imagesKey: "1", images: [image(1)] }));
		const draftFile = path.join(directory, `${draftKeyOf("slot-a")}.draft.json`);
		const imagesFile = path.join(directory, `${draftKeyOf("slot-a")}.images.json`);
		// The images file belongs to another set: the images are not trusted and are counted as not carried.
		await writeFile(imagesFile, JSON.stringify({ version: 1, owner: "slot-a", key: "9", images: [image(1)] }));
		const mismatch = await store.load("slot-a");
		assert.equal(mismatch?.images.length, 0);
		assert.equal(mismatch?.content.attachments, 1);
		// A record that names another slot is not this slot's.
		const other = JSON.parse(await readFile(draftFile, "utf8")) as Record<string, unknown>;
		await writeFile(draftFile, JSON.stringify({ ...other, owner: "slot-b" }));
		assert.equal(await store.load("slot-a"), null);
		assert.deepEqual(await readdir(directory), [], "the refused record is gone");
		await store.save("slot-a", save("again"));
		await writeFile(draftFile, "{ not json");
		assert.equal(await store.load("slot-a"), null);
		await store.save("slot-a", save("again"));
		const record = JSON.parse(await readFile(draftFile, "utf8")) as Record<string, unknown>;
		await writeFile(draftFile, JSON.stringify({ ...record, draft: { ...(record.draft as object), text: "a\rb" }, savedAt: 1 }));
		assert.equal(await store.load("slot-a"), null, "a control character is refused whole");
	});

	it("refuses a linked path that is not text, and a reference that is not one", async () => {
		await store.save("slot-a", save("t", { files: { AbCdEf012345: { path: "C:\\a.md" } } }));
		const draftFile = path.join(directory, `${draftKeyOf("slot-a")}.draft.json`);
		const record = JSON.parse(await readFile(draftFile, "utf8")) as Record<string, unknown>;
		await writeFile(draftFile, JSON.stringify({ ...record, files: { "../../x": { path: "C:\\a.md" } } }));
		assert.equal(await store.load("slot-a"), null);
	});

	it("never writes a draft to the log, only the hash prefix, counts and codes", async () => {
		await store.save("slot-a", save(SECRET, { imagesKey: "1", images: [image(1)] }));
		await store.load("slot-a");
		await store.save("slot-a", save(""));
		await writeFile(path.join(directory, `${draftKeyOf("slot-a")}.draft.json`), SECRET);
		await store.load("slot-a");
		assert.ok(lines.length > 0);
		assert.ok(lines.every(line => !line.message.includes("hunter2") && !line.message.includes("slot-a")), JSON.stringify(lines));
	});

	it("deletes the records older than the age, and a lone images file of a save that never finished, and keeps the rest", async () => {
		await store.save("slot-old", save("old"));
		await store.save("slot-new", save("new"));
		await store.save("slot-stray", save("stray", { imagesKey: "1", images: [image(1)] }));
		const old = new Date(clock - 20 * 86_400_000);
		await utimes(path.join(directory, `${draftKeyOf("slot-old")}.draft.json`), old, old);
		await rm(path.join(directory, `${draftKeyOf("slot-stray")}.draft.json`));
		await utimes(path.join(directory, `${draftKeyOf("slot-stray")}.images.json`), old, old);
		assert.equal(await store.sweep({ maxAgeMs: 14 * 86_400_000 }), 1);
		assert.deepEqual(await readdir(directory), [`${draftKeyOf("slot-new")}.draft.json`]);
		assert.equal((await store.load("slot-new"))?.content.text, "new");
		clock = Date.now() + 1_000;
		assert.equal(await store.sweep({ maxAgeMs: 0 }), 1, "an age of zero deletes every record");
		assert.deepEqual(await readdir(directory), []);
	});

	it("sweeping a folder that does not exist is nothing to do, and a sweep makes the store forget what it remembered", async () => {
		assert.equal(await store.sweep({ maxAgeMs: 1 }), 0);
		await store.save("slot-a", save("t", { imagesKey: "1", images: [image(1)] }));
		clock = Date.now() + 1_000;
		await store.sweep({ maxAgeMs: 0 });
		assert.equal(await store.save("slot-a", save("t", { imagesKey: "1", images: null })), "", "the images are gone: a save that leaves them out is told so");
	});
});

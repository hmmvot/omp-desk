/**
 * What the host does with a page's saved draft (`draft-persistence.ts`): the records of the private store follow the editor slot,
 * a linked file is kept as the path the host registered (the page only holds its reference), a record is recalled with a fresh
 * reference under the drop rule, and a window without a storage folder keeps nothing.
 *
 * Runner: `node --test src/wiring/draft-persistence.test.ts`.
 */
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { AttachedFileRegistry } from "../host/attached-files.ts";
import type { GuestDraftSaveMessage } from "../protocol/messages.ts";
import { recordingLogger } from "../shared/logger.ts";
import type { LoggedLine } from "../shared/logger.ts";
import { createDraftPersistence } from "./draft-persistence.ts";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const TAB = "tab:11111111-2222-4333-8444-555555555555";

const save = (saveId: number, extra: Partial<GuestDraftSaveMessage> = {}): GuestDraftSaveMessage =>
	({ type: "omp:draft-save", saveId, imagesKey: "", images: [], text: "", attachments: 0, recoverable: [], documents: [], ...extra });

describe("the draft persistence of the window", () => {
	let folder = "";
	let lines: LoggedLine[] = [];
	let registries: Map<string, AttachedFileRegistry>;
	let storage: string | null;
	before(async () => { folder = await mkdtemp(path.join(tmpdir(), "omp-desk-draft-wiring-")); });
	after(async () => { await rm(folder, { recursive: true, force: true }); });
	beforeEach(() => {
		lines = [];
		registries = new Map();
		storage = path.join(folder, `case-${Math.random().toString(16).slice(2)}`);
	});
	const make = () => createDraftPersistence({
		storageDir: () => storage,
		registryOf: tabId => {
			let registry = registries.get(tabId);
			if (registry === undefined) registries.set(tabId, registry = new AttachedFileRegistry());
			return registry;
		},
		log: recordingLogger(lines),
	});

	it("acknowledges a save with the image set it holds, and recalls the record of the slot", async () => {
		const drafts = make();
		const image = { number: 1, name: "shot.png", mimeType: "image/png" as const, bytes: PNG.byteLength, data: PNG.toString("base64") };
		const saved = await drafts.save("slot-1", TAB, save(7, { text: "hello [Image #1]", imagesKey: "1", images: [image] }));
		assert.deepEqual(saved, { type: "omp:draft-saved", saveId: 7, imagesKey: "1" });
		const recalled = await drafts.recall("slot-1", TAB, 3);
		assert.deepEqual(recalled, { type: "omp:draft-recall", recallId: 3, text: "hello [Image #1]", attachments: 0, recoverable: [], documents: [], imagesKey: "1", images: [image] });
		assert.equal(await drafts.recall("slot-2", TAB, 4), null, "another editor of the same conversation has no record");
	});

	it("keeps a linked file as the path the host registered, and offers it again under a fresh reference", async () => {
		const drafts = make();
		const first = new AttachedFileRegistry();
		registries.set(TAB, first);
		const ref = first.register("C:\\work\\plan.md", "dialog");
		const linked = { number: 1, name: "plan.md", ref, label: null, content: null, bytes: 40, chars: 40 };
		await drafts.save("slot-1", TAB, save(1, { text: "see [File #1: plan.md]", documents: [linked] }));
		// A new window: another registry knows nothing of the old reference.
		registries = new Map();
		const recalled = await make().recall("slot-1", TAB, 1);
		assert.ok(recalled !== null);
		assert.equal(recalled.documents.length, 1);
		const fresh = recalled.documents[0]!.ref!;
		assert.notEqual(fresh, ref);
		assert.equal(registries.get(TAB)?.resolve(fresh)?.path, "C:\\work\\plan.md");
		assert.equal(registries.get(TAB)?.resolve(fresh)?.origin, "drop", "a record is not proof that the user chose a network path");
	});

	it("leaves out a linked document whose reference the host no longer knows", async () => {
		const drafts = make();
		const stale = { number: 1, name: "plan.md", ref: "AbCdEf012345", label: null, content: null, bytes: 40, chars: 40 };
		const held = { number: 2, name: "n.md", ref: null, label: null, content: "text", bytes: 4, chars: 4 };
		await drafts.save("slot-1", TAB, save(1, { text: "x", documents: [stale, held] }));
		const recalled = await drafts.recall("slot-1", TAB, 1);
		assert.deepEqual(recalled?.documents, [held]);
	});

	it("deletes the record for an empty draft and for a forgotten slot", async () => {
		const drafts = make();
		await drafts.save("slot-1", TAB, save(1, { text: "a" }));
		await drafts.save("slot-2", TAB, save(2, { text: "b" }));
		assert.equal((await drafts.save("slot-1", TAB, save(3)))?.imagesKey, "");
		assert.equal(await drafts.recall("slot-1", TAB, 1), null);
		await drafts.forget("slot-2");
		assert.equal(await drafts.recall("slot-2", TAB, 2), null);
		assert.deepEqual(await readdir(path.join(storage!, "drafts")), []);
	});

	it("keeps nothing without a storage folder, and never logs the content", async () => {
		const secret = "the password is hunter2";
		storage = null;
		const drafts = make();
		assert.equal(await drafts.save("slot-1", TAB, save(1, { text: secret })), null);
		assert.equal(await drafts.recall("slot-1", TAB, 1), null);
		await drafts.forget("slot-1");
		storage = path.join(folder, "logged");
		await drafts.save("slot-1", TAB, save(2, { text: secret }));
		await drafts.recall("slot-1", TAB, 2);
		assert.ok(lines.every(line => !line.message.includes("hunter2")));
	});
});

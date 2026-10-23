/**
 * `attach` and `removeAttachment` (`attach.ts`): the algorithm of the composer's paste, drop and pick, against the cell and a scripted reader.
 *
 * Every refusal sentence an attach can produce is asserted whole, because a refusal is the only thing the user is told. The field is a
 * recording stub (`draft-test-stub.ts`) that applies an edit as the surface does and echoes it to the cell.
 *
 * Runner: `node --test src/webview/lib/draft/attach.test.ts`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GuestAttachedDocument } from "../../../protocol/messages.ts";
import { MAX_ATTACH_ITEMS, MAX_MESSAGE_CHARS } from "../../../shared/attach-limits.ts";
import { fileMarker } from "../../../shared/file-blocks.ts";
import { attach, readingBy, removeAttachment, type AttachEntry, type AttachReader, type AttachResult } from "./attach.ts";
import { createDraftCell, type DraftCell } from "./cell.ts";
import { stubFile, stubGate, stubPort, stubReader, tick, type StubPort, type StubReader } from "./draft-test-stub.ts";
import { withState } from "./value.ts";
import { viewOf } from "./view.ts";

const MiB = 1024 * 1024;

interface Kit {
	readonly cell: DraftCell;
	readonly port: StubPort;
	readonly reader: StubReader;
	/** How many times an attach said it began reading. */
	readonly started: () => number;
	/** Attach the files, with the host's earlier refusals. */
	run(files: readonly File[], earlier?: readonly string[]): Promise<AttachResult>;
	/** Attach documents the host linked by path. */
	link(...items: readonly GuestAttachedDocument[]): Promise<AttachResult>;
	/** The user types: the field and the value take `text`, the caret at its end. */
	type(text: string): void;
	/** The user places the caret (or a selection) in the field. */
	select(anchor: number, focus?: number): void;
	/** The numbers of the images and of the documents whose marker is in the text. */
	active(): { images: number[]; documents: number[] };
}

function kit(): Kit {
	const port = stubPort();
	const cell = createDraftCell(port);
	port.bind(cell);
	const reader = stubReader();
	let started = 0;
	const events = { started: () => started++ };
	return {
		cell,
		port,
		reader,
		started: () => started,
		run: (files, earlier = []) => attach(cell, files.map((file): AttachEntry => ({ kind: "file", file })), reader, earlier, events),
		link: (...items) => attach(cell, items.map((item): AttachEntry => ({ kind: "linked", item })), reader, [], events),
		type(text) {
			port.text = text;
			port.selected = { anchor: text.length, focus: text.length };
			cell.edited(text);
		},
		select(anchor, focus = anchor) {
			port.selected = { anchor, focus };
			cell.moved();
		},
		active() {
			const view = viewOf(cell.read(), 0);
			return { images: view.images.map(entry => entry.number), documents: view.documents.map(entry => entry.number) };
		},
	};
}

const image = (name: string, size = 100, width = 10, height = 6): File => stubFile(name, size, { pixels: { width, height } });
const text = (name: string, chars: number): File => stubFile(name, chars);
const linked = (name: string, ref: string, chars = 10): GuestAttachedDocument => ({ kind: "document", name, ref, bytes: chars, chars });

/** `A [Image #1, 10x6] B [Image #2, 20x8] C [Image #3, 30x9] D`, typed key by key and pasted as the browser subtest did. */
async function three(): Promise<Kit> {
	const k = kit();
	k.type("A ");
	await k.run([image("a.png", 100, 10, 6)]);
	k.type(`${k.cell.read().text}B `);
	await k.run([image("b.png", 100, 20, 8)]);
	k.type(`${k.cell.read().text}C `);
	await k.run([image("c.png", 100, 30, 9)]);
	k.type(`${k.cell.read().text}D`);
	k.port.calls.length = 0;
	return k;
}

const FIRST = "A [Image #1, 10x6] B [Image #2, 20x8] C [Image #3, 30x9] D";

describe("attach: markers", () => {
	it("numbers pasted images 1, 2, 3 in paste order and puts each marker at the caret, one space apart", async () => {
		const k = await three();
		assert.equal(k.cell.read().text, FIRST);
		assert.deepEqual(k.cell.read().images.map(entry => entry.number), [1, 2, 3]);
		assert.equal(k.cell.read().next.image, 4);
	});

	it("inserts in the middle of existing text at the caret, not at the end, and the number goes on from the highest issued", async () => {
		const k = await three();
		k.select("A [Image #1, 10x6] B [Image #2, 20x8] ".length);
		await k.run([image("d.png", 100, 40, 11)]);
		assert.equal(k.cell.read().text, "A [Image #1, 10x6] B [Image #2, 20x8] [Image #4, 40x11] C [Image #3, 30x9] D");
		assert.equal(k.cell.read().next.image, 5);
		assert.deepEqual(k.active().images, [1, 2, 3, 4]);
	});

	it("inserts every marker of one attach in the order the files were accepted, files and images numbered apart", async () => {
		const k = kit();
		await k.run([image("a.png"), text("notes.md", 12), image("b.png", 100, 20, 8), text("plan.md", 5)]);
		assert.equal(k.cell.read().text, "[Image #1, 10x6] [File #1: notes.md] [Image #2, 20x8] [File #2: plan.md] ");
		assert.deepEqual(k.active(), { images: [1, 2], documents: [1, 2] });
		assert.equal(k.cell.read().next.document, 3);
	});

	it("leaves out the pixel size a browser could not read, as the TUI's marker does", async () => {
		const k = kit();
		await k.run([stubFile("a.png", 100, { image: { ok: true, image: { id: 1, name: "a.png", mimeType: "image/png", bytes: 100, data: "d" } } })]);
		assert.equal(k.cell.read().text, "[Image #1] ");
	});

	it("puts a space before a marker after a word and after it before a word, and none where whitespace already is", async () => {
		const word = kit();
		word.type("abcd");
		word.select(2);
		await word.run([image("a.png")]);
		assert.equal(word.cell.read().text, "ab [Image #1, 10x6] cd");
		const spaced = kit();
		spaced.type("a  b");
		spaced.select(2);
		await spaced.run([image("a.png")]);
		assert.equal(spaced.cell.read().text, "a [Image #1, 10x6] b");
		const end = kit();
		end.type("abc");
		await end.run([image("a.png")]);
		assert.equal(end.cell.read().text, "abc [Image #1, 10x6] ");
	});

	it("replaces a selection with the markers, whichever way it was dragged", async () => {
		const k = kit();
		k.type("keep SELECTED keep");
		k.select(13, 5);
		await k.run([image("a.png")]);
		assert.equal(k.cell.read().text, "keep [Image #1, 10x6] keep");
	});

	it("puts the marker in as one edit of the field with no selection of its own, so the surface keeps a marker it cuts into whole", async () => {
		const k = kit();
		k.type("ab");
		await k.run([image("a.png")]);
		assert.deepEqual(k.port.calls, ['write edit 2..2 " [Image #1, 10x6] " as replace focus']);
	});

	it("appends the markers at the end of the text while no field is mounted, and publishes the attachments", async () => {
		const k = kit();
		k.type("abc");
		k.port.unmount();
		await k.run([image("a.png"), text("n.md", 3)]);
		assert.equal(k.cell.read().text, "abc [Image #1, 10x6] [File #1: n.md] ");
		assert.deepEqual(k.active(), { images: [1], documents: [1] });
		assert.equal(k.cell.getState().caret, k.cell.read().text.length);
		assert.deepEqual(k.port.calls, [], "there was no field to write to");
	});

	it("waits for an IME composition to end before it puts a marker in, and puts it where the caret then is", async () => {
		const k = kit();
		k.type("ab");
		k.port.openWindow();
		await k.run([image("a.png")]);
		assert.equal(k.cell.read().text, "ab", "the browser owns the field during the window");
		assert.deepEqual(k.cell.read().images.map(entry => entry.number), [1], "the attachment is published at once");
		k.port.selected = { anchor: 2, focus: 2 };
		k.port.closeWindow();
		assert.equal(k.cell.read().text, "ab [Image #1, 10x6] ");
		assert.deepEqual(k.active().images, [1]);
	});

	it("raises the revision, because the attachment and its marker are an edit of the draft", async () => {
		const k = kit();
		const before = k.cell.read().revision;
		await k.run([image("a.png")]);
		assert.ok(k.cell.read().revision > before);
	});
});

describe("attach: documents", () => {
	it("attaches a text as a held document: its number, its name and the text itself, with a marker of its name", async () => {
		const k = kit();
		await k.run([stubFile("notes.md", 3, { document: { ok: true, content: "# a", bytes: 3 } })]);
		assert.deepEqual(k.cell.read().documents, [{ number: 1, name: "notes.md", source: { kind: "held", content: "# a", label: null, bytes: 3 } }]);
		assert.equal(k.cell.read().text, `${fileMarker(1, "notes.md")} `);
	});

	it("attaches a file the host linked by path without reading it, next to an empty text file, which is a valid document", async () => {
		const k = kit();
		const result = await attach(k.cell, [{ kind: "linked", item: linked("notes.md", "AbCdEf012345", 2000) }, { kind: "file", file: text("empty.txt", 0) }], k.reader, [], { started: () => {} });
		assert.deepEqual(result, { alert: null });
		assert.deepEqual(k.cell.read().documents, [
			{ number: 1, name: "notes.md", source: { kind: "linked", ref: "AbCdEf012345", bytes: 2000, chars: 2000 } },
			{ number: 2, name: "empty.txt", source: { kind: "held", content: "", label: null, bytes: 0 } },
		]);
		assert.equal(k.cell.read().text, "[File #1: notes.md] [File #2: empty.txt] ");
		assert.deepEqual(k.reader.calls, ["classify empty.txt", "readDocument empty.txt"], "the linked file was never opened");
	});

	it("keeps the number of a marker whose attachment was removed: the next document goes on from the highest issued", async () => {
		const k = kit();
		await k.run([text("a.md", 1)]);
		k.type(k.cell.read().text.replace(fileMarker(1, "a.md"), ""));
		await k.run([text("b.md", 1)]);
		assert.deepEqual(k.cell.read().documents.map(entry => entry.number), [1, 2]);
		assert.deepEqual(k.active().documents, [2]);
	});
});

describe("attach: what it says", () => {
	it("says nothing and does nothing for no entries and no earlier refusals", async () => {
		const k = kit();
		assert.deepEqual(await k.run([]), {});
		assert.equal(k.started(), 0);
		assert.equal(k.cell.read().revision, 0);
	});

	it("reports the host's earlier refusals alone when nothing came with them, and clears the alert when everything was attached", async () => {
		const k = kit();
		assert.deepEqual(await k.run([], ["notes.txt: not a PNG, JPEG, GIF, or WebP image."]), { alert: "notes.txt: not a PNG, JPEG, GIF, or WebP image." });
		assert.equal(k.started(), 1, "the composer clears its send notice, as it did for any attach that began");
		assert.deepEqual(await k.run([image("a.png")]), { alert: null });
	});

	it("puts the host's earlier refusals before this call's own, and shows the first two whole with a count of the rest", async () => {
		const k = kit();
		const refused = (name: string, reason: string): File => stubFile(name, 5, { sort: { kind: "refused", reason } });
		assert.deepEqual(await k.run([refused("a.bin", "a.bin: third."), refused("b.bin", "b.bin: fourth.")], ["first.", "second."]), { alert: "first. second. (+2 more)" });
		assert.deepEqual(await k.run([refused("c.bin", "c.bin: only.")], ["one."]), { alert: "one. c.bin: only." });
	});

	it("names a file that is not text or an image by the reader's own sentence, and attaches nothing", async () => {
		const k = kit();
		const result = await k.run([stubFile("report.pdf", 100, { sort: { kind: "refused", reason: "report.pdf: it is not a text file (binary content)." } })]);
		assert.deepEqual(result, { alert: "report.pdf: it is not a text file (binary content)." });
		assert.equal(k.cell.read().text, "");
		assert.equal(k.cell.read().revision, 0, "a rejected file changes nothing");
		assert.deepEqual(k.reader.calls, ["classify report.pdf"]);
	});

	it("refuses an empty image by name, before reading it", async () => {
		const k = kit();
		assert.deepEqual(await k.run([image("empty.png", 0)]), { alert: "empty.png: the file is empty." });
		assert.deepEqual(k.reader.calls, ["classify empty.png"]);
	});

	it("attaches a 4 MB image whole and refuses one over 5 MiB naming the limit, which leaves the first attached", async () => {
		const k = kit();
		assert.deepEqual(await k.run([image("screenshot-4mb.png", 4 * MiB)]), { alert: null });
		assert.deepEqual(await k.run([image("huge.png", 5 * MiB + 1)]), { alert: "huge.png: 5.0 MB exceeds the 5.0 MB limit per image." });
		assert.deepEqual(k.active().images, [1]);
		assert.deepEqual(k.reader.calls, ["classify screenshot-4mb.png", "readImage screenshot-4mb.png key 1", "classify huge.png"], "an oversized pick is never read");
	});

	it("refuses an image that would take the prompt over 10 MiB, naming the total, and keeps the two that fit", async () => {
		const k = kit();
		await k.run([image("first.png", 4 * MiB)]);
		await k.run([image("second.png", 4 * MiB)]);
		assert.deepEqual(await k.run([image("third.png", 4 * MiB)]), { alert: "third.png: this prompt would carry 12.0 MB of images; the limit is 10.0 MB per prompt." });
		assert.deepEqual(k.active().images, [1, 2]);
	});

	it("counts only the images whose marker is in the text against the prompt budget: a removed one is released first", async () => {
		const k = kit();
		await k.run([image("a.png", 4 * MiB), image("b.png", 4 * MiB)]);
		k.type(k.cell.read().text.replace("[Image #1, 10x6] ", ""));
		assert.deepEqual(await k.run([image("c.png", 4 * MiB)]), { alert: null });
		assert.deepEqual(k.active().images, [2, 3]);
	});

	it("tells the reader's refusal of an image or a document, and a read that throws by file name", async () => {
		const k = kit();
		const badImage = stubFile("bad.png", 10, { image: { ok: false, reason: "bad.png: its contents are not a valid image/png image." } });
		const thrownImage = stubFile("thrown.png", 10, { image: "throw" });
		const badText = stubFile("bad.txt", 10, { document: { ok: false, reason: "bad.txt: is not valid UTF-8 text." } });
		const thrownText = stubFile("thrown.txt", 10, { document: "throw" });
		assert.deepEqual(await k.run([badImage, thrownImage, badText, thrownText]), { alert: "bad.png: its contents are not a valid image/png image. thrown.png: could not be read. (+2 more)" });
		assert.equal(k.cell.read().text, "");
		assert.deepEqual(await k.run([badText, thrownText]), { alert: "bad.txt: is not valid UTF-8 text. thrown.txt: could not be read." });
	});

	it("refuses a file already attached by path, whether the first came earlier in the draft or earlier in the same drop", async () => {
		const k = kit();
		await k.link(linked("notes.md", "AbCdEf012345"));
		assert.deepEqual(await k.link(linked("notes.md", "AbCdEf012345")), { alert: "notes.md is already attached." });
		assert.deepEqual(await k.link(linked("other.md", "ZzZzZz987654"), linked("other.md", "ZzZzZz987654")), { alert: "other.md is already attached." });
		assert.deepEqual(k.cell.read().documents.map(entry => entry.name), ["notes.md", "other.md"]);
	});

	it("does not count a linked file whose marker was deleted as attached: Undo can bring it back, and a new drop is allowed", async () => {
		const k = kit();
		await k.link(linked("notes.md", "AbCdEf012345"));
		k.type("");
		assert.deepEqual(await k.link(linked("notes.md", "AbCdEf012345")), { alert: null });
		assert.deepEqual(k.active().documents, [2]);
	});

	it("refuses a document that would take the draft over one message, naming it and the counts, and takes one that fits exactly", async () => {
		const k = kit();
		k.type("x".repeat(MAX_MESSAGE_CHARS - 100));
		const refused = await k.run([text("a.txt", 101)]);
		assert.match(refused.alert ?? "", /^Adding a\.txt \(101 characters\) would take the draft over 200.000 characters\.$/);
		assert.deepEqual(k.cell.read().documents, []);
		assert.deepEqual(await k.run([text("b.txt", 100)]), { alert: null });
		assert.deepEqual(k.active().documents, [1]);
	});

	it("refuses a linked file the same way: it is judged on the characters the host counted", async () => {
		const k = kit();
		k.type("x".repeat(MAX_MESSAGE_CHARS - 100));
		const refused = await k.link(linked("big.md", "AbCdEf012345", 101));
		assert.match(refused.alert ?? "", /^Adding big\.md \(101 characters\) would take the draft over 200.000 characters\.$/);
	});
});

describe("attach: the guard", () => {
	/** A draft whose text holds `count` markers of linked documents, so each one is active. */
	function crowded(count: number): Kit {
		const k = kit();
		const markers = Array.from({ length: count }, (_, index) => fileMarker(index + 1, `d${index + 1}.md`));
		const joined = markers.join(" ");
		k.cell.commit({
			draft: withState(k.cell.read(), {
				text: joined,
				documents: markers.map((_, index) => ({ number: index + 1, name: `d${index + 1}.md`, source: { kind: "linked" as const, ref: `ref-${index}`, bytes: 1, chars: 1 } })),
				next: { ...k.cell.read().next, document: count + 1 },
			}),
			writes: [{ kind: "text", text: joined, history: "reset", focus: false }],
		});
		return k;
	}

	it("lets a draft grow to the guard and refuses the attach that would pass it, whole, without the host's earlier refusals", async () => {
		const full = crowded(MAX_ATTACH_ITEMS - 1);
		assert.deepEqual(await full.run([text("last.md", 1)]), { alert: null });
		assert.equal(full.active().documents.length, MAX_ATTACH_ITEMS);
		assert.deepEqual(await full.run([text("over.md", 1)], ["earlier refusal."]), { alert: "At most 1000 files can be attached at once." });
		assert.equal(full.started(), 1, "a refused attach never started reading");
		assert.equal(full.cell.read().reading, 0);
		assert.equal(full.active().documents.length, MAX_ATTACH_ITEMS);
	});

	it("counts every entry of the call against the guard: two files when only one more fits", async () => {
		const almost = crowded(MAX_ATTACH_ITEMS - 1);
		assert.deepEqual(await almost.run([text("a.md", 1), text("b.md", 1)]), { alert: "At most 1000 files can be attached at once." });
		assert.deepEqual(almost.reader.calls, []);
	});

	it("takes the host's refusals alone into a draft that is exactly at the guard: nothing is added to it", async () => {
		const full = crowded(MAX_ATTACH_ITEMS);
		assert.deepEqual(await full.run([], ["notes.txt: not a PNG, JPEG, GIF, or WebP image."]), { alert: "notes.txt: not a PNG, JPEG, GIF, or WebP image." });
	});
});

describe("attach: reads in flight", () => {
	it("counts the reads in flight and releases them at the end, even when the files are refused", async () => {
		const k = kit();
		const gate = stubGate();
		const run = k.run([stubFile("a.png", 100, { classifyUntil: gate.promise }), stubFile("b.md", 5, { sort: { kind: "refused", reason: "b.md: no." } })]);
		await tick();
		assert.equal(k.cell.read().reading, 2, "one per entry, counted before the first read starts");
		gate.open();
		await run;
		assert.equal(k.cell.read().reading, 0);
	});

	it("reserves the bytes of an image while it is read: a second attach budgets against the same running total", async () => {
		const k = kit();
		const gate = stubGate();
		const first = k.run([image("first.png", 4 * MiB), stubFile("second.png", 4 * MiB, { classifyUntil: gate.promise })]);
		await tick();
		assert.equal(k.cell.read().reserved.bytes, 4 * MiB, "the first image is reserved while the second waits");
		assert.deepEqual(await k.run([image("third.png", 4 * MiB)]), { alert: null });
		gate.open();
		assert.deepEqual(await first, { alert: "second.png: this prompt would carry 12.0 MB of images; the limit is 10.0 MB per prompt." });
		assert.deepEqual(k.cell.read().images.map(entry => entry.name), ["third.png", "first.png"], "published in the order the attaches finished");
		assert.deepEqual(k.cell.read().reserved, { bytes: 0, chars: 0 });
		assert.equal(k.cell.read().reading, 0);
	});

	it("reserves the characters of a document the same way: an overlapping attach cannot overshoot the message", async () => {
		const k = kit();
		const gate = stubGate();
		const first = k.run([text("a.txt", 120_000), stubFile("b.txt", 10, { classifyUntil: gate.promise })]);
		await tick();
		assert.equal(k.cell.read().reserved.chars, 120_000);
		const second = await k.run([text("z.txt", 100_000)]);
		assert.match(second.alert ?? "", /^Adding z\.txt \(100.000 characters\) would take the draft over 200.000 characters\.$/);
		gate.open();
		assert.deepEqual(await first, { alert: null });
		assert.deepEqual(k.cell.read().reserved, { bytes: 0, chars: 0 });
		assert.deepEqual(k.active().documents, [1, 2]);
	});

	it("releases exactly what a failed read reserved, so the next attach has the whole budget again", async () => {
		const k = kit();
		assert.deepEqual(await k.run([stubFile("bad.png", 4 * MiB, { image: { ok: false, reason: "bad.png: nope." } })]), { alert: "bad.png: nope." });
		assert.deepEqual(k.cell.read().reserved, { bytes: 0, chars: 0 });
		assert.deepEqual(await k.run([stubFile("thrown.png", 4 * MiB, { image: "throw" })]), { alert: "thrown.png: could not be read." });
		assert.deepEqual(k.cell.read().reserved, { bytes: 0, chars: 0 });
		assert.deepEqual(await k.run([image("a.png", 5 * MiB), image("b.png", 5 * MiB)]), { alert: null }, "10 MiB fit again");
	});

	it("releases what it reserved when the reader itself throws instead of answering, and reports the error to the caller", async () => {
		const k = kit();
		const broken: AttachReader = { ...k.reader, classify: () => Promise.reject(new Error("boom")) };
		await assert.rejects(attach(k.cell, [{ kind: "file", file: image("a.png") }], broken, [], { started: () => {} }), /boom/);
		assert.equal(k.cell.read().reading, 0);
		assert.deepEqual(k.cell.read().reserved, { bytes: 0, chars: 0 });
	});

	it("gives each image its own key, in the order the reads begin, and never reuses one", async () => {
		const k = kit();
		await k.run([image("a.png"), image("b.png")]);
		await k.run([image("c.png")]);
		assert.deepEqual(k.reader.calls.filter(call => call.startsWith("readImage")), ["readImage a.png key 1", "readImage b.png key 2", "readImage c.png key 3"]);
		assert.equal(k.cell.read().next.key, 4);
	});

	it("publishes nothing when the composer is gone before the read ends", async () => {
		const k = kit();
		const gate = stubGate();
		const run = k.run([stubFile("a.png", 100, { readUntil: gate.promise })]);
		await tick();
		k.cell.dispose();
		gate.open();
		assert.deepEqual(await run, {});
		assert.deepEqual(k.cell.read().images, []);
	});

	it("starts again from the value as it is after the reads: an edit made meanwhile is kept and the marker lands at the new caret", async () => {
		const k = kit();
		const gate = stubGate();
		const run = k.run([stubFile("a.png", 100, { readUntil: gate.promise })]);
		await tick();
		k.type("typed meanwhile");
		gate.open();
		await run;
		assert.equal(k.cell.read().text, "typed meanwhile [Image #1, 10x6] ");
	});

	it("counts a drop the host reads through `readingBy`, and never goes below zero", () => {
		const k = kit();
		k.cell.commit(readingBy(k.cell.read(), 1));
		k.cell.commit(readingBy(k.cell.read(), 1));
		assert.equal(k.cell.read().reading, 2);
		k.cell.commit(readingBy(k.cell.read(), -1));
		k.cell.commit(readingBy(k.cell.read(), -1));
		k.cell.commit(readingBy(k.cell.read(), -1));
		assert.equal(k.cell.read().reading, 0);
		assert.equal(k.cell.read().revision, 0, "a read in flight is not an edit");
	});
});

describe("attach: retention for Undo", () => {
	it("keeps an image whose marker was deleted, so Undo brings marker and attachment back together", async () => {
		const k = kit();
		await k.run([image("a.png"), image("b.png")]);
		const full = k.cell.read().text;
		k.type(full.replace("[Image #1, 10x6] ", ""));
		assert.deepEqual(k.active().images, [2], "the attachment follows its marker out");
		assert.deepEqual(k.cell.read().images.map(entry => entry.number), [1, 2], "and stays in the list");
		k.type(full);
		assert.deepEqual(k.active().images, [1, 2], "Undo of the text brings it back");
	});

	it("releases the oldest deleted image when the retained bytes would pass the prompt budget, never an active or a new one", async () => {
		const k = kit();
		await k.run([image("a.png", 3 * MiB), image("b.png", 3 * MiB), image("c.png", 3 * MiB)]);
		k.type(k.cell.read().text.replace("[Image #1, 10x6] ", "").replace("[Image #2, 10x6] ", ""));
		await k.run([image("d.png", 3 * MiB)]);
		assert.deepEqual(k.cell.read().images.map(entry => entry.number), [2, 3, 4], "the oldest deleted one is released, the newer deleted one stays");
		assert.deepEqual(k.active().images, [3, 4]);
	});

	it("releases deleted held documents oldest first while the text they keep, the new document's included, would pass one message, and never a linked one", async () => {
		const k = kit();
		await k.link(linked("kept.md", "AbCdEf012345"));
		await k.run([text("a.md", 90_000), text("b.md", 90_000)]);
		assert.deepEqual(k.cell.read().documents.map(entry => entry.number), [1, 2, 3], "180 000 characters fit one message, and the two are new");
		k.type("");
		await k.run([text("c.md", 90_000)]);
		assert.deepEqual(k.cell.read().documents.map(entry => entry.number), [1, 3, 4], "270 000 would not: the oldest deleted held document went, the linked one costs nothing and stays");
		k.type("");
		await k.run([text("d.md", 90_000)]);
		assert.deepEqual(k.cell.read().documents.map(entry => entry.number), [1, 4, 5]);
	});
});

describe("removeAttachment", () => {
	const now = { composing: "wait", held: "drop" } as const;

	it("deletes the marker of that attachment from the text as one removal and keeps the others numbered as they were", async () => {
		const k = await three();
		k.cell.perform(removeAttachment("image", 2), now);
		assert.equal(k.cell.read().text, "A [Image #1, 10x6] B  C [Image #3, 30x9] D");
		assert.deepEqual(k.active().images, [1, 3]);
		assert.deepEqual(k.port.calls, ["write remove 21..37 focus"]);
	});

	it("deletes the next marker too, and the number goes on after the highest ever issued", async () => {
		const k = await three();
		k.cell.perform(removeAttachment("image", 1), now);
		assert.equal(k.cell.read().text, "A  B [Image #2, 20x8] C [Image #3, 30x9] D");
		await k.run([image("d.png", 100, 40, 11)]);
		assert.deepEqual(k.cell.read().images.map(entry => entry.number), [1, 2, 3, 4]);
	});

	it("keeps the attachment in the list while its marker is gone, and removes every copy of the marker", async () => {
		const k = await three();
		k.type(`${k.cell.read().text} [Image #1, 10x6]`);
		k.cell.perform(removeAttachment("image", 1), now);
		assert.equal(k.cell.read().text.includes("[Image #1"), false);
		assert.deepEqual(k.cell.read().images.map(entry => entry.number), [1, 2, 3]);
	});

	it("removes a document by its marker too", async () => {
		const k = kit();
		await k.run([text("notes.md", 4)]);
		k.cell.perform(removeAttachment("file", 1), now);
		assert.equal(k.cell.read().text, " ");
		assert.deepEqual(k.active().documents, []);
	});

	it("leaves prose alone: a marker with no attachment behind it is not removed, and the field has nothing to remove", () => {
		const k = kit();
		k.type("see [Image #7, 1x1] and [File #1: ghost.md]");
		const outcomes: string[] = [];
		k.cell.perform(removeAttachment("image", 7), now, outcome => outcomes.push(outcome.kind));
		assert.equal(k.cell.read().text, "see [Image #7, 1x1] and [File #1: ghost.md]");
		assert.deepEqual(outcomes, ["refused"]);
	});

	it("does nothing while no field is mounted", async () => {
		const k = await three();
		k.port.unmount();
		const outcomes: string[] = [];
		k.cell.perform(removeAttachment("image", 2), now, outcome => outcomes.push(outcome.kind));
		assert.deepEqual(outcomes, ["dropped"]);
		assert.deepEqual(k.active().images, [1, 2, 3]);
	});

	it("waits for an IME composition to end", async () => {
		const k = await three();
		k.port.openWindow();
		k.cell.perform(removeAttachment("image", 2), now);
		assert.deepEqual(k.active().images, [1, 2, 3]);
		k.port.closeWindow();
		assert.deepEqual(k.active().images, [1, 3]);
	});

	it("is dropped while the hand-off holds the draft", async () => {
		const k = await three();
		assert.notEqual(k.cell.capture(1), null);
		const outcomes: string[] = [];
		k.cell.perform(removeAttachment("image", 2), now, outcome => outcomes.push(outcome.kind));
		assert.deepEqual(outcomes, ["dropped"]);
		assert.deepEqual(k.active().images, [1, 2, 3]);
	});
});

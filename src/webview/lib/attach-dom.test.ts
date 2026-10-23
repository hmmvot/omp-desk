/**
 * What the composer reads from the `DataTransfer` of a paste or a drag and from the host's answer to a drop (`attach-dom.ts`).
 *
 * The regression defended is the silent one: a drop over the structural guard used to be cut at the limit and the rest
 * lost without a word. It is refused whole, with a sentence, and a drop at the guard is read in full.
 *
 * Runner: `node --test src/webview/lib/attach-dom.test.ts`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_ATTACH_ITEMS } from "../../shared/attach-limits.ts";
import { dragCarries, droppedFileUris, fileFromAttached, filesFrom } from "./attach-dom.ts";

/** The two methods `droppedFileUris` calls on a drag; the rest of `DataTransfer` is not read. */
function drop(codeUriList: string, uriList = ""): DataTransfer {
	const data = { getData: (type: string) => (type === "application/vnd.code.uri-list" ? codeUriList : type === "text/uri-list" ? uriList : "") };
	return data as unknown as DataTransfer;
}

/** A payload with `items` (a `kind` and, for a file, the `File` it gives) and `types`, as far as the helpers read it. */
function payload(items: readonly { kind: string; file?: File | null }[], types: readonly string[] = []): DataTransfer {
	const data = {
		items: items.map(item => ({ kind: item.kind, getAsFile: () => item.file ?? null })),
		types,
	};
	return data as unknown as DataTransfer;
}

const lines = (count: number) => Array.from({ length: count }, (_, index) => `file:///c%3A/repo/shot-${index}.png`);

describe("droppedFileUris", () => {
	it("reads every file URI of a drop in drag order and skips comments and other schemes", () => {
		const text = ["# a comment", "file:///c%3A/a.md", "https://example.com/x", "FILE:///c%3A/b.md", ""].join("\r\n");
		assert.deepEqual(droppedFileUris(drop(text), MAX_ATTACH_ITEMS), { uris: ["file:///c%3A/a.md", "FILE:///c%3A/b.md"], refusal: null });
		assert.deepEqual(droppedFileUris(drop("", "file:///c%3A/c.md"), MAX_ATTACH_ITEMS).uris, ["file:///c%3A/c.md"], "the plain uri-list is the fallback");
		assert.deepEqual(droppedFileUris(null, MAX_ATTACH_ITEMS), { uris: [], refusal: null });
	});

	it("reads a drop of exactly the guard in full and refuses one URI more as a whole", () => {
		const full = lines(MAX_ATTACH_ITEMS);
		assert.deepEqual(droppedFileUris(drop(full.join("\n")), MAX_ATTACH_ITEMS), { uris: full, refusal: null });
		const over = droppedFileUris(drop(lines(MAX_ATTACH_ITEMS + 1).join("\n")), MAX_ATTACH_ITEMS);
		assert.deepEqual(over.uris, [], "nothing of a refused drop is attached: not the first thousand either");
		assert.equal(over.refusal, "At most 1000 files can be attached at once.");
	});
});

describe("filesFrom", () => {
	it("gives the files of a payload in clipboard order and nothing for text items or no payload", () => {
		const first = new File(["a"], "a.png");
		const second = new File(["b"], "b.md");
		assert.deepEqual(filesFrom(payload([{ kind: "file", file: first }, { kind: "string" }, { kind: "file", file: second }])), [first, second]);
		assert.deepEqual(filesFrom(payload([{ kind: "string" }])), []);
		assert.deepEqual(filesFrom(null), []);
	});

	it("skips a file item the browser cannot hand over", () => {
		assert.deepEqual(filesFrom(payload([{ kind: "file", file: null }])), []);
	});
});

describe("dragCarries", () => {
	it("names what a drag carries by its type names: files, VS Code URIs, or nothing the composer takes", () => {
		assert.equal(dragCarries(payload([{ kind: "file" }], ["Files"])), "files");
		assert.equal(dragCarries(payload([{ kind: "string" }], ["application/vnd.code.uri-list"])), "uris");
		assert.equal(dragCarries(payload([{ kind: "string" }], ["ResourceURLs"])), "uris");
		assert.equal(dragCarries(payload([{ kind: "string" }], ["text/plain"])), null);
		assert.equal(dragCarries(payload([{ kind: "string" }], ["text/uri-list"])), null, "a web link is left to the browser");
	});
});

describe("fileFromAttached", () => {
	it("turns the base64 an image of the host carries back into a File of its name, type and bytes", async () => {
		const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
		const made = fileFromAttached({ name: "shot.png", mimeType: "image/png", data: Buffer.from(bytes).toString("base64") });
		assert.equal(made.name, "shot.png");
		assert.equal(made.type, "image/png");
		assert.deepEqual(new Uint8Array(await made.arrayBuffer()), bytes);
	});
});

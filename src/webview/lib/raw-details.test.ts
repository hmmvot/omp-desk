import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { COPY_STRING_CHARS, RAW_ARRAY_ITEMS, RAW_STRING_CHARS, rawDetailsCopy, rawDetailsView } from "./raw-details.ts";

describe("raw details", () => {
	it("cuts a long string and a long array in the view and says how much it left out", () => {
		const view = rawDetailsView({ text: "x".repeat(RAW_STRING_CHARS + 5), items: Array.from({ length: RAW_ARRAY_ITEMS + 3 }, (_, index) => index), short: "ok", n: 1, none: null }) as Record<string, unknown>;
		assert.equal(view.text, `${"x".repeat(RAW_STRING_CHARS)}… [+5 characters]`);
		assert.deepEqual(view.items, [...Array.from({ length: RAW_ARRAY_ITEMS }, (_, index) => index), "… [+3 more items]"]);
		assert.deepEqual([view.short, view.n, view.none], ["ok", 1, null]);
	});

	it("copies the whole object, cutting only the enormous strings and every array whole", () => {
		const details = { big: "y".repeat(COPY_STRING_CHARS + 1_000), list: Array.from({ length: 40 }, (_, index) => ({ index })), nested: { path: "C:\\work" } };
		const copied = JSON.parse(rawDetailsCopy(details)) as typeof details;
		assert.equal(copied.big, `${"y".repeat(COPY_STRING_CHARS)}… [+1,000 characters]`);
		assert.equal(copied.list.length, 40);
		assert.deepEqual(copied.nested, details.nested);
		assert.match(rawDetailsCopy({ a: 1 }), /^\{\n {2}"a": 1\n\}$/, "indented JSON");
	});

	it("never carries an image payload, in the view or in the copy", () => {
		const details = { content: [{ type: "image", mimeType: "image/png", data: "AAAA".repeat(100) }], url: `data:image/png;base64,${"B".repeat(50)}` };
		for (const text of [JSON.stringify(rawDetailsView(details)), rawDetailsCopy(details)]) {
			assert.ok(!text.includes("AAAA") && !text.includes("BBBB"), text);
			assert.match(text, /image data, 400 characters, not shown/);
		}
	});

	it("survives a structure nested beyond reason", () => {
		let deep: unknown = "end";
		for (let index = 0; index < 100; index++) deep = { deep };
		assert.match(rawDetailsCopy(deep), /nested too deeply/);
	});
});

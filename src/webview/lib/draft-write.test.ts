/**
 * The real `FieldPort` (`draft-write.ts`): which call of the editing surface each write of the Draft is. The surface is a recording fake that
 * has the members the port reads; its own rules (undo, composition, marker widening) are the browser tests'.
 *
 * Runner: `node --test src/webview/lib/draft-write.test.ts`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FieldEdit } from "./draft/draft.ts";
import type { DraftSurface } from "./draft-surface.ts";
import { createSurfacePort, type SurfacePort } from "./draft-write.ts";

/** The members of the surface the port reads and calls, as a recording fake; each refusal is scripted. */
class FakeSurface {
	readonly calls: string[] = [];
	composing = false;
	frozen = false;
	selectionStart = 0;
	selectionEnd = 0;
	refuses = false;
	setText(text: string, options: { caret?: number; history: string }): void {
		this.calls.push(`setText ${JSON.stringify(text)} ${JSON.stringify(options)}`);
	}
	focus(): void {
		this.calls.push("focus");
	}
	apply(edit: FieldEdit, kind: string): boolean {
		this.calls.push(`apply ${edit.from}..${edit.to} ${JSON.stringify(edit.insert)} ${kind}`);
		return !this.refuses;
	}
	removeRanges(ranges: readonly { from: number; to: number }[]): boolean {
		this.calls.push(`removeRanges ${ranges.map(range => `${range.from}..${range.to}`).join(",")}`);
		return !this.refuses;
	}
	setSelectionRange(start: number, end: number): void {
		this.calls.push(`setSelectionRange ${start} ${end}`);
	}
	refresh(): void {
		this.calls.push("refresh");
	}
	freeze(): void {
		this.calls.push("freeze");
		this.frozen = true;
	}
	thaw(): void {
		this.calls.push("thaw");
		this.frozen = false;
	}
}

/** The port reads only the members of {@link FakeSurface}; it is a `DraftSurface` here for the port's parameter type and nothing more. */
const asSurface = (fake: FakeSurface): DraftSurface => fake as unknown as DraftSurface;

function mounted(): { fake: FakeSurface; port: SurfacePort } {
	const fake = new FakeSurface();
	return { fake, port: createSurfacePort(() => asSurface(fake)) };
}

describe("the port with no field", () => {
	it("is not mounted, is not composing, has the caret at 0 and takes every write for done", () => {
		const port = createSurfacePort(() => null);
		assert.equal(port.mounted(), false);
		assert.equal(port.composing(), false);
		assert.deepEqual(port.selection(), { anchor: 0, focus: 0 });
		assert.equal(port.write({ kind: "text", text: "x", history: "record", focus: true }), true);
		assert.equal(port.write({ kind: "caret", at: 1, focus: true }), true);
		port.redraw();
		port.freeze();
		port.thaw();
		port.adopt();
	});
});

describe("the port over a surface", () => {
	it("reads the composition window and the selection of the surface", () => {
		const { fake, port } = mounted();
		fake.composing = true;
		fake.selectionStart = 2;
		fake.selectionEnd = 5;
		assert.equal(port.mounted(), true);
		assert.equal(port.composing(), true);
		assert.deepEqual(port.selection(), { anchor: 2, focus: 5 });
	});

	it("writes a text through `setText` with the history it was told, the caret only when there is one, and takes the focus after it when asked", () => {
		const { fake, port } = mounted();
		assert.equal(port.write({ kind: "text", text: "abc", history: "reset", focus: false }), true);
		assert.equal(port.write({ kind: "text", text: "abcd", caret: 2, history: "record", focus: true }), true);
		assert.deepEqual(fake.calls, ['setText "abc" {"history":"reset"}', 'setText "abcd" {"caret":2,"history":"record"}', "focus"]);
	});

	it("refuses a text while the surface is frozen: it would drop it, and the value must not claim it", () => {
		const { fake, port } = mounted();
		fake.frozen = true;
		assert.equal(port.write({ kind: "text", text: "abc", history: "record", focus: true }), false);
		assert.deepEqual(fake.calls, []);
	});

	it("writes an edit through `apply` with its kind, the focus first, and passes the surface's refusal on", () => {
		const { fake, port } = mounted();
		assert.equal(port.write({ kind: "edit", edit: { from: 1, to: 2, insert: "X" }, as: "marker", focus: true }), true);
		fake.refuses = true;
		assert.equal(port.write({ kind: "edit", edit: { from: 0, to: 0, insert: "Y" }, as: "replace", focus: false }), false);
		assert.deepEqual(fake.calls, ["focus", 'apply 1..2 "X" marker', 'apply 0..0 "Y" replace']);
	});

	it("writes a removal through `removeRanges` with the focus first, and passes the refusal on", () => {
		const { fake, port } = mounted();
		assert.equal(port.write({ kind: "remove", ranges: [{ from: 3, to: 9 }, { from: 12, to: 14 }], focus: true }), true);
		fake.refuses = true;
		assert.equal(port.write({ kind: "remove", ranges: [], focus: false }), false);
		assert.deepEqual(fake.calls, ["focus", "removeRanges 3..9,12..14", "removeRanges "]);
	});

	it("moves the caret by collapsing the selection there, with the focus first when asked", () => {
		const { fake, port } = mounted();
		assert.equal(port.write({ kind: "caret", at: 4, focus: true }), true);
		assert.equal(port.write({ kind: "caret", at: 6, focus: false }), true);
		assert.deepEqual(fake.calls, ["focus", "setSelectionRange 4 4", "setSelectionRange 6 6"]);
	});

	it("draws the surface again on redraw", () => {
		const { fake, port } = mounted();
		port.redraw();
		assert.deepEqual(fake.calls, ["refresh"]);
	});
});

describe("freezing", () => {
	it("freezes and thaws the surface it has", () => {
		const { fake, port } = mounted();
		port.freeze();
		port.thaw();
		assert.deepEqual(fake.calls, ["freeze", "thaw"]);
	});

	it("freezes a field that mounts while the draft is held, once it is adopted, and not after the release", () => {
		let surface: FakeSurface | null = null;
		const port = createSurfacePort(() => (surface === null ? null : asSurface(surface)));
		port.freeze();
		surface = new FakeSurface();
		port.adopt();
		assert.deepEqual(surface.calls, ["freeze"]);
		port.thaw();
		const later = new FakeSurface();
		surface = later;
		port.adopt();
		assert.deepEqual(later.calls, [], "a field that mounts after the release is never frozen");
	});
});

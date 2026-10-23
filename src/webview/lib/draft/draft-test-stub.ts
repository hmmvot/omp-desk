/**
 * Test stubs of the Draft module's two seams, shared by its node tests: a {@link FieldPort} that records what the cell asks of the field
 * and simulates the editing surface's rules (a composition window, a frozen field, the echo of an applied edit), and an
 * {@link AttachReader} whose classification, reads and timing a test scripts. Never imported by a file that ships.
 */
import type { AttachReader } from "./attach.ts";
import type { DocumentRead, FileClass } from "./attached-documents.ts";
import type { ImageRead } from "./attachments.ts";
import type { DraftCell } from "./cell.ts";
import type { FieldPort, Selection, Write } from "./field.ts";

type Range = { readonly from: number; readonly to: number; readonly insert: string };

export interface StubPort extends FieldPort {
	/** Every call the cell made, in order: `write text "x"`, `write edit 3..3 "y" as replace`, `freeze`, ... */
	readonly calls: string[];
	/** The string the field holds. */
	text: string;
	/** The field's selection. */
	selected: Selection;
	/** Text written while a window was open, applied when it closes. */
	queued: string | null;
	/** What the surface does to an edit without a selection: widen it over a marker it cuts into. `null` leaves edits as asked. */
	widen: ((edit: Range) => Range) | null;
	readonly frozen: boolean;
	readonly redraws: number;
	/** The cell the field echoes to: after an applied `edit` or `remove`, as the surface calls `onEdit`. */
	bind(cell: DraftCell): void;
	mount(): void;
	unmount(): void;
	/** A composition window opens: the browser owns the field's DOM and `edit`, `remove` refuse. The cell is told, as the surface tells it. */
	openWindow(): void;
	/** The window closes: a text queued meanwhile is applied and reported, then the draft is settled. */
	closeWindow(): void;
	/** The next `write` refuses once. */
	refuseNext(): void;
}

function describe(write: Write): string {
	switch (write.kind) {
		case "text":
			return `write text ${JSON.stringify(write.text)}${write.caret === undefined ? "" : ` caret ${write.caret}`} ${write.history}${write.focus ? " focus" : ""}`;
		case "edit":
			return `write edit ${write.edit.from}..${write.edit.to} ${JSON.stringify(write.edit.insert)} as ${write.as}${write.focus ? " focus" : ""}`;
		case "remove":
			return `write remove ${write.ranges.map(range => `${range.from}..${range.to}`).join(",")}${write.focus ? " focus" : ""}`;
		case "caret":
			return `write caret ${write.at}${write.focus ? " focus" : ""}`;
	}
}

export function stubPort(text = ""): StubPort {
	let cell: DraftCell | null = null;
	let mounted = true;
	let composing = false;
	let refuse = false;
	let frozen = false;
	let redraws = 0;
	const port: StubPort = {
		calls: [],
		text,
		selected: { anchor: text.length, focus: text.length },
		queued: null,
		widen: null,
		get frozen() {
			return frozen;
		},
		get redraws() {
			return redraws;
		},
		bind(target) {
			cell = target;
		},
		mount() {
			mounted = true;
		},
		unmount() {
			mounted = false;
		},
		openWindow() {
			composing = true;
			cell?.windowOpened();
		},
		closeWindow() {
			composing = false;
			if (port.queued !== null) {
				port.text = port.queued;
				port.queued = null;
				cell?.edited(port.text);
			}
			cell?.settled();
		},
		refuseNext() {
			refuse = true;
		},
		mounted: () => mounted,
		composing: () => composing,
		selection: () => port.selected,
		redraw() {
			redraws++;
			port.calls.push("redraw");
		},
		freeze() {
			frozen = true;
			port.calls.push("freeze");
		},
		thaw() {
			frozen = false;
			port.calls.push("thaw");
		},
		write(write: Write): boolean {
			port.calls.push(describe(write));
			if (refuse) {
				refuse = false;
				return false;
			}
			switch (write.kind) {
				case "text": {
					if (frozen) return false;
					if (composing) {
						port.queued = write.text;
						return true;
					}
					const changed = write.text !== port.text;
					port.text = write.text;
					const at = Math.min(write.caret ?? (changed ? write.text.length : port.selected.focus), write.text.length);
					port.selected = { anchor: at, focus: at };
					return true;
				}
				case "edit": {
					if (frozen || composing) return false;
					const { from, to, insert } = write.edit.selection === undefined && port.widen !== null ? port.widen(write.edit) : write.edit;
					port.text = port.text.slice(0, from) + insert + port.text.slice(to);
					port.selected = write.edit.selection ?? { anchor: from + insert.length, focus: from + insert.length };
					cell?.edited(port.text);
					return true;
				}
				case "remove": {
					if (frozen || composing || write.ranges.length === 0) return false;
					let next = port.text;
					for (const range of [...write.ranges].sort((a, b) => b.from - a.from)) next = next.slice(0, range.from) + next.slice(range.to);
					const at = Math.min(...write.ranges.map(range => range.from));
					port.text = next;
					port.selected = { anchor: at, focus: at };
					cell?.edited(port.text);
					return true;
				}
				case "caret":
					port.selected = { anchor: write.at, focus: write.at };
					return true;
			}
		},
	};
	return port;
}

/** A gate a test opens when it wants a read to go on: `await gate.promise` waits, `gate.open()` lets it through. */
export function stubGate(): { readonly promise: Promise<void>; open(): void } {
	const { promise, resolve } = Promise.withResolvers<void>();
	return { promise, open: resolve };
}

/** Lets every promise that can settle without a gate settle: the reads a test started run as far as their next gate. */
export function tick(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	return promise;
}

/** What a scripted reader answers for a file; each defaults to the plain case (`name.png` is an image, anything else text). */
export interface StubFileScript {
	/** The first bytes' verdict; `undefined` classifies by extension. */
	readonly sort?: FileClass;
	/** The image read, or a read that throws; `undefined` reads a 10x6 PNG. */
	readonly image?: ImageRead | "throw";
	/** The document read, or a read that throws; `undefined` reads `size` characters of `x`. */
	readonly document?: DocumentRead | "throw";
	/** The size in pixels of the default image read. */
	readonly pixels?: { readonly width: number; readonly height: number };
	/** The classification does not answer until this opens. */
	readonly classifyUntil?: Promise<void>;
	/** The read does not answer until this opens (the image's or the document's). */
	readonly readUntil?: Promise<void>;
}

const scripts = new WeakMap<File, StubFileScript>();

/** A file the stub reader answers for; the algorithm itself only ever reads `name` and `size`, so the object is a `File` only in type. */
export function stubFile(name: string, size: number, script: StubFileScript = {}): File {
	const file = { name, size, type: "" } as File;
	scripts.set(file, script);
	return file;
}

const scriptOf = (file: File): StubFileScript => scripts.get(file) ?? {};

export interface StubReader extends AttachReader {
	/** Calls in order: `classify a.png`, `readImage a.png key 1`, `readDocument a.md`. */
	readonly calls: string[];
}

export function stubReader(): StubReader {
	const calls: string[] = [];
	return {
		calls,
		async classify(file) {
			calls.push(`classify ${file.name}`);
			const script = scriptOf(file);
			await script.classifyUntil;
			if (script.sort !== undefined) return script.sort;
			return /\.(png|jpe?g|gif|webp)$/i.test(file.name) ? { kind: "image" } : { kind: "text" };
		},
		async readImage(file, key) {
			calls.push(`readImage ${file.name} key ${key}`);
			const script = scriptOf(file);
			await script.readUntil;
			if (script.image === "throw") throw new Error("read failed");
			if (script.image !== undefined) return script.image;
			const pixels = script.pixels ?? { width: 10, height: 6 };
			return { ok: true, image: { id: key, name: file.name, mimeType: "image/png", bytes: file.size, data: `data-${file.name}`, ...pixels } };
		},
		async readDocument(file) {
			calls.push(`readDocument ${file.name}`);
			const script = scriptOf(file);
			await script.readUntil;
			if (script.document === "throw") throw new Error("read failed");
			if (script.document !== undefined) return script.document;
			return { ok: true, content: "x".repeat(file.size), bytes: file.size };
		},
	};
}

/**
 * The paint of magic keywords: one CSS highlight per keyword and gradient stop, `::highlight(omp-magic-<id>-<stop>)`
 * (`magic-keyword-styles.ts` gives each its colour), so a keyword is painted without a single change to the DOM of the composer or
 * of a message (the composer's caret, selection, IME and undo, React's rows and the transcript's windowing stay as they are). Where
 * the Custom Highlight API is missing nothing is painted.
 *
 * Every place that shows keywords (the composer, each sent message) owns a {@link MagicKeywordLayer}; the highlights hold the
 * characters of all the layers, each character on the stop its layer's phase gives it. The highlights have priority -1: Find in the
 * conversation (priority 0 and 1) paints its own colours over a keyword it matches.
 */
import { magicStopAt, type MagicKeywordId } from "../../shared/magic-keywords.ts";
import { canHighlight } from "./find-dom.ts";
import { magicHighlightName } from "./magic-keyword-name.ts";
import { refreshMagicKeywordSettings } from "./magic-keyword-settings.ts";

/** One keyword standing in a layer's text: a range per character, in order, which is what a gradient needs. */
export interface PlacedKeyword {
	readonly id: MagicKeywordId;
	readonly chars: readonly Range[];
}

const layers = new Set<MagicKeywordLayer>();
const shown = new Map<string, Highlight>();
let rebuildQueued = false;
let watchingWindow = false;

function rebuild(): void {
	rebuildQueued = false;
	if (!canHighlight()) return;
	const wanted = new Map<string, Range[]>();
	for (const layer of layers) layer.collect(wanted);
	for (const [name, ranges] of wanted) {
		let highlight = shown.get(name);
		if (highlight === undefined) {
			highlight = new Highlight();
			highlight.priority = -1;
			shown.set(name, highlight);
			CSS.highlights.set(name, highlight);
		}
		highlight.clear();
		for (const range of ranges) highlight.add(range);
	}
	for (const name of [...shown.keys()]) {
		if (wanted.has(name)) continue;
		CSS.highlights.delete(name);
		shown.delete(name);
	}
}

/** Layers change in bursts (a transcript mounting its rows, the composer on every keystroke): the highlights are rebuilt once after the burst. */
function queueRebuild(): void {
	if (rebuildQueued) return;
	rebuildQueued = true;
	queueMicrotask(rebuild);
}

/**
 * A setting changed while the page was away is picked up when the page is back: the window regaining focus asks the host again,
 * whatever the age of the last question, if any layer shows a keyword (the host's 5 s answer cache bounds the work).
 */
function watchWindow(): void {
	if (watchingWindow || typeof window === "undefined") return;
	watchingWindow = true;
	window.addEventListener("focus", () => {
		for (const layer of layers) {
			if (!layer.sighted) continue;
			refreshMagicKeywordSettings();
			return;
		}
	});
}

/** The keywords one place shows, and the phase of its gradient. */
export class MagicKeywordLayer {
	#placed: readonly PlacedKeyword[] = [];
	#phase = 0;
	/** Whether a keyword word stands in the place's text, whether or not OMP acts on it: the reason to ask the host what it acts on. */
	sighted = false;

	constructor() {
		layers.add(this);
		watchWindow();
	}

	/** How many keywords are painted. */
	get painted(): number {
		return this.#placed.length;
	}

	/** Replaces what the layer paints. */
	set(placed: readonly PlacedKeyword[], sighted: boolean): void {
		this.#placed = placed;
		this.sighted = sighted;
		queueRebuild();
	}

	/** Moves the gradient: a phase in [0, 1) rotates the stops along the word (OMP's shimmer); 0 is the static gradient. */
	setPhase(phase: number): void {
		if (phase === this.#phase) return;
		this.#phase = phase;
		if (this.#placed.length > 0) queueRebuild();
	}

	/** Adds this layer's characters to `into`, by highlight name. */
	collect(into: Map<string, Range[]>): void {
		for (const keyword of this.#placed) {
			const length = keyword.chars.length;
			keyword.chars.forEach((range, index) => {
				const name = magicHighlightName(keyword.id, magicStopAt(index, length, this.#phase));
				const ranges = into.get(name);
				if (ranges === undefined) into.set(name, [range]);
				else ranges.push(range);
			});
		}
	}

	/** Removes the layer's paint. */
	dispose(): void {
		if (!layers.delete(this)) return;
		this.#placed = [];
		this.sighted = false;
		queueRebuild();
	}
}

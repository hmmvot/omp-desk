/**
 * Keeps the magic keywords of the composer and of a sent message painted (`magic-keyword-paint.ts`) as their text changes.
 *
 * Both follow the DOM, not the code that writes it: a `MutationObserver` rescans the text after every change, whoever made it (the
 * draft surface rendering a keystroke, an IME composing, React committing a message), and the store of OMP's settings rescans when
 * the host names other keywords. Nothing here writes to the DOM, and a text that holds no keyword word costs one string probe.
 *
 * The composer's keywords shimmer as OMP's editor does while the field has the keyboard focus: one frame every 70 ms, one sweep of
 * the gradient in 1800 ms, gradient only, never moving, for a reader who asked for reduced motion (or whose colours the system
 * forces). A sent message's keywords stand still, as in OMP's message bubbles.
 */
import {
	findMagicKeywords,
	MAGIC_KEYWORDS,
	MAGIC_SHIMMER_FRAME_MS,
	magicPhaseAt,
	type MagicKeywordId,
} from "../../shared/magic-keywords.ts";
import { MagicKeywordLayer } from "./magic-keyword-paint.ts";
import { placeKeywords, scanBubble, scanComposer, withinOneNode, type ScannedText } from "./magic-keyword-scan.ts";
import { getMagicKeywordSettings, refreshMagicKeywordSettings, requestMagicKeywordSettings, subscribeMagicKeywordSettings } from "./magic-keyword-settings.ts";

/** Whether `text` could hold a keyword: a probe for each word, before anything is parsed. */
export function mayHoldMagicKeyword(text: string): boolean {
	return MAGIC_KEYWORDS.some(keyword => text.includes(keyword.word));
}

/**
 * Paints the keywords OMP acts on in `scanned` into `layer`. Asks the host what OMP acts on when a keyword stands there at all.
 * `only` is for a sent message: OMP matches the prompt's raw text, so a keyword it finds nowhere there is not painted, and it paints
 * one Markdown text run at a time, so a word the rendered text joins across elements (`[ultra](url)think`) is not painted either.
 */
function paint(layer: MagicKeywordLayer, scanned: ScannedText, only?: ReadonlySet<MagicKeywordId>): void {
	const found = mayHoldMagicKeyword(scanned.text) ? findMagicKeywords(scanned.text) : [];
	if (found.length > 0) requestMagicKeywordSettings();
	const enabled = getMagicKeywordSettings();
	layer.set(placeKeywords(scanned, found.filter(match => enabled.has(match.id) && (only === undefined || (only.has(match.id) && withinOneNode(scanned, match.from, match.to))))), found.length > 0);
}

/** Runs `work` once in the microtask after the first of any number of calls: a burst of mutations is one rescan. */
function coalesced(work: () => void): () => void {
	let queued = false;
	return () => {
		if (queued) return;
		queued = true;
		queueMicrotask(() => {
			queued = false;
			work();
		});
	};
}

/** The composer's keywords: painted as the draft changes, shimmering while the field has the keyboard focus. */
export class ComposerKeywords {
	readonly #element: HTMLElement;
	readonly #layer = new MagicKeywordLayer();
	readonly #observer: MutationObserver;
	readonly #cleanup: (() => void)[] = [];
	readonly #reducedMotion: MediaQueryList | null;
	readonly #forcedColors: MediaQueryList | null;
	#timer: number | null = null;
	#disposed = false;

	constructor(element: HTMLElement) {
		this.#element = element;
		const view = element.ownerDocument.defaultView;
		const media = (query: string): MediaQueryList | null => (typeof view?.matchMedia === "function" ? view.matchMedia(query) : null);
		this.#reducedMotion = media("(prefers-reduced-motion: reduce)");
		this.#forcedColors = media("(forced-colors: active)");
		const rescan = coalesced(() => this.#rescan());
		this.#observer = new MutationObserver(rescan);
		this.#observer.observe(element, { childList: true, characterData: true, subtree: true });
		this.#cleanup.push(subscribeMagicKeywordSettings(rescan));
		const resync = (): void => this.#sync();
		const focus = (): void => {
			// The keyboard comes back to a field that shows a keyword: a setting changed meanwhile is picked up, inside the throttle's period too.
			if (this.#layer.sighted) refreshMagicKeywordSettings();
			this.#sync();
		};
		this.#listen(element, "focus", focus);
		this.#listen(element, "blur", resync);
		this.#listen(element.ownerDocument, "visibilitychange", resync);
		this.#listen(this.#reducedMotion, "change", resync);
		this.#listen(this.#forcedColors, "change", resync);
		// The window losing the keyboard to another application keeps `activeElement` and the page visible: only these two say so.
		this.#listen(view, "focus", resync);
		this.#listen(view, "blur", resync);
		this.#rescan();
	}

	#listen(target: EventTarget | null, type: string, handler: () => void): void {
		if (target === null) return;
		target.addEventListener(type, handler);
		this.#cleanup.push(() => target.removeEventListener(type, handler));
	}

	#rescan(): void {
		if (this.#disposed) return;
		paint(this.#layer, scanComposer(this.#element));
		this.#sync();
	}

	/** Whether the gradient moves now: the field has the focus in a window that has it, shows a keyword, the page is visible and the reader accepts motion. */
	#shimmering(): boolean {
		const doc = this.#element.ownerDocument;
		return (
			this.#layer.painted > 0 &&
			doc.activeElement === this.#element &&
			doc.visibilityState === "visible" &&
			doc.hasFocus() &&
			this.#reducedMotion?.matches !== true &&
			this.#forcedColors?.matches !== true
		);
	}

	#sync(): void {
		if (this.#disposed) return;
		if (this.#shimmering()) {
			if (this.#timer === null) this.#frame();
			return;
		}
		if (this.#timer !== null) {
			this.#element.ownerDocument.defaultView?.clearTimeout(this.#timer);
			this.#timer = null;
		}
		this.#layer.setPhase(0);
	}

	#frame(): void {
		this.#layer.setPhase(magicPhaseAt(Date.now()));
		this.#timer = this.#element.ownerDocument.defaultView?.setTimeout(() => {
			this.#timer = null;
			if (this.#shimmering()) this.#frame();
			else this.#sync();
		}, MAGIC_SHIMMER_FRAME_MS) ?? null;
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#observer.disconnect();
		for (const stop of this.#cleanup.splice(0)) stop();
		if (this.#timer !== null) this.#element.ownerDocument.defaultView?.clearTimeout(this.#timer);
		this.#timer = null;
		this.#layer.dispose();
	}
}

/**
 * Paints the keywords of a sent message (`root` holds its Markdown, `raw` is the prompt text OMP matched) and keeps them painted while
 * its DOM or OMP's settings change. Returns what undoes it.
 */
export function mountBubbleKeywords(root: HTMLElement, raw: string): () => void {
	const layer = new MagicKeywordLayer();
	const only = new Set(findMagicKeywords(raw).map(match => match.id));
	let mounted = true;
	const rescan = coalesced(() => {
		if (mounted) paint(layer, scanBubble(root), only);
	});
	const observer = new MutationObserver(rescan);
	observer.observe(root, { childList: true, characterData: true, subtree: true });
	const stop = subscribeMagicKeywordSettings(rescan);
	paint(layer, scanBubble(root), only);
	return () => {
		mounted = false;
		observer.disconnect();
		stop();
		layer.dispose();
	};
}

export type TranscriptScrollMode = "following" | "detached";
/** `offset` is the anchor's distance below the viewport top when captured at viewport `height`. */
export interface SourceAnchor { sources: readonly string[]; offset: number; height: number; order: readonly string[]; index: number }
export interface TranscriptScrollBindings {
	sources(key: string): readonly string[];
	order(): readonly string[];
	changed(mode: TranscriptScrollMode): void;
	viewport(): void;
	reset(): void;
	held?(): boolean;
}
const BOTTOM_PROXIMITY = 40;

/** The only outer scroll writer. Scroll events are geometry, not user intent. */
export class TranscriptScrollController {
	mode: TranscriptScrollMode = "following";
	#anchor: SourceAnchor | null = null;
	#frame: number | null = null;
	#intent: { top: number; until: number; dragging: boolean; upward: boolean } | null = null;
	#written: number | null = null;
	#intentTimer: number | undefined;
	#pageStart = false;
	#explicitFollowing = false;
	#observer: ResizeObserver;
	#cleanup: (() => void)[] = [];
	#observedTop: number;
	get anchor(): SourceAnchor | null { return this.#explicitFollowing || this.#intentActive() ? null : this.#anchor; }
	constructor(readonly root: HTMLElement, content: HTMLElement, readonly bindings: TranscriptScrollBindings) {
		this.#observedTop = root.scrollTop;
		// Observer callbacks run after layout and before paint: a growing tail or a resized dock is absorbed in the frame it appears in, not one frame later.
		this.#observer = new ResizeObserver(() => { if (this.#pageStart) this.layout(); else this.#apply(); });
		this.#observer.observe(root); this.#observer.observe(content);
		const listen = <K extends keyof HTMLElementEventMap>(name: K, handler: (event: HTMLElementEventMap[K]) => void, options?: AddEventListenerOptions) => {
			root.addEventListener(name, handler, options); this.#cleanup.push(() => root.removeEventListener(name, handler, options));
		};
		listen("wheel", event => { if (event.deltaY !== 0) this.#evidence(false, event.deltaY < 0); }, { passive: true, capture: true });
		listen("keydown", event => {
			const target = event.target instanceof Element ? event.target : null;
			if (target?.closest("input,textarea,select,[contenteditable=true],[role=menu],[role=combobox]")) return;
			const direction = ["PageUp", "Home", "ArrowUp"].includes(event.key) ? -1 : ["PageDown", "End", "ArrowDown"].includes(event.key) || event.key === " " && !target?.closest("button,summary") ? 1 : 0;
			if (direction) this.#evidence(false, direction < 0);
		}, { capture: true });
		listen("pointerdown", event => {
			const scrollbar = event.target === root && event.clientX >= root.getBoundingClientRect().left + root.clientWidth;
			if (event.pointerType === "touch" || event.button === 1 || scrollbar) this.#evidence(true);
		}, { capture: true });
		const released = () => { if (this.#intent) { this.#intent.dragging = false; this.#intent.until = performance.now() + 250; this.#resumeAfterIntent(); } };
		document.addEventListener("pointerup", released); document.addEventListener("pointercancel", released);
		this.#cleanup.push(() => { document.removeEventListener("pointerup", released); document.removeEventListener("pointercancel", released); });
		listen("scroll", event => {
			if (event.target !== root) return;
			const written = this.#written !== null && Math.abs(root.scrollTop - this.#written) < 1;
			this.#written = null;
			const intent = this.#intent;
			if (!written && intent && (intent.dragging || performance.now() <= intent.until) && Math.abs(root.scrollTop - intent.top) > 0.5) {
				this.#setMode(!intent.upward && root.scrollHeight - root.clientHeight - root.scrollTop <= BOTTOM_PROXIMITY ? "following" : "detached");
				this.#explicitFollowing = this.mode === "following";
				intent.top = root.scrollTop;
				if (this.mode === "detached") this.#capture(); else this.#anchor = null;
			}
			this.#observedTop = root.scrollTop;
			this.bindings.viewport();
		}, { passive: true });
		this.layout();
	}
	#evidence(dragging: boolean, upward = false): void {
		// Only leaving the tail is a reader's intent. Downward input while following (a wheel nudge, Space, End) has nowhere to go and must not pause the pin, or growth inside its window reads as being scrolled away.
		if (!dragging && !upward && this.mode === "following") return;
		if (this.#frame !== null) cancelAnimationFrame(this.#frame);
		this.#frame = null;
		// Compositor scrolling may precede passive wheel delivery; retain the last observed pre-input geometry.
		this.#written = null;
		this.#intent = { top: this.#observedTop, until: performance.now() + 250, dragging, upward };
		// Detach before a layout or virtualizer update can pin compositor wheel movement back to the tail.
		if (upward) { this.#explicitFollowing = false; this.#setMode("detached"); this.#capture(); }
		this.#resumeAfterIntent();
	}
	#resumeAfterIntent(): void {
		window.clearTimeout(this.#intentTimer);
		this.#intentTimer = window.setTimeout(() => {
			this.#intentTimer = undefined;
			if (this.#intent?.dragging) return;
			this.#intent = null;
			if (this.mode === "detached") this.#capture();
			this.layout();
		}, 251);
	}
	#setMode(mode: TranscriptScrollMode): void { if (mode !== this.mode) { this.mode = mode; this.bindings.changed(mode); } }
	#elements(): HTMLElement[] { return [...this.root.querySelectorAll<HTMLElement>("[data-anchor-key]")]; }
	#capture(): void {
		const top = this.root.getBoundingClientRect().top;
		const bottom = top + this.root.clientHeight;
		let candidate: HTMLElement | null = null;
		for (const element of this.#elements()) {
			// Inline child content has independent source keys, not anchors for this transcript.
			if (this.bindings.sources(element.dataset.anchorKey!).length === 0) continue;
			const rect = element.getBoundingClientRect();
			if (rect.bottom <= top || rect.top >= bottom || rect.height === 0) continue;
			if (!candidate || candidate.contains(element)) candidate = element;
			else if (!element.contains(candidate)) break;
		}
		if (!candidate) { this.#anchor = null; return; }
		const sources = this.bindings.sources(candidate.dataset.anchorKey!);
		const order = this.bindings.order();
		this.#anchor = { sources, offset: candidate.getBoundingClientRect().top - top, height: this.root.clientHeight, order, index: order.findIndex(id => sources.includes(id)) };
	}
	#write(top: number): void {
		const clamped = Math.max(0, Math.min(top, this.root.scrollHeight - this.root.clientHeight));
		if (Math.abs(this.root.scrollTop - clamped) < 0.5) return;
		this.#written = clamped; this.#observedTop = clamped; this.root.scrollTop = clamped;
	}
	#restore(): void {
		const anchor = this.#anchor;
		if (!anchor) { this.#capture(); return; }
		const elements = this.#elements();
		const find = (ids: readonly string[]) => elements.findLast(element => this.bindings.sources(element.dataset.anchorKey!).some(id => ids.includes(id)));
		let element = find(anchor.sources.slice(0, 1)) ?? find(anchor.sources);
		if (!element) {
			for (let distance = 1; !element && distance <= anchor.order.length; distance++) {
				const before = anchor.order[anchor.index - distance], after = anchor.order[anchor.index + distance];
				element = find([...(before ? [before] : []), ...(after ? [after] : [])]);
			}
			if (element) { this.#anchor = { ...anchor, sources: this.bindings.sources(element.dataset.anchorKey!) }; this.bindings.reset(); }
		}
		// The dock owns the viewport's bottom edge: when its height changes, the line at that edge stays put and the reading offset from the top absorbs the difference.
		if (element) this.#write(this.root.scrollTop + element.getBoundingClientRect().top - this.root.getBoundingClientRect().top - (anchor.offset + this.root.clientHeight - anchor.height));
	}
	/** Capture before an explicit prepend/page/density operation. */
	hold(): void { this.#explicitFollowing = false; this.#intent = null; this.#setMode("detached"); this.#capture(); }
	/** A new native interaction may hold live content; old focus cannot veto an explicit Latest action. */
	retain(): void { this.#explicitFollowing = false; this.#capture(); }
	jump(): void { this.#pageStart = false; this.#explicitFollowing = true; this.#intent = null; this.#anchor = null; this.#setMode("following"); this.layout(); }
	pageStart(): void { this.#pageStart = true; this.#explicitFollowing = false; this.#intent = null; this.#anchor = null; this.#setMode("detached"); this.layout(); }
	/** Detach and bring the row carrying one of `sources` into view, a third of the way down (Rewind's selected prompt). */
	reveal(sources: readonly string[]): void {
		this.#pageStart = false; this.#explicitFollowing = false; this.#intent = null;
		const order = this.bindings.order();
		this.#anchor = { sources, offset: Math.round(this.root.clientHeight / 3), height: this.root.clientHeight, order, index: order.findIndex(id => sources.includes(id)) };
		this.#setMode("detached");
		this.layout();
	}
	/** Whether native wheel/key/pointer movement still owns geometry. */
	#intentActive(): boolean { return this.#intent !== null && (this.#intent.dragging || performance.now() <= this.#intent.until); }
	/** Following means the bottom, whatever grew: callers run inside a layout effect or an observer, so the write lands before paint. */
	#pinFollowing(): void {
		if (this.mode !== "following" || this.#pageStart || this.root.clientHeight === 0 || this.#intentActive()) return;
		if (this.#explicitFollowing || !this.bindings.held?.()) this.#write(this.root.scrollHeight - this.root.clientHeight);
	}
	#apply(): void {
		if (this.root.clientHeight === 0) return;
		// Native compositor movement owns geometry until its intent settles. Restoring
		// the pre-wheel anchor here would undo a detached wheel before its scroll event.
		if (this.#intentActive()) { this.bindings.viewport(); return; }
		if (this.#pageStart) { this.#pageStart = false; this.#write(0); this.#capture(); }
		else if (this.mode === "following" && (this.#explicitFollowing || !this.bindings.held?.())) this.#write(this.root.scrollHeight - this.root.clientHeight); else this.#restore();
		this.bindings.viewport();
	}
	layout(): void {
		this.#pinFollowing();
		if (this.#frame !== null) return;
		this.#frame = requestAnimationFrame(() => { this.#frame = null; this.#apply(); });
	}
	dispose(): void { if (this.#frame !== null) cancelAnimationFrame(this.#frame); window.clearTimeout(this.#intentTimer); this.#observer.disconnect(); for (const cleanup of this.#cleanup) cleanup(); }
}

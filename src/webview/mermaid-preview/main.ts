/**
 * The page of the diagram tab (`ompDesk.mermaidPreview`): one mermaid source the chat page would not draw inline, drawn here.
 *
 * The document (`createMermaidPreviewHtml`) loads `media/mermaid.js` and then this script. The page announces itself, the
 * host answers with the source (`omp:mermaid-preview-source`), and the page shows **Rendering…** before it asks the renderer
 * for the diagram in the tab's wider limits (scope `tab`). A render is one uninterruptible task that cannot be cancelled; the
 * reader cancels by closing the tab. The spinner is a CSS transform animation, which keeps moving while the main thread is
 * busy. A failure shows the message and the source.
 */
import { MERMAID_CONTRACT, MERMAID_GLOBAL, type OmpMermaid } from "../mermaid/contract.ts";
import { mermaidImage } from "../lib/mermaid-image.ts";
import { readPageTheme, watchPageTheme, type PageTheme } from "../lib/mermaid-theme-dom.ts";
import { adoptNonceForCreatedStyles } from "../lib/nonce-styles.ts";
import { parseMermaidPreviewSource } from "../../protocol/mermaid-preview.ts";
import { mermaidKind } from "../../shared/mermaid-source.ts";
import { MERMAID_PREVIEW_STYLES } from "./styles.ts";

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

const ZOOM_STEP = 1.25;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 8;
/** A render that took longer than this is not repeated by itself when the theme changes: the reader is offered **Redraw**. */
const SLOW_RENDER_MS = 2_000;

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (className !== undefined) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

function button(label: string, title: string, onClick: () => void): HTMLButtonElement {
	const node = element("button", undefined, label);
	node.type = "button";
	node.title = title;
	node.addEventListener("click", onClick);
	return node;
}

/** Two frames and a task: whatever was queued to paint (the busy state) has been painted before a render blocks the thread. */
function painted(): Promise<void> {
	return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 0))));
}

function start(): void {
	const nonce = (document.currentScript instanceof HTMLScriptElement ? document.currentScript.nonce : "") || document.querySelector("script[nonce]")?.getAttribute("nonce") || "";
	adoptNonceForCreatedStyles(nonce);
	const style = element("style");
	if (nonce !== "") style.nonce = nonce;
	style.textContent = MERMAID_PREVIEW_STYLES;
	document.head.append(style);
	const host = acquireVsCodeApi();

	// ---- the document ----
	const fit = button("Fit", "Fit the diagram to the window", () => zoomTo("fit"));
	const out = button("−", "Zoom out", () => zoomTo(Math.max(MIN_ZOOM, scale() / ZOOM_STEP)));
	const into = button("+", "Zoom in", () => zoomTo(Math.min(MAX_ZOOM, scale() * ZOOM_STEP)));
	const actual = button("100%", "Show the diagram at its own size", () => zoomTo(1));
	const redraw = button("Redraw", "Draw the diagram again in the new theme", () => { redraw.hidden = true; draw(); });
	redraw.hidden = true;
	const copy = button("Copy source", "Copy the mermaid source", () => void copySource());
	const spinner = element("span", "spinner");
	spinner.setAttribute("aria-hidden", "true");
	const statusText = element("span");
	const status = element("span", "status");
	status.setAttribute("role", "status");
	status.append(spinner, statusText);
	const bar = element("div", "bar");
	bar.append(fit, out, into, actual, element("span", "gap"), status, redraw, copy);
	bar.setAttribute("role", "toolbar");
	bar.setAttribute("aria-label", "Diagram");
	const stage = element("main", "stage");
	stage.tabIndex = 0;
	document.body.replaceChildren(bar, stage);

	// ---- state ----
	let source: string | null = null;
	let theme: PageTheme | null = null;
	let generation = 0;
	let queue: Promise<void> = Promise.resolve();
	let image: HTMLImageElement | null = null;
	let copied: ReturnType<typeof setTimeout> | undefined;
	let lastRenderMs = 0;
	/** A draw is under way, and the theme changed under it: its result is shown, then drawn again (or offered as Redraw if it was slow). */
	let inFlight = false;
	let themeMovedDuringRender = false;

	const setBusy = (busy: boolean, text = ""): void => {
		spinner.hidden = !busy;
		statusText.textContent = text;
	};
	const showWaiting = (text: string): void => {
		const waiting = element("div", "waiting");
		const dot = element("span", "spinner");
		dot.setAttribute("aria-hidden", "true");
		waiting.append(dot, element("span", undefined, text));
		stage.replaceChildren(waiting);
		delete stage.dataset.fit;
	};
	const controls = (enabled: boolean): void => {
		for (const control of [fit, out, into, actual]) control.disabled = !enabled;
	};
	/** The scale the image is shown at now: its own size is 1. */
	const natural = (shown: HTMLImageElement): number => Number(shown.getAttribute("width")) || shown.naturalWidth || 1;
	const scale = (): number => (image === null ? 1 : image.clientWidth / natural(image));
	function zoomTo(next: "fit" | number): void {
		if (image === null) return;
		if (next === "fit") {
			stage.dataset.fit = "";
			image.style.width = "";
			image.style.height = "";
		} else {
			delete stage.dataset.fit;
			image.style.width = `${Math.round(natural(image) * next)}px`;
			image.style.height = "auto";
		}
	}
	async function copySource(): Promise<void> {
		if (source === null) return;
		clearTimeout(copied);
		try {
			await navigator.clipboard.writeText(source);
			copy.textContent = "Copied";
		} catch {
			copy.textContent = "Copy failed";
		}
		copied = setTimeout(() => { copy.textContent = "Copy source"; }, 1_500);
	}

	function showFailure(message: string, text: string): void {
		image = null;
		controls(false);
		const failure = element("div", "failure");
		const heading = element("h1", undefined, `Diagram not rendered: ${message}`);
		const code = element("code", undefined, text);
		const pre = element("pre");
		pre.append(code);
		failure.append(heading, pre);
		stage.replaceChildren(failure);
		delete stage.dataset.fit;
		setBusy(false);
	}

	function published(): OmpMermaid | string {
		const renderer: unknown = Reflect.get(window, MERMAID_GLOBAL);
		if (typeof renderer !== "object" || renderer === null || !("render" in renderer) || typeof renderer.render !== "function" || !("contract" in renderer)) return "Diagram renderer unavailable";
		if (renderer.contract !== MERMAID_CONTRACT) return "Diagram renderer is out of date. Reload the window";
		return renderer as OmpMermaid;
	}

	/** Draw `source` in the theme the page is in now; a newer request makes this one's result stale, and a stale one is dropped. */
	function draw(): void {
		if (source === null) return;
		const text = source;
		const run = ++generation;
		theme = readPageTheme();
		const drawnIn = theme;
		inFlight = true;
		themeMovedDuringRender = false;
		redraw.hidden = true;
		setBusy(true, "Rendering…");
		if (image === null) showWaiting("Rendering…");
		// Renders run one after another: mermaid's configuration is global.
		queue = queue.then(async () => {
			await painted();
			if (run !== generation) return;
			const renderer = published();
			if (typeof renderer === "string") return showFailure(renderer, text);
			const startedAt = performance.now();
			const result = await renderer.render(`tab${run}`, text, drawnIn.theme);
			lastRenderMs = performance.now() - startedAt;
			if (run !== generation) return;
			if (!result.ok) return showFailure(result.message, text);
			const shown = await mermaidImage(result.svg);
			if (run !== generation) return;
			if (!shown.ok) return showFailure(shown.message, text);
			const next = element("img");
			next.alt = `Mermaid ${mermaidKind(text)} diagram`;
			next.width = Math.ceil(result.width);
			next.height = Math.ceil(result.height);
			next.draggable = false;
			next.src = shown.src;
			const keepFit = image === null || stage.dataset.fit !== undefined;
			const keepScale = keepFit ? null : scale();
			image = next;
			stage.replaceChildren(next);
			controls(true);
			if (keepFit) stage.dataset.fit = ""; else zoomTo(keepScale ?? 1);
			setBusy(false);
			// The theme changed while this was being drawn: what was drawn is shown, then drawn again, or offered as Redraw after a slow render.
			inFlight = false;
			if (themeMovedDuringRender) themeChanged();
		}).catch((error: unknown) => {
			if (run === generation) showFailure(error instanceof Error ? error.message : "Unknown error", text);
		}).finally(() => {
			if (run === generation) inFlight = false;
		});
	}

	window.addEventListener("message", event => {
		const message = parseMermaidPreviewSource(event.data);
		if (message === null) return;
		source = message.source;
		image = null;
		draw();
	});
	// A theme change draws the diagram again (a slow one waits for **Redraw**); the previous image stays until the new one is ready.
	function themeChanged(): void {
		themeMovedDuringRender = false;
		if (lastRenderMs < SLOW_RENDER_MS || source === null) { draw(); return; }
		setBusy(false, "The theme changed.");
		redraw.hidden = false;
	}
	watchPageTheme(() => theme, () => {
		if (inFlight) themeMovedDuringRender = true;
		else themeChanged();
	});

	controls(false);
	setBusy(true, "Waiting for the diagram…");
	showWaiting("Waiting for the diagram…");
	host.postMessage({ type: "omp:mermaid-preview-ready" });
}

start();

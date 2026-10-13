/**
 * The page's side of diagram rendering: when the renderer is loaded, what is drawn, and what is remembered.
 *
 * The renderer itself (`media/mermaid.js`, ~3.5 MB) is not part of this bundle. It is added as a script the
 * first time a closed `mermaid` block needs drawing, from the folder this page's own script came from, with
 * this document's nonce (the policy allows scripts from that nonce and the extension's resource origin and
 * nothing else). A page that never meets a diagram never fetches it.
 *
 * Results are keyed by the theme and the source text; a failure, which does not depend on the colours, by the source alone. A diagram is drawn once per key while
 * it stays in the cache: a theme change draws it again under the new key, and a result evicted for room is drawn
 * again when its block comes back. The queue runs one diagram at a time, one task each: so the transcript keeps
 * taking input between diagrams, and because mermaid's configuration is global and two renders at once would mix it.
 */
import { MERMAID_CONTRACT, MERMAID_GLOBAL, mermaidKeyword, mermaidSourceRefusal, type MermaidRenderResult, type MermaidTheme, type OmpMermaid } from "../mermaid/contract.ts";
import { mermaidThemeFrom, themeKey } from "./mermaid-theme.ts";

/** What the page shows for one source in one theme. */
export type MermaidOutcome =
	| { readonly kind: "diagram"; readonly src: string; readonly width: number; readonly height: number }
	| { readonly kind: "failed"; readonly message: string };

/**
 * The script this bundle runs from: the renderer is its sibling, and its nonce is the document's.
 * Read once, at start-up, while `document.currentScript` is still set; the fallback is the one `readCspNonce` uses.
 */
const ownScript: HTMLScriptElement | null = (() => {
	if (typeof document === "undefined") return null;
	if (document.currentScript instanceof HTMLScriptElement) return document.currentScript;
	return document.querySelector<HTMLScriptElement>("script[nonce][src]");
})();

/** Results kept: failures and diagrams, least recently used dropped first once the text they hold passes this. */
const CACHE_BUDGET_CHARS = 8_000_000;
const PREFERENCE_ENTRIES = 64;

const cache = new Map<string, { readonly outcome: MermaidOutcome; readonly size: number }>();
let cacheSize = 0;
const listeners = new Set<() => void>();
let version = 0;

function changed(): void {
	version++;
	for (const listener of listeners) listener();
}

/** Called by `useSyncExternalStore`: the renderer finished a diagram or the theme changed. */
export function subscribeMermaid(listener: () => void): () => void {
	listeners.add(listener);
	watchTheme();
	return () => {
		listeners.delete(listener);
	};
}

export function mermaidVersion(): number {
	return version;
}

// ---- theme ----------------------------------------------------------------------------------

interface ThemeState {
	readonly theme: MermaidTheme;
	readonly key: string;
}

let themeState: ThemeState | null = null;
let themeObserver: MutationObserver | null = null;

/** The theme the page is in now. `<body>` inherits the variables VS Code sets on `<html>`, so reading them there sees both. */
function readTheme(): ThemeState {
	const styles = getComputedStyle(document.body);
	const highContrast = document.body.classList.contains("vscode-high-contrast") || document.body.classList.contains("vscode-high-contrast-light");
	const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
	const theme = mermaidThemeFrom(name => styles.getPropertyValue(name), highContrast, reducedMotion);
	return { theme, key: themeKey(theme) };
}

/** Read the theme again; true when it is not the one the page last saw. */
function refreshTheme(): boolean {
	const next = readTheme();
	const moved = next.key !== themeState?.key;
	themeState = next;
	return moved;
}

/** VS Code rewrites `<html>`'s variables and `<body>`'s classes on a theme change; both are watched, once, for the page's life, and so is the motion preference. */
function watchTheme(): void {
	if (themeObserver !== null || typeof MutationObserver === "undefined") return;
	refreshTheme();
	const onChange = (): void => {
		if (refreshTheme()) changed();
	};
	themeObserver = new MutationObserver(onChange);
	themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "class"] });
	themeObserver.observe(document.body, { attributes: true, attributeFilter: ["class", "data-vscode-theme-id", "data-vscode-theme-name"] });
	window.matchMedia("(prefers-reduced-motion: reduce)").addEventListener("change", onChange);
}

function activeTheme(): ThemeState {
	themeState ??= readTheme();
	return themeState;
}

// ---- results ----------------------------------------------------------------------------------

/** The result for `source` in the current theme, or `null` when it has not been drawn yet. */
export function peekMermaid(source: string): MermaidOutcome | null {
	if (typeof document === "undefined") return null;
	const key = `${activeTheme().key}\n${source}`;
	const stored = cache.has(key) ? key : failureKey(source);
	const hit = cache.get(stored);
	if (hit === undefined) return null;
	// Touch: most recently used last.
	cache.delete(stored);
	cache.set(stored, hit);
	return hit.outcome;
}

/** Where a failed render of `source` is kept, whatever the theme. */
function failureKey(source: string): string {
	return `failed\n${source}`;
}

function remember(key: string, source: string, outcome: MermaidOutcome): void {
	const size = key.length + (outcome.kind === "diagram" ? outcome.src.length : outcome.message.length);
	const stored = outcome.kind === "failed" ? failureKey(source) : key;
	const previous = cache.get(stored);
	if (previous !== undefined) cacheSize -= previous.size;
	cache.set(stored, { outcome, size });
	cacheSize += size;
	for (const oldest of cache.keys()) {
		if (cacheSize <= CACHE_BUDGET_CHARS || cache.size <= 1) break;
		cacheSize -= cache.get(oldest)?.size ?? 0;
		cache.delete(oldest);
	}
}

// ---- loading ----------------------------------------------------------------------------------

let loading: Promise<OmpMermaid> | null = null;

const UNAVAILABLE = "Diagram renderer unavailable";

function isRenderer(value: unknown): value is OmpMermaid {
	return typeof value === "object" && value !== null && "contract" in value && typeof value.contract === "number" && "render" in value && typeof value.render === "function";
}

/** The renderer the script published, or why it cannot be used. */
function published(): OmpMermaid {
	const renderer: unknown = Reflect.get(window, MERMAID_GLOBAL);
	if (!isRenderer(renderer)) throw new Error(UNAVAILABLE);
	// A page whose guest.js and mermaid.js come from different builds (a reinstall under an open page) must not talk across the gap.
	if (renderer.contract !== MERMAID_CONTRACT) throw new Error("Diagram renderer is out of date. Reload the window");
	return renderer;
}

async function fetchRenderer(): Promise<OmpMermaid> {
	if (Reflect.has(window, MERMAID_GLOBAL)) return published();
	if (ownScript === null || ownScript.src === "") throw new Error(UNAVAILABLE);
	const script = document.createElement("script");
	script.src = new URL("mermaid.js", ownScript.src).href;
	if (ownScript.nonce !== "") script.nonce = ownScript.nonce;
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	script.addEventListener("load", () => resolve(), { once: true });
	script.addEventListener("error", () => reject(new Error(UNAVAILABLE)), { once: true });
	document.head.append(script);
	await promise;
	return published();
}

/** The renderer, loaded once; a failed load is remembered, so a missing file is not fetched again by every block. */
function loadRenderer(): Promise<OmpMermaid> {
	loading ??= fetchRenderer();
	return loading;
}

// ---- queue ----------------------------------------------------------------------------------

interface Job {
	readonly key: string;
	readonly source: string;
	readonly theme: MermaidTheme;
	/** Blocks that still want this result; a job nobody wants any more is skipped when its turn comes. */
	wanted: number;
}

const queue = new Map<string, Job>();
let running = false;
let diagramCounter = 0;

/**
 * Ask for `source` to be drawn in the current theme; a result already cached is not drawn again.
 * @returns withdraws the request (a block that unmounts before its turn)
 */
export function requestMermaid(source: string): () => void {
	const { theme: requested, key: themeIdentity } = activeTheme();
	const key = `${themeIdentity}\n${source}`;
	if (cache.has(key) || cache.has(failureKey(source)) || mermaidSourceRefusal(source) !== null) return () => {};
	let job = queue.get(key);
	if (job === undefined) {
		job = { key, source, theme: requested, wanted: 0 };
		queue.set(key, job);
	}
	job.wanted++;
	void pump();
	let withdrawn = false;
	const wanted = job;
	return () => {
		if (withdrawn) return;
		withdrawn = true;
		wanted.wanted--;
	};
}

function nextTask(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, 0);
	return promise;
}

async function pump(): Promise<void> {
	if (running) return;
	running = true;
	try {
		for (;;) {
			await nextTask();
			const first = queue.entries().next();
			if (first.done === true) return;
			const [key, job] = first.value;
			queue.delete(key);
			if (job.wanted <= 0) continue;
			// A failure (a parse error, an over-size diagram, a missing renderer) does not depend on the colours: it is kept for the source, so a theme change does not pay for it again.
			remember(job.key, job.source, await draw(job));
			changed();
		}
	} finally {
		running = false;
	}
}

async function draw(job: Job): Promise<MermaidOutcome> {
	let result: MermaidRenderResult;
	try {
		const renderer = await loadRenderer();
		result = await renderer.render(`b${++diagramCounter}`, job.source, job.theme);
	} catch (error) {
		return { kind: "failed", message: error instanceof Error ? error.message : "Diagram renderer unavailable" };
	}
	if (!result.ok) return { kind: "failed", message: result.message };
	const src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(result.svg)}`;
	// An image the browser cannot decode would show as a broken icon after the swap; find out first.
	try {
		const probe = new Image();
		probe.src = src;
		await probe.decode();
	} catch {
		return { kind: "failed", message: "The diagram could not be displayed" };
	}
	return { kind: "diagram", src, width: Math.ceil(result.width), height: Math.ceil(result.height) };
}

// ---- what the reader chose ------------------------------------------------------------------------

export interface MermaidPreference {
	readonly view: "diagram" | "source";
	readonly full: boolean;
}

const preferences = new Map<string, MermaidPreference>();

/** The view the reader left this source in; the transcript unmounts rows that scroll away and mounts them again. */
export function mermaidPreference(source: string): MermaidPreference {
	return preferences.get(source) ?? { view: "diagram", full: false };
}

export function setMermaidPreference(source: string, preference: MermaidPreference): void {
	preferences.delete(source);
	preferences.set(source, preference);
	if (preferences.size > PREFERENCE_ENTRIES) preferences.delete(preferences.keys().next().value as string);
}

/** `flowchart`, `sequence`, `class` … from the diagram's first keyword, for a label; `diagram` when there is none. */
export function mermaidKind(source: string): string {
	const keyword = mermaidKeyword(source);
	if (keyword === null) return "diagram";
	if (keyword === "graph") return "flowchart";
	return keyword.replace(/-beta$/, "").replace(/diagram(-v2)?$/, "").replace(/-v2$/, "") || "diagram";
}

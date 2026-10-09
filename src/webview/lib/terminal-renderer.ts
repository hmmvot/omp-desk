/**
 * The terminal renderer itself: one xterm.js instance bound to a host element.
 *
 * Everything decided *about* the terminal lives in `./terminal-pane.ts`; this module
 * only drives the renderer, so its contract is deliberately narrow — write these
 * bytes, render at this grid, accept or refuse input, let me read the screen back.
 *
 * Four configured choices matter beyond rendering:
 *
 * - **Selection copies like the VS Code terminal.** Ctrl+C and Ctrl+Insert copy a
 *   non-empty selection and never reach the program; Ctrl+Shift+C always copies (see
 *   `./terminal-keys.ts`). Without a selection Ctrl+C is the interrupt byte in a
 *   folder shell, and nothing at all in a native OMP session, which never sends ^C.
 * - **Input is refused by the renderer, not only by the caller.** `disableStdin`
 *   stops keystrokes, pastes *and* mouse reports from becoming data events, so a pane
 *   that does not own the terminal cannot type into it even if a caller forgets to
 *   check.
 * - **Links never navigate the webview.** OSC 8 and host-validated plain file
 *   references request a host-owned editor/browser action. The host validates
 *   existing local files and retains the guarded web URL policy.
 * - **Cell widths match the TUI.** The Unicode 11 table is active, as it is in the
 *   broker's headless mirror, so wide emoji and CJK advance the cursor by the two
 *   cells the OMP TUI counted (`./terminal-unicode.ts`).
 *
 * OSC 52 has no handler in this library.
 */
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { Terminal } from "@xterm/xterm";
import type { IDisposable, ITheme } from "@xterm/xterm";
import { MAX_TERMINAL_COLS, MAX_TERMINAL_ROWS, MIN_TERMINAL_COLS, MIN_TERMINAL_ROWS } from "../messages.ts";
import type { TerminalGrid } from "./terminal-pane.ts";
import type { TerminalFontSettings } from "../messages.ts";
import { terminalAppearanceFrom } from "./terminal-theme.ts";
import { isTerminalWorkbenchChord, terminalCopyChord, withoutInterrupt } from "./terminal-keys.ts";
import { OrderedTerminalSurface } from "./terminal-ordered-surface.ts";
import { activateTerminalUnicode } from "./terminal-unicode.ts";
import { terminalFileLinkProvider } from "./terminal-link-provider.ts";
import { WEB_LINK_HINT } from "./chat-web-links.ts";
import { webLinkUrl } from "../terminal-links.ts";
import type { WebLinkMode } from "../terminal-links.ts";

/**
 * Lines the renderer keeps behind the screen.
 *
 * The *host* owns the bounded screen state a reattach restores; this is only what
 * the user can scroll back through while this pane lives, and it is capped so a long
 * session cannot grow a renderer unbounded.
 */
const TERMINAL_SCROLLBACK = 4000;

export interface TerminalRendererHooks {
	/** Keystrokes and pastes, exactly as the renderer produced them. */
	readonly onData: (text: string) => void;
	/** Keyboard focus entered or left the renderer. */
	readonly onFocus: (focused: boolean) => void;
	/** A hyperlink the terminal asked to activate; this pane opens nothing. A web link says where it should open. */
	readonly onLink: (uri: string, mode?: WebLinkMode) => void;
	readonly validateLink: (target: string) => Promise<boolean>;
	/** Copy selected text to the clipboard; true when it was written. */
	readonly copyText: (text: string) => Promise<boolean>;
	/** Modified Enter is OMP-specific; independent folder shells retain xterm defaults. */
	readonly newlineOnShiftEnter: boolean;
	/**
	 * Whether Ctrl+C with no selection is the interrupt byte. A folder shell needs it; a
	 * native OMP session never sends it (and drops any ^C that another encoding or a
	 * paste would carry).
	 */
	readonly ctrlCInterrupts: boolean;
}

export interface TerminalRenderer {
	/** Start a fresh screen: buffer, scrollback and modes of the previous one are gone. */
	resetScreen(): void;
	/** Write bytes into the screen as it is. */
	write(bytes: Uint8Array): void;
	/** Fit to the host element; the grid it now renders, or `null` when unmeasurable. */
	fitToContainer(): TerminalGrid | null;
	/** Render at exactly this grid (the host's, for a pane that does not own input). */
	renderAt(grid: TerminalGrid): void;
	/** Accept or refuse input; refusing also refuses pastes and mouse reports. */
	setInputEnabled(enabled: boolean): void;
	/** Apply current VS Code terminal fonts; true when cell metrics need a refit. */
	setFont(settings: TerminalFontSettings): boolean;
	/** The screen and its scrollback as plain text, oldest line first. */
	plainText(): string;
	focus(): void;
	dispose(): void;
}

/** True for a grid this extension may ask the host for. */
function isRenderableGrid(grid: TerminalGrid): boolean {
	return (
		Number.isSafeInteger(grid.cols) &&
		Number.isSafeInteger(grid.rows) &&
		grid.cols >= MIN_TERMINAL_COLS &&
		grid.cols <= MAX_TERMINAL_COLS &&
		grid.rows >= MIN_TERMINAL_ROWS &&
		grid.rows <= MAX_TERMINAL_ROWS
	);
}

/**
 * Create the renderer in `host`.
 *
 * `host` must already be in the document with its final size: a renderer opened in a
 * hidden or unsized element measures the font from a zero-sized box, and every later
 * fit is relative to that.
 */
export function createTerminalRenderer(host: HTMLElement, hooks: TerminalRendererHooks): TerminalRenderer {
	const computed = getComputedStyle(host);
	const appearance = terminalAppearanceFrom(name => computed.getPropertyValue(name));
	// Dropdown/palette values arrive from the theme as-is; the renderer takes the
	// concrete strings it was given and invents nothing.
	const theme: ITheme = appearance.theme;
	const terminal = new Terminal({
		disableStdin: true,
		fontFamily: appearance.fontFamily,
		fontSize: appearance.fontSize,
		fontWeight: appearance.fontWeight,
		scrollback: TERMINAL_SCROLLBACK,
		theme,
		cursorStyle: "block",
		convertEol: false,
		// Only the extension host can activate links; never navigate this document.
		linkHandler: {
			// xterm otherwise suppresses file:/vscode:/ OSC8 links before our host gate.
			allowNonHttpProtocols: true,
			// An http(s) link opens like a Chat web link: in an editor tab, or with Ctrl in the browser.
			activate(event, uri) {
				event.preventDefault();
				hooks.onLink(uri, webLinkUrl(uri) === null ? undefined : event.ctrlKey ? "external" : "editor");
			},
			hover(_event, uri) { host.title = webLinkUrl(uri) === null ? `Click to open ${uri}` : `${uri}\n${WEB_LINK_HINT}`; },
			leave() { host.removeAttribute("title"); },
		},
		// The `unicode` API that selects the width table is a proposed API in xterm.js.
		allowProposedApi: true,
		// Nothing here should reach the console: the renderer logs theme and buffer
		// noise at its default level, and this document's console belongs to the user.
		logLevel: "off",
	});
	const fit = new FitAddon();
	// The TUI measures with Unicode 11+ widths; xterm's default Unicode 6 table would
	// advance one column less than the program expects for every wide emoji (see
	// ./terminal-unicode.ts), so the cursor would sit off the insertion point.
	activateTerminalUnicode(terminal, new Unicode11Addon());
	terminal.loadAddon(fit);
	terminal.open(host);
	if (theme.background !== undefined) host.style.backgroundColor = theme.background;
	// VS Code updates ancestor theme attributes and CSS variables without recreating the pane.
	// Refresh xterm's concrete palette and the host remainder together for both session and shell.
	const themeObserver = new MutationObserver(() => {
		const current = getComputedStyle(host);
		const next = terminalAppearanceFrom(name => current.getPropertyValue(name)).theme;
		terminal.options.theme = next;
		host.style.backgroundColor = next.background ?? "";
	});
	for (let ancestor = host.parentElement; ancestor !== null; ancestor = ancestor.parentElement) {
		themeObserver.observe(ancestor, { attributes: true, attributeFilter: ["class", "style", "data-vscode-theme-id", "data-vscode-theme-name"] });
	}
	// A copy chord consumed on keydown must also be consumed on its keypress/keyup, which
	// would otherwise reach xterm after the selection was cleared and look like a plain ^C.
	let consumedChord = false;
	terminal.attachCustomKeyEventHandler(event => {
		if (event.type === "keydown") consumedChord = false;
		else if (consumedChord) {
			if (event.type === "keyup") consumedChord = false;
			return false;
		}
		// A workbench chord (Redraw, the OMP Desk side bar) must bubble (no stopPropagation),
		// but the program never receives it.
		if (event.type === "keydown" && isTerminalWorkbenchChord(event)) {
			consumedChord = true;
			return false;
		}
		const chord = event.type === "keydown" ? terminalCopyChord(event, terminal.hasSelection(), hooks.ctrlCInterrupts) : null;
		if (chord !== null) {
			// Stopping propagation also keeps the key from the VS Code workbench, which
			// would otherwise run its own binding for it (Ctrl+Shift+C opens an external
			// terminal) beside this copy.
			event.preventDefault();
			event.stopPropagation();
			consumedChord = true;
			const text = terminal.getSelection();
			if (text.length > 0) {
				void hooks.copyText(text).then(copied => {
					if (copied) terminal.clearSelection();
				});
			}
			return false;
		}
		if (!hooks.newlineOnShiftEnter || event.key !== "Enter" || !event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return true;
		event.preventDefault();
		if (event.type === "keydown" && !terminal.options.disableStdin) hooks.onData("\u001b[13;2u");
		return false;
	});
	// Focus is reported from the element the renderer created rather than from terminal
	// events: the library's own focus events are not part of this version's public API,
	// and `focusin`/`focusout` on that element are what the caret actually does.
	const element = terminal.element;
	const onFocusIn = (): void => hooks.onFocus(true);
	const onFocusOut = (): void => hooks.onFocus(false);
	const onPointerDown = (): void => {
		if (document.activeElement === terminal.textarea) hooks.onFocus(true);
	};
	element?.addEventListener("focusin", onFocusIn);
	element?.addEventListener("focusout", onFocusOut);
	element?.addEventListener("pointerdown", onPointerDown);
	const disposables: IDisposable[] = [
		terminal.onData(text => {
			const data = hooks.ctrlCInterrupts ? text : withoutInterrupt(text);
			if (data.length > 0) hooks.onData(data);
		}),
		{
			dispose(): void {
				element?.removeEventListener("focusin", onFocusIn);
				element?.removeEventListener("focusout", onFocusOut);
				element?.removeEventListener("pointerdown", onPointerDown);
			},
		},
	];
	disposables.push(terminal.registerLinkProvider(terminalFileLinkProvider(terminal, {
		validate: hooks.validateLink,
		activate: hooks.onLink,
		hover(target) { host.title = `Click to open ${target} in a new editor tab`; },
		leave() { host.removeAttribute("title"); },
	})));

	// Resets and resizes are applied between the bytes written before and after them, never
	// ahead of bytes the emulator has accepted but not yet parsed (see ./terminal-ordered-surface.ts).
	const surface = new OrderedTerminalSurface({
		write: (bytes, done) => terminal.write(bytes, done),
		reset: () => terminal.reset(),
		resize: (cols, rows) => terminal.resize(cols, rows),
	});
	// The grid the emulator has or is about to have, once the bytes written so far are parsed.
	let requested: TerminalGrid = { cols: terminal.cols, rows: terminal.rows };
	const requestGrid = (grid: TerminalGrid): void => {
		if (requested.cols === grid.cols && requested.rows === grid.rows) return;
		requested = { cols: grid.cols, rows: grid.rows };
		surface.resize(grid.cols, grid.rows);
	};

	return {
		resetScreen(): void {
			// A new screen is not the previous one continued: the buffer, the scrollback and
			// the modes the old screen set are not part of it.
			surface.reset();
		},
		write(bytes: Uint8Array): void {
			surface.write(bytes);
		},
		fitToContainer(): TerminalGrid | null {
			// A hidden or collapsed container measures as nothing: fitting it would shrink the screen
			// to the smallest legal grid and reflow what is on it, for a size nobody is looking at.
			if (host.clientWidth === 0 || host.clientHeight === 0) return null;
			const proposed = fit.proposeDimensions();
			if (proposed === undefined) return null;
			const grid = { cols: proposed.cols, rows: proposed.rows };
			// A container too small to hold a legal grid is not fitted: asking the host for
			// one would resize the real terminal to something it refuses.
			if (!isRenderableGrid(grid)) return null;
			requestGrid(grid);
			return { cols: requested.cols, rows: requested.rows };
		},
		renderAt(grid: TerminalGrid): void {
			requestGrid(grid);
		},
		setInputEnabled(enabled: boolean): void {
			terminal.options.disableStdin = !enabled;
		},
		setFont(settings): boolean {
			if (terminal.options.fontFamily === settings.fontFamily && terminal.options.fontSize === settings.fontSize &&
				terminal.options.lineHeight === settings.lineHeight && terminal.options.letterSpacing === settings.letterSpacing) return false;
			terminal.options.fontFamily = settings.fontFamily;
			terminal.options.fontSize = settings.fontSize;
			terminal.options.lineHeight = settings.lineHeight;
			terminal.options.letterSpacing = settings.letterSpacing;
			return true;
		},
		plainText(): string {
			const buffer = terminal.buffer.active;
			const lines: string[] = [];
			for (let index = 0; index < buffer.length; index++) {
				const line = buffer.getLine(index);
				if (line !== undefined) lines.push(line.translateToString(true));
			}
			// Trailing blank rows are layout, not content.
			while (lines.length > 0 && (lines[lines.length - 1] ?? "").length === 0) lines.pop();
			return lines.join("\n");
		},
		focus(): void {
			const alreadyFocused = document.activeElement === terminal.textarea;
			terminal.focus();
			if (alreadyFocused) hooks.onFocus(true);
		},
		dispose(): void {
			themeObserver.disconnect();
			for (const disposable of disposables) disposable.dispose();
			surface.dispose();
			terminal.dispose();
		},
	};
}

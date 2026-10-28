/**
 * The terminal surface's stylesheet: the pane, its status notes and the element the renderer measures.
 *
 * Both a managed-session editor and a folder-shell editor reuse these rules with
 * their own CSP nonce. The session document also carries the Chat rules.
 *
 * xterm.js's own base stylesheet (`@xterm/xterm/css/xterm.css`) is not here: it belongs to the renderer, which is a script
 * of its own that a page loads when it first shows a terminal (`./terminal-loader.ts`), and the renderer adds that
 * stylesheet itself. Rules below that name `.xterm` elements refine it and need no stylesheet to be present until then. The
 * rest of xterm's runtime rules — the row layout, theme colours and scrollbar — are created by the renderer, which is why
 * `./nonce-styles.ts` exists.
 */
import { BASE_CSS } from "./base-styles.ts";

/** The shared terminal pane, status notes and renderer host. */
const TERMINAL_CSS = `
/* ── the terminal pane ──────────────────────────────────────────────────── */
/* A shell document does not load the Chat sheet that sizes the shared app wrapper. */
.omp-app {
	display: flex;
	flex-direction: column;
	height: 100%;
	min-height: 0;
}


.omp-terminal {
	display: flex;
	flex-direction: column;
	flex: 1 1 auto;
	min-height: 0;
	background: var(--vscode-terminal-background, var(--vscode-editor-background));
}

.omp-terminal-state--warn { color: var(--vscode-editorWarning-foreground, #d29922); }
.omp-terminal-state--err { color: var(--vscode-errorForeground, #f85149); }

/* The renderer measures this element, so it must have a real size and no padding of
   its own beyond what the pane intends: the fit is the grid the host is asked for. */
.omp-terminal-host {
	flex: 1 1 auto;
	min-height: 0;
	padding: 4px 6px 0;
	overflow: hidden;
	background: inherit;
}

.omp-terminal-host .xterm { height: 100%; background: inherit; }
.omp-terminal-host .xterm-viewport {
	/* The bundled viewport is black and extends below the fitted row grid. */
	background-color: inherit;
	scrollbar-width: none;
}
.omp-terminal-host .xterm-viewport::-webkit-scrollbar { display: none; width: 0; height: 0; }
.omp-terminal-host .xterm-viewport::-webkit-scrollbar-button { display: none; }

.omp-terminal-notes {
	max-height: 96px;
	overflow-y: auto;
	border-top: 1px solid var(--omp-border);
	background: var(--omp-surface);
}

.omp-terminal-note {
	display: flex;
	gap: 6px;
	padding: 2px 10px;
	font-size: 11px;
	color: var(--omp-muted);
	overflow-wrap: anywhere;
}
`;

/** Shared native renderer/pane rules, without the document reset. */
export const TERMINAL_STYLES = TERMINAL_CSS;

/** The element id the sheet uses, so an injection can never happen twice. */
export const SHELL_STYLE_ID = "omp-shell-styles";

/** Put `css` in a nonce'd `<style>` element, once per document. */
function injectStyleElement(id: string, nonce: string, css: string): void {
	if (document.getElementById(id) !== null) return;
	const style = document.createElement("style");
	style.id = id;
	// The nonce is what makes this sheet executable: the document's policy allows no
	// inline style without it.
	if (nonce.length > 0) style.nonce = nonce;
	style.textContent = css;
	document.head.appendChild(style);
}

/**
 * Inject everything a folder shell's document needs: the shared document rules and
 * the terminal rules, in one sheet, because that document has no chat.
 */
export function injectShellStyles(nonce: string): void {
	injectStyleElement(SHELL_STYLE_ID, nonce, `${BASE_CSS}\n${TERMINAL_STYLES}`);
}

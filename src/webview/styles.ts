/**
 * Panel stylesheet.
 *
 * Delivered as a string so the bundle stays a single asset: the host's CSP
 * allows `style-src 'nonce-…'` plus its own resource origin, and the panel
 * injects one nonce'd `<style>` element. Every color comes from a VS Code
 * theme variable so the panel follows the user's theme, light or dark.
 *
 * The rules a *document* needs — the theme variables, the reset, `html`/`body` and
 * `#root` — live in `./lib/base-styles.ts`, because the folder shell's document
 * needs exactly the same ones from its own sheet.
 */
import { BASE_CSS } from "./lib/base-styles.ts";
import { TOOL_STYLES } from "./tool-styles.ts";
import { TERMINAL_STYLES } from "./lib/terminal-styles.ts";
import { HUD_STYLES } from "./hud-styles.ts";
import { QUEUE_STYLES } from "./queue-styles.ts";

const CSS = `
${BASE_CSS}
${TERMINAL_STYLES}


.omp-session-view, .omp-native-session { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.omp-session-view > .omp-chat { height: auto; }
.omp-native-session { flex: 1 1 auto; height: auto; }
.omp-native-session > .omp-terminal { flex: 1 1 auto; min-height: 0; }

/* ── the chat page ──────────────────────────────────────────────────────── */

/* The chat is the whole panel: a column of transcript and composer dock.
   It must be exactly as tall as the panel (#root is a plain 100vh block, so flex
   alone gives it no height): the transcript then scrolls inside .omp-body and the
   composer, Stop included, stays on screen. Without the explicit height the column
   grows with the transcript and pushes the composer below the clipped viewport. */
.omp-chat {
	display: flex;
	flex-direction: column;
	flex: 1 1 auto;
	height: 100%;
	min-height: 0;
}

/* The bottom block: the TODO/Agents rows (when any) and the composer card. It is one flex item of
   the chat column, so growing or shrinking any of it resizes the transcript viewport above, which
   the scroll controller absorbs by holding the line at the viewport's bottom edge. */
.omp-dock { display: flex; flex: 0 0 auto; flex-direction: column; min-width: 0; }

/* ── host-readback controls inside the composer dock ─────────────────────── */

/* Model and thinking keep their width while secondary controls disappear. At the smallest widths,
   prompt actions move to a second row rather than squeeze the two host-readback pickers. */
.omp-composer-toolbar { display: flex; flex-wrap: nowrap; align-items: center; gap: 6px; margin-top: 8px; min-height: 28px; font-size: 12px; }
.omp-composer-lead { display: flex; align-items: center; gap: 6px; flex: 1 1 0; min-width: 0; }
.omp-composer-lead > .omp-footer-trigger { flex: 0 0 auto; display: inline-flex; align-items: center; gap: 3px; min-width: 8ch; max-width: min(26ch, calc(100% - 10ch - 6px)); }
.omp-composer-lead > .omp-footer-trigger--level { min-width: 9ch; max-width: 12ch; }
.omp-composer-branch { display: flex; align-items: center; gap: 4px; flex: 0 1 auto; min-width: 0; color: var(--vscode-descriptionForeground); font-size: 11px; }
.omp-composer-branch > .codicon { flex: 0 0 auto; }
.omp-composer-branch-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.omp-composer-toolbar .omp-footer-trigger { height: 28px; border: 1px solid var(--vscode-button-border, var(--vscode-contrastBorder, transparent)); border-radius: 4px; padding: 0 4px; background: transparent; color: var(--vscode-foreground); }
.omp-footer-trigger { font: inherit; cursor: pointer; white-space: nowrap; }
.omp-footer-trigger-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.omp-footer-trigger > .codicon { flex: none; }
.omp-footer-trigger:hover:not(:disabled) { background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground)); }
.omp-footer-trigger:disabled { opacity: 0.6; cursor: default; }
.omp-footer-trigger:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
.omp-footer-feedback { margin-top: 4px; color: var(--vscode-foreground); overflow-wrap: anywhere; }
.omp-context-indicator { position: relative; display: flex; flex: 0 0 auto; }
.omp-context-trigger { display: flex; align-items: center; justify-content: center; gap: 4px; height: 28px; padding: 0 5px; border: 1px solid var(--vscode-button-border, var(--vscode-contrastBorder, transparent)); border-radius: 4px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); cursor: pointer; }
.omp-context-trigger:hover { background: var(--vscode-button-secondaryHoverBackground); }
.omp-context-trigger:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
.omp-context-percent { color: var(--vscode-descriptionForeground); font-size: 11px; white-space: nowrap; }
.omp-context-track { stroke: var(--vscode-descriptionForeground); opacity: 0.7; }
.omp-context-progress { stroke: var(--vscode-foreground, var(--vscode-input-foreground)); }
.omp-context-progress--warning { stroke: var(--vscode-editorWarning-foreground, var(--vscode-input-foreground)); }
.omp-context-progress--critical { stroke: var(--vscode-errorForeground, var(--vscode-input-foreground)); }
/* The hover-widget background alone is within a shade of the chat panel in several themes, so lift it a few percent toward the foreground: lighter in dark themes, darker in light ones. */
.omp-context-popover { position: absolute; right: 0; bottom: calc(100% + 8px); z-index: 50; display: flex; flex-direction: column; gap: 4px; width: max-content; max-width: min(260px, calc(100vw - 24px)); box-sizing: border-box; padding: 16px; border: 1px solid var(--vscode-editorHoverWidget-border, var(--vscode-widget-border)); border-radius: 6px; background: color-mix(in srgb, var(--vscode-editorHoverWidget-background) 86%, var(--vscode-foreground, var(--vscode-editorHoverWidget-foreground))); color: var(--vscode-editorHoverWidget-foreground); box-shadow: 0 4px 16px var(--vscode-widget-shadow); font-size: 12px; line-height: 1.4; overflow-wrap: anywhere; pointer-events: auto; }
.omp-context-popover::after { content: ""; position: absolute; left: 0; right: 0; top: 100%; height: 8px; }
.omp-context-popover strong { color: inherit; font-weight: 600; }
.omp-context-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px; }
/* High-contrast themes already draw a strong border; keep their exact hover colours and no shadow. */
.vscode-high-contrast .omp-context-popover, .vscode-high-contrast-light .omp-context-popover { background: var(--vscode-editorHoverWidget-background); box-shadow: none; }
@media (forced-colors: active) {
	.omp-context-trigger { border: 1px solid currentColor; }
	.omp-context-track { stroke: currentColor; }
	.omp-context-popover { border: 1px solid currentColor; }
}

.omp-chip {
	display: inline-flex;
	align-items: center;
	gap: 4px;
	border: 1px solid var(--omp-border);
	border-radius: 999px;
	padding: 0 8px;
	line-height: 18px;
	color: var(--omp-muted);
	white-space: nowrap;
}

.omp-chip--strong { color: var(--vscode-foreground); }
.omp-chip--warn { border-color: var(--omp-border); color: var(--vscode-foreground); }
.omp-chip--warn > .codicon { color: var(--vscode-editorWarning-foreground); }
.omp-chip--err { border-color: var(--vscode-errorForeground); color: var(--vscode-errorForeground); }
.omp-chip--work { border-color: var(--vscode-charts-blue); color: var(--vscode-charts-blue); }

/* ── buttons & inputs ───────────────────────────────────────────────────── */

.omp-btn {
	display: inline-flex;
	align-items: center;
	gap: 4px;
	border: 1px solid var(--vscode-button-border, var(--vscode-contrastBorder, transparent));
	border-radius: var(--omp-radius);
	padding: 3px 10px;
	font: inherit;
	font-size: 12px;
	cursor: pointer;
	background: var(--vscode-button-secondaryBackground);
	color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
}

.omp-btn:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
.omp-btn--primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.omp-btn--primary:hover:not(:disabled) { background: var(--vscode-button-hoverBackground, var(--vscode-button-background)); }
.omp-btn--stop { color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); }
.omp-btn:disabled { opacity: 0.45; cursor: default; }
.omp-btn:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }

.omp-input, .omp-textarea {
	width: 100%;
	background: var(--vscode-input-background);
	color: var(--vscode-input-foreground);
	border: 1px solid var(--vscode-input-border, var(--omp-border));
	border-radius: var(--omp-radius);
	padding: 6px 8px;
	font: inherit;
	resize: none;
}

.omp-textarea { font-family: inherit; line-height: 20px; padding: 10px 12px; }
.omp-textarea:focus, .omp-input:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
.omp-input::placeholder, .omp-textarea::placeholder { color: var(--vscode-input-placeholderForeground, var(--omp-muted)); }

/* ── body layout ────────────────────────────────────────────────────────── */

.omp-body {
	flex: 1 1 auto;
	display: flex;
	min-height: 0;
}

.omp-main {
	flex: 1 1 auto;
	min-width: 0;
	display: flex;
	flex-direction: column;
	min-height: 0;
}

.omp-command-output {
	margin: 0;
	white-space: pre-wrap;
	overflow-wrap: anywhere;
	font-family: var(--omp-mono);
	font-size: var(--omp-mono-size);
}

/* ── transcript ─────────────────────────────────────────────────────────── */

.omp-transcript-frame { position: relative; display: flex; flex: 1 1 auto; flex-direction: column; min-height: 0; min-width: 0; }
.omp-jump-latest { position: absolute; bottom: 12px; left: calc(50% - 18px); width: 36px; height: 36px; display: flex; align-items: center; justify-content: center; border-radius: 50%; border: 1px solid var(--vscode-widget-border); color: var(--vscode-foreground); background: var(--vscode-editorWidget-background); cursor: pointer; z-index: 2; }
.omp-jump-latest:hover { background: var(--vscode-list-hoverBackground); }
.omp-jump-latest:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
.omp-transcript {
	flex: 1 1 auto;
	overflow-y: auto;
	padding: 16px max(12px, calc((100% - 840px) / 2)) 24px;
	min-height: 0;
	overflow-anchor: none;
}
.omp-measured-row { display: flow-root; min-width: 0; }
.omp-measured-rows, .omp-window-spacer { overflow-anchor: none; min-width: 0; }
.omp-window-spacer { pointer-events: none; padding: 0; margin: 0; }
.omp-history-pages { display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 8px; padding: 4px 0 8px; color: var(--vscode-descriptionForeground); font-size: 11px; }
.omp-history-pages button { font: inherit; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: 1px solid var(--vscode-widget-border); border-radius: 4px; padding: 3px 7px; cursor: pointer; }
.omp-history-pages button:disabled { opacity: .6; cursor: default; }
.omp-history-pages button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }

.omp-empty { color: var(--omp-muted); font-style: italic; padding: 4px 0; }
.omp-working-status { box-sizing: border-box; height: 24px; min-height: 24px; max-height: 24px; display: flex; align-items: center; gap: 8px; overflow: hidden; color: var(--omp-muted); font-size: 12px; line-height: 20px; }
.omp-working-status-text { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.omp-working-status-elapsed { flex: 0 0 auto; font-variant-numeric: tabular-nums; }

/* The view renders only the newest rows; this reveals the rest a step at a time. */
.omp-earlier { padding: 2px 0 6px; text-align: center; }

.omp-earlier button {
	font: inherit;
	font-size: 11px;
	padding: 2px 8px;
	color: var(--omp-muted);
	background: transparent;
	border: 1px solid var(--omp-border);
	border-radius: 3px;
	cursor: pointer;
}

.omp-earlier button:hover {
	color: var(--vscode-foreground);
	border-color: var(--vscode-focusBorder, var(--omp-border));
}

/* Zero-height marker above the rendered rows: a reveal keeps the reader's place. */
.omp-anchor { height: 0; }

.omp-row { display: flex; gap: var(--omp-gap); padding: 3px 0; }


.omp-row--assistant .omp-body-block { flex: 1 1 auto; min-width: 0; }

.omp-row--user { margin: 16px 0 20px; }
.omp-row--user .omp-body-block {
	flex: 1 1 auto; min-width: 0;
	padding: 10px 14px;
	background: var(--vscode-editorWidget-background);
	border: 1px solid var(--omp-border); border-radius: 8px;
}

.omp-row--marker { color: var(--omp-muted); font-size: 11px; }
/* Hover actions of a row (Copy on the user's messages); shown on hover or keyboard focus. */
.omp-row { position: relative; }
.omp-row-actions { position: absolute; top: 2px; right: 4px; display: flex; gap: 4px; opacity: 0; }
.omp-row:hover > .omp-row-actions, .omp-row-actions:focus-within, .omp-row-actions:has(.omp-copy-status) { opacity: 1; }
.omp-retry-turn { display: inline-flex; align-items: center; gap: 4px; margin-top: 6px; padding: 2px 8px; border: 1px solid var(--vscode-button-border, transparent); border-radius: 3px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); font: inherit; cursor: pointer; }
.omp-retry-turn:hover { background: var(--vscode-button-secondaryHoverBackground); }
.omp-retry-turn:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
/* OMP extension setWidget blocks and notify notices, above or below the prompt. */
.omp-extension-widgets { display: flex; flex-direction: column; gap: 4px; margin: 0 0 6px; }
.omp-extension-widgets--belowEditor { margin: 6px 0 0; }
.omp-extension-widget { padding: 2px 6px; border-left: 2px solid var(--omp-border); color: var(--omp-muted); font-size: 11px; }
.omp-extension-widget-line { white-space: pre-wrap; overflow-wrap: anywhere; }
.omp-extension-notice { display: flex; align-items: center; gap: 6px; margin: 0 0 6px; font-size: 12px; }
.omp-extension-notice--warning .codicon-warning { color: var(--vscode-editorWarning-foreground); }
.omp-extension-notice-text { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
/* Rewind (ADR-0051): the picked prompt, what would leave the branch, the bar above the composer and branch markers. */
.omp-row--rewind-selected .omp-body-block { outline: 2px solid var(--vscode-focusBorder); outline-offset: 2px; cursor: pointer; }
.omp-row--rewind-dimmed { opacity: 0.45; }
.omp-rewind-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; margin: 0 0 6px; padding: 6px 8px; border: 1px solid var(--omp-border); border-radius: 6px; font-size: 12px; }
.omp-rewind-bar:focus { outline: 1px solid var(--vscode-focusBorder); }
.omp-rewind-bar--picking { border-color: var(--vscode-focusBorder); flex-direction: column; align-items: stretch; }
.omp-rewind-bar--notice > span { flex: 1 1 auto; min-width: 0; }
.omp-rewind-title, .omp-rewind-files { display: flex; gap: 6px; align-items: baseline; overflow-wrap: anywhere; }
.omp-rewind-target { font-style: italic; }
.omp-rewind-files { color: var(--omp-muted); }
.omp-rewind-files .codicon-warning { color: var(--vscode-editorWarning-foreground); }
.omp-rewind-blocked { color: var(--vscode-editorWarning-foreground); }
.omp-rewind-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.omp-rewind-legend { color: var(--omp-muted); font-size: 11px; margin-left: auto; }
.omp-branch-point { margin-top: 6px; font-size: 11px; color: var(--omp-muted); }
.omp-branch-point-toggle { display: inline-flex; align-items: center; gap: 4px; padding: 1px 6px; border: 1px dashed var(--omp-border); border-radius: 10px; background: transparent; color: inherit; font: inherit; cursor: pointer; }
.omp-branch-point-toggle:hover { color: var(--vscode-foreground); }
.omp-branch-point-toggle:focus-visible, .omp-branch-switch:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
.omp-branch-list { list-style: none; margin: 4px 0 0; padding: 0 0 0 12px; display: flex; flex-direction: column; gap: 2px; }
.omp-branch-switch { display: flex; gap: 8px; width: 100%; padding: 2px 6px; border: 0; border-radius: 3px; background: transparent; color: var(--vscode-foreground); font: inherit; text-align: left; cursor: pointer; }
.omp-branch-switch:hover:not(:disabled) { background: var(--vscode-list-hoverBackground); }
.omp-branch-switch:disabled { cursor: default; opacity: 0.6; }
.omp-branch-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.omp-branch-size { color: var(--omp-muted); }

.omp-badge {
	display: inline-block;
	border-radius: 3px;
	padding: 0 4px;
	background: var(--vscode-badge-background);
	color: var(--vscode-badge-foreground, var(--vscode-foreground));
	font-size: 10px;
}

.omp-divider {
	display: flex;
	align-items: center;
	gap: 8px;
	color: var(--omp-muted);
	font-size: 11px;
	margin: 8px 0;
}

.omp-divider::before, .omp-divider::after {
	content: "";
	flex: 1 1 auto;
	border-top: 1px solid var(--omp-border);
}

/* ── markdown ───────────────────────────────────────────────────────────── */

.omp-md p { margin: 4px 0; }
.omp-md h1, .omp-md h2, .omp-md h3, .omp-md h4, .omp-md h5, .omp-md h6 { margin: 8px 0 4px; line-height: 1.3; }
.omp-md h1 { font-size: 1.35em; }
.omp-md h2 { font-size: 1.2em; }
.omp-md h3 { font-size: 1.08em; }
.omp-md ul, .omp-md ol { margin: 4px 0; padding-left: 20px; }
.omp-md li { margin: 1px 0; }
/* A file reference the host proved to exist, or an http(s) web link: the same characters, in the link colour, opened by a plain click. */
.omp-file-link, .omp-web-link { color: var(--vscode-textLink-foreground); cursor: pointer; }
.omp-file-link:hover, .omp-web-link:hover { text-decoration: underline; color: var(--vscode-textLink-activeForeground, var(--vscode-textLink-foreground)); }
.omp-file-link:focus-visible, .omp-web-link:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; border-radius: 2px; text-decoration: underline; }
.omp-md code {
	font-family: var(--omp-mono);
	font-size: var(--omp-mono-size);
	color: var(--vscode-textPreformat-foreground, var(--vscode-foreground));
	background: var(--vscode-textPreformat-background);
	border-radius: 3px;
	padding: 1px 4px;
}
/* A link inside code, or code inside a link (a symbol linked to its definition): code colours, underlined as a link. */
.omp-md code .omp-file-link, .omp-md code .omp-file-link:hover { color: inherit; text-decoration: underline; }
.omp-md .omp-file-link > code, .omp-md .omp-web-link > code { text-decoration: underline; }
/* A symbol with several definitions: the code colours, underlined dotted (not solid like one definition); a click opens the workspace symbol search. */
.omp-md code .omp-symbol-search, .omp-md code .omp-symbol-search:hover { color: inherit; cursor: pointer; text-decoration: underline dotted; }
.omp-md code .omp-symbol-search:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; border-radius: 2px; }
.omp-md pre {
	background: var(--vscode-textCodeBlock-background);
	color: var(--vscode-foreground);
	border: 1px solid var(--omp-border);
	border-radius: var(--omp-radius);
	padding: 6px 8px;
	overflow-x: auto;
	margin: 6px 0;
}
.omp-md pre code { color: inherit; background: none; padding: 0; font-size: var(--omp-mono-size); line-height: 1.45; }
/* Hover Copy on fenced code blocks and user messages: hidden until the block is hovered or the button is focused. */
.omp-code-block { position: relative; }
.omp-copy-button { display: inline-flex; align-items: center; gap: 4px; padding: 2px 4px; border: 1px solid var(--vscode-button-border, transparent); border-radius: 3px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); font: inherit; font-size: 11px; cursor: pointer; }
.omp-copy-button:hover { background: var(--vscode-button-secondaryHoverBackground); }
.omp-copy-button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
.omp-code-copy { position: absolute; top: 4px; right: 4px; opacity: 0; }
.omp-code-block:hover .omp-code-copy, .omp-code-copy:focus-visible, .omp-code-copy:has(.omp-copy-status) { opacity: 1; }
.omp-md blockquote {
	margin: 4px 0;
	padding: 0 8px;
	border-left: 2px solid var(--omp-border);
	color: var(--omp-muted);
}
.omp-md table { border-collapse: collapse; margin: 6px 0; }
.omp-md th, .omp-md td { border: 1px solid var(--omp-border); padding: 2px 6px; text-align: left; }
.omp-md th { background: var(--omp-surface); }

.omp-think { margin: 4px 0; }
.omp-think > button {
	background: none;
	border: none;
	color: var(--omp-muted);
	font: inherit;
	font-size: 11px;
	cursor: pointer;
	padding: 0;
}
.omp-think-body {
	color: var(--omp-muted);
	white-space: pre-wrap;
	border-left: 2px solid var(--omp-border);
	padding-left: 8px;
	margin: 4px 0;
	font-size: 12px;
}

/* ── tool cards ─────────────────────────────────────────────────────────── */

.omp-tool {
	border: none;
	border-radius: 4px;
	margin: 2px 0;
	background: transparent;
	overflow: hidden;
}
.omp-tool-status--failed { color: var(--vscode-testing-iconFailed, var(--vscode-errorForeground)); }

.omp-tool-head {
	display: flex;
	align-items: baseline;
	gap: 6px;
	padding: 4px 8px;
	cursor: pointer;
	background: none;
	border: none;
	width: 100%;
	text-align: left;
	color: inherit;
	font: inherit;
}
.omp-tool-head:hover { background: var(--vscode-list-hoverBackground); }
.omp-tool-name { font-family: var(--omp-mono); font-size: var(--omp-mono-size); font-weight: 600; }
.omp-tool-digest {
	flex: 1 1 auto;
	min-width: 0;
	color: var(--omp-muted);
	font-family: var(--omp-mono);
	font-size: 11px;
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}
.omp-tool-body { padding: 8px 12px 12px 32px; overflow-wrap: anywhere; color: var(--vscode-foreground); }
/* Wide native lines may pan horizontally; vertical content stays in transcript flow. */
.omp-tool-body .omp-pre { max-height: none; overflow-x: auto; overflow-y: hidden; }
.omp-output-disclosure { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 6px 0; }
.omp-tool-section { margin-bottom: 6px; }
.omp-tool-overview { margin: 3px 0; min-width: 0; }
.omp-overview-head { display: flex; align-items: center; gap: 7px; border: 0; padding: 6px 8px; background: transparent; color: var(--omp-muted); font: inherit; cursor: pointer; width: 100%; text-align: left; border-radius: 4px; }
.omp-overview-head:hover { background: var(--vscode-list-hoverBackground); }
.omp-overview-summary { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.omp-overview-member { border-left: 1px solid var(--omp-border); margin-left: 12px; padding-left: 6px; }
.omp-tools-trigger { display: inline-flex; align-items: center; }
.omp-native-event { color: var(--omp-muted); font-size: 12px; padding: 6px 0; overflow-wrap: anywhere; }
.omp-native-skill header { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px; }
.omp-native-skill header p { margin: 0; }
.omp-sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
.omp-slash-description { display: block; font-family: var(--vscode-font-family); color: var(--omp-muted); font-size: 11px; white-space: normal; }
.omp-tool-head:focus-visible, .omp-tool-body:focus-visible, .omp-overview-head:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
.omp-reply-footer { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-top: 8px; color: var(--omp-muted); font-size: 11px; }
.omp-reply-copy { display: inline-flex; align-items: center; gap: 4px; border: 0; padding: 2px 3px; background: transparent; color: inherit; font: inherit; cursor: pointer; }
.omp-reply-copy:hover:not(:disabled) { color: var(--vscode-foreground); background: var(--vscode-list-hoverBackground); }
.omp-reply-copy:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
.omp-reply-copy:disabled { cursor: default; }
.omp-tool-section-title {
	font-size: 10px;
	text-transform: uppercase;
	letter-spacing: 0.04em;
	color: var(--omp-muted);
	margin-bottom: 2px;
}
.omp-pre {
	font-family: var(--omp-mono);
	font-size: var(--omp-mono-size);
	background: var(--vscode-textCodeBlock-background);
	color: var(--vscode-foreground);
	border-radius: 3px;
	padding: 4px 6px;
	margin: 0;
	white-space: pre-wrap;
	word-break: break-word;
	max-height: none;
	overflow-x: auto;
	overflow-y: hidden;
}
.omp-pre--error { color: var(--vscode-errorForeground); }
.omp-img { max-width: 100%; border-radius: var(--omp-radius); border: 1px solid var(--omp-border); }

/* ── composer ───────────────────────────────────────────────────────────── */

.omp-composer { position: relative; border: 1px solid var(--vscode-input-border, var(--vscode-widget-border, var(--omp-border))); border-radius: 10px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); padding: 10px 12px; width: min(840px, calc(100% - 24px)); min-width: 0; margin: 0 auto 8px; flex: 0 0 auto; overflow: visible; }
.omp-turn-progress { position: absolute; top: -1px; left: 8px; right: 8px; height: 2px; overflow: hidden; pointer-events: none; }
.omp-turn-progress::before { content: ""; position: absolute; width: 30%; height: 2px; background: var(--vscode-progressBar-background, var(--vscode-focusBorder)); animation: omp-turn-progress 2s linear infinite; }
@keyframes omp-turn-progress { from { transform: translateX(-100%); } to { transform: translateX(434%); } }
@media (prefers-reduced-motion: reduce) { .omp-turn-progress::before { width: 100%; animation: none; transform: none; } }
.omp-composer-row { display: flex; gap: 6px; align-items: center; }
.omp-suggest-wrapper { position: relative; flex: 1 1 auto; min-width: 0; }
/* The input row reaches 6px past the card's content box so the focus ring wraps the padded textarea while the text itself stays inset. */
.omp-composer-row--input { margin: -4px -6px 0; }
.omp-composer-row .omp-textarea { display: block; border: 0; border-radius: 8px; background: transparent; }
.omp-suggest-list {
	position: absolute;
	bottom: 100%;
	left: 0;
	right: 0;
	z-index: 20;
	margin: 0 0 4px;
	padding: 2px 0;
	list-style: none;
	max-height: 180px;
	overflow-y: auto;
	border: 1px solid var(--omp-border);
	border-radius: var(--omp-radius);
	background: var(--vscode-editorSuggestWidget-background, var(--vscode-editorWidget-background));
	color: var(--vscode-editorSuggestWidget-foreground, inherit);
	box-shadow: 0 2px 8px var(--vscode-widget-shadow);
}
.omp-suggest-option {
	padding: 2px 8px;
	font-family: var(--omp-mono);
	font-size: var(--omp-mono-size);
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
	cursor: pointer;
}
.omp-slash-label { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 6px; }
.omp-slash-label strong { min-width: 0; overflow-wrap: anywhere; white-space: normal; }
.omp-slash-label .omp-native-badge { flex: 0 0 auto; }
.omp-slash-hint { display: block; margin-top: 2px; font-size: 11px; font-weight: normal; white-space: normal; overflow-wrap: anywhere; }
.omp-suggest-option--active {
	background: var(--vscode-editorSuggestWidget-selectedBackground, var(--vscode-list-activeSelectionBackground));
	color: var(--vscode-editorSuggestWidget-selectedForeground, var(--vscode-list-activeSelectionForeground, var(--vscode-editorSuggestWidget-foreground, var(--vscode-foreground))));
}
.omp-suggest-option--active .omp-slash-description, .omp-suggest-option--active .omp-native-muted, .omp-suggest-option--active .omp-native-badge { color: inherit; }
.omp-suggest-option--active .omp-native-badge { border-color: currentColor; }
.omp-composer-actions { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; flex: 0 1 auto; min-width: 0; max-width: 100%; margin-left: auto; }
.omp-composer-actions .omp-btn { height: 28px; justify-content: center; }
.omp-composer-toolbar .omp-composer-attach, .omp-composer-toolbar .omp-tools-trigger { width: 28px; height: 28px; padding: 0; justify-content: center; flex: 0 0 auto; }
.omp-composer-toolbar-actions { display: flex; flex-wrap: nowrap; gap: 6px; align-items: center; flex: 0 0 auto; margin-left: auto; }
.omp-composer-toolbar-actions .omp-btn { height: 28px; justify-content: center; flex: 0 0 auto; }
.omp-composer-hint { margin-top: 4px; font-size: 11px; color: var(--omp-muted); }
/* Notices stacked above the input row keep the 6px gap of .omp-attach-error: the input row's -4px top margin would otherwise pull it over the hint's text. */
.omp-composer > .omp-composer-hint { margin: 0 0 6px; line-height: 1.4; }

/* Attached images: chips above the row, wrapping on a narrow panel. */
.omp-file-input { display: none; }

.omp-attachments {
	list-style: none;
	display: flex;
	flex-wrap: wrap;
	gap: 6px;
	margin: 0 0 6px;
	padding: 0;
	max-height: 108px;
	overflow-y: auto;
}

.omp-attachment {
	display: flex;
	align-items: center;
	gap: 6px;
	max-width: 100%;
	border: 1px solid var(--omp-border);
	border-radius: var(--omp-radius);
	padding: 2px 4px;
	background: var(--vscode-editor-background);
}

.omp-attachment-thumb {
	flex: 0 0 auto;
	width: 36px;
	height: 36px;
	object-fit: cover;
	border-radius: 3px;
	border: 1px solid var(--omp-border);
	background: var(--omp-surface);
}

.omp-attachment-meta { display: flex; flex-direction: column; min-width: 0; }
.omp-attachment-name {
	font-size: 11px;
	max-width: 16ch;
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}
.omp-attachment-size { font-size: 10px; color: var(--omp-muted); }

.omp-attachment-remove {
	flex: 0 0 auto;
	background: none;
	border: none;
	border-radius: 3px;
	color: var(--omp-muted);
	font: inherit;
	line-height: 1;
	padding: 2px 5px;
	cursor: pointer;
}
.omp-attachment-remove:hover:not(:disabled) {
	color: var(--vscode-errorForeground);
	background: var(--vscode-list-hoverBackground);
}
.omp-attachment-remove:disabled { opacity: 0.45; cursor: default; }
.omp-attachment-remove:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }

/* Numbered image references: the textarea stays the editor; a click-through layer behind it paints each marker as a chip. */
.omp-composer-row .omp-textarea { position: relative; }
.omp-textarea-mirror { position: absolute; inset: 0; box-sizing: border-box; padding: 10px 12px; overflow: hidden; pointer-events: none; font: inherit; line-height: 20px; white-space: pre-wrap; overflow-wrap: break-word; color: transparent; border-radius: 8px; }
.omp-image-ref-mark { color: transparent; border-radius: 3px; background: color-mix(in srgb, var(--vscode-textLink-foreground, var(--vscode-focusBorder, #3794ff)) 24%, transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--vscode-textLink-foreground, var(--vscode-focusBorder, #3794ff)) 55%, transparent); }
.omp-attachment-figure { position: relative; display: inline-flex; flex: 0 0 auto; }
.omp-attachment-number { position: absolute; left: 1px; bottom: 1px; padding: 1px 3px; border-radius: 2px 3px 2px 2px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); font-size: 10px; line-height: 1; font-weight: 600; }
@media (forced-colors: active) {
	.omp-image-ref-mark { forced-color-adjust: none; background: Highlight; box-shadow: none; }
	.omp-attachment-number { border: 1px solid currentColor; }
}

.omp-attach-error { color: var(--vscode-errorForeground); font-size: 11px; margin-bottom: 6px; overflow-wrap: anywhere; }
/* Compact actions wrap inside the card rather than widening narrow panels. */
@media (max-width: 460px) {
	.omp-composer-row { flex-wrap: wrap; }
	.omp-composer-actions { width: 100%; justify-content: flex-end; }
}
/* Hide the branch first, then the secondary Tools control; preserve model/thinking
   and use accessible action icons before allowing the actions to occupy their own row. */
/* The .omp-btn prefix outranks the codicon stylesheet's own display rule, which otherwise shows the icon beside the label. */
.omp-btn .omp-btn-icon { display: none; }
.omp-btn--stop .omp-btn-icon { display: inline; }
@media (max-width: 860px) { .omp-composer-branch { display: none; } }
@media (max-width: 720px) {
	.omp-btn--icon-mid { width: 28px; padding: 0; }
	.omp-btn--icon-mid .omp-btn-label { display: none; }
	.omp-btn--icon-mid .omp-btn-icon { display: inline; }
}
@media (max-width: 590px) { .omp-composer-toolbar .omp-tools-trigger { display: none; } }
@media (max-width: 460px) {
	.omp-btn--icon-narrow { width: 28px; padding: 0; }
	.omp-btn--icon-narrow .omp-btn-label { display: none; }
	.omp-btn--icon-narrow .omp-btn-icon { display: inline; }
}
/* Extremely narrow panels keep readable picker labels, with prompt actions below them. */
@media (max-width: 380px) {
	.omp-composer-toolbar { flex-wrap: wrap; }
	.omp-composer-lead { flex-basis: 100%; }
	.omp-composer-toolbar-actions { flex-wrap: wrap; justify-content: flex-end; max-width: 100%; }
}
@media (max-width: 240px) {
	.omp-composer-lead { flex-wrap: wrap; }
	.omp-composer-lead > .omp-footer-trigger { max-width: 100%; }
}

.omp-ask { border: 1px solid var(--vscode-widget-border, var(--vscode-focusBorder)); border-radius: var(--omp-radius); padding: 8px; margin-bottom: 6px; min-width: 0; }
.omp-ask-title { font-weight: 600; margin-bottom: 6px; }
.omp-ask-help { color: var(--omp-muted); font-size: 11px; margin-bottom: 6px; }
.omp-ask-options { display: flex; flex-direction: column; gap: 2px; max-height: 40vh; overflow-y: auto; min-width: 0; }
/* One answer row: marker column, then a text column that owns the whole remaining width — the label above, the description below it at the label's indent. */
.omp-ask-option {
	display: flex;
	gap: 6px;
	align-items: flex-start;
	width: 100%;
	min-width: 0;
	text-align: left;
	background: none;
	border: 1px solid var(--omp-border);
	border-radius: 4px;
	color: inherit;
	font: inherit;
	padding: 3px 6px;
	cursor: pointer;
}
.omp-ask-option:hover:not(:disabled) { background: var(--vscode-list-hoverBackground); }
.omp-ask-option:disabled { opacity: 0.5; cursor: default; }
.omp-ask-option--checked { border-color: var(--vscode-focusBorder); }
.omp-ask-option-marker { flex: 0 0 auto; color: var(--vscode-checkbox-foreground); }
.omp-ask-option[role="checkbox"] .omp-ask-option-marker, .omp-ask-option-marker--checkbox { background: var(--vscode-checkbox-background); border: 1px solid var(--vscode-checkbox-border, var(--vscode-contrastBorder, transparent)); border-radius: 3px; }
.omp-ask-option-text { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.omp-ask-option-label { font-family: var(--vscode-font-family); font-size: inherit; overflow-wrap: anywhere; white-space: pre-wrap; }
.omp-ask-option-desc { color: var(--omp-muted); font-size: 11px; overflow-wrap: anywhere; white-space: pre-wrap; }

/* Several questions: one tab per question plus Submit; tabs wrap so a narrow panel never scrolls sideways. */
.omp-ask-dialog { min-width: 0; }
.omp-ask-tabs { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 8px; min-width: 0; }
.omp-ask-tab {
	display: inline-flex;
	align-items: center;
	gap: 4px;
	min-width: 0;
	max-width: 100%;
	background: none;
	border: 1px solid var(--omp-border);
	border-radius: var(--omp-radius);
	color: var(--omp-muted);
	font: inherit;
	padding: 2px 8px;
	cursor: pointer;
}
.omp-ask-tab:hover { background: var(--vscode-list-hoverBackground); }
.omp-ask-tab--active { color: inherit; font-weight: 600; border-color: var(--vscode-focusBorder); }
.omp-ask-tab-mark { flex: 0 0 auto; }
.omp-ask-tab--answered .omp-ask-tab-mark { color: var(--vscode-testing-iconPassed); }
.omp-ask-tab-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.omp-ask-panel { min-width: 0; }
.omp-ask-question { margin-bottom: 6px; overflow-wrap: anywhere; }
.omp-ask-custom { display: flex; flex-direction: column; gap: 6px; }
.omp-ask-review-title { font-weight: 600; margin-bottom: 6px; }
.omp-ask-warning { color: var(--vscode-foreground); font-size: 11px; margin-bottom: 6px; }
.omp-ask-review { display: flex; flex-direction: column; gap: 4px; margin-bottom: 6px; min-width: 0; }
.omp-ask-review-row {
	display: flex;
	flex-direction: column;
	gap: 1px;
	width: 100%;
	min-width: 0;
	text-align: left;
	background: none;
	border: 1px solid var(--omp-border);
	border-radius: var(--omp-radius);
	color: inherit;
	font: inherit;
	padding: 4px 8px;
	cursor: pointer;
}
.omp-ask-review-row:hover { background: var(--vscode-list-hoverBackground); }
.omp-ask-review-q { color: var(--omp-muted); font-size: 11px; overflow-wrap: anywhere; }
.omp-ask-review-a { overflow-wrap: anywhere; white-space: pre-wrap; }
.omp-ask-review-a--none { color: var(--vscode-descriptionForeground); }

/* ── small shared parts ─────────────────────────────────────────────────── */

.omp-empty-note { color: var(--omp-muted); font-size: 11px; padding: 2px 4px; }

.omp-dot { width: 7px; height: 7px; border-radius: 50%; flex: 0 0 auto; background: var(--omp-muted); }
.omp-dot--running { background: var(--vscode-charts-green); }
.omp-dot--idle { background: var(--vscode-charts-blue); }
.omp-dot--parked { background: var(--vscode-editorWarning-foreground); }
.omp-dot--aborted { background: var(--vscode-errorForeground); }

/* ── phase / unhosted banners ────────────────────────────────────────────── */

.omp-notices { flex: none; max-height: 112px; overflow-y: auto; border-top: 1px solid var(--omp-border); background: var(--omp-surface); }

/* One line naming what this page's route can carry; see App. */
.omp-route-notice {
	border-top: 1px solid var(--omp-border);
	padding: 4px 10px;
	font-size: 0.85em;
	color: var(--omp-muted);
	background: var(--omp-surface);
}
.omp-notice { display: flex; gap: 6px; padding: 2px 10px; font-size: 11px; }
.omp-notice--warning { color: var(--vscode-foreground); background: var(--vscode-inputValidation-warningBackground); border: 1px solid var(--vscode-inputValidation-warningBorder, var(--vscode-contrastBorder, transparent)); }
.omp-notice--warning > .codicon { color: var(--vscode-editorWarning-foreground); }
.omp-notice--error { color: var(--vscode-errorForeground); }
.omp-notice-description { flex: 1 1 auto; }
.omp-notice-exit { white-space: pre-wrap; overflow-wrap: anywhere; min-width: 0; }
.omp-notice .omp-btn { flex: 0 0 auto; height: 20px; padding: 0 8px; font-size: 11px; }

/* ── native transcript and the bottom-block HUD rows ───────────────────── */
${HUD_STYLES}
${QUEUE_STYLES}
.omp-native-child button:focus-visible { outline: 1px solid var(--vscode-focusBorder); }
.omp-native-agent + .omp-native-agent { border-top: 1px solid var(--omp-border); padding-top: 8px; margin-top: 8px; }
.omp-native-note, .omp-native-muted { color: var(--omp-muted); }
.omp-native-todo-blocker { color: var(--vscode-descriptionForeground); }
.omp-warning { color: var(--vscode-foreground); }
.omp-warning .codicon-warning { color: var(--vscode-editorWarning-foreground); }
.omp-native-agent-stats { color: var(--omp-muted); }
.omp-native-agent-description, .omp-native-agent-activity { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.omp-native-agent-description { padding: 0 8px; color: var(--omp-muted); }
.omp-native-agent-progress { display: flex; align-items: baseline; gap: 8px; flex: 1 1 auto; min-width: 0; flex-wrap: wrap; }
.omp-native-agent-progress .omp-native-agent-activity { margin: 0; padding: 0; flex: 1 1 140px; }
.omp-native-agent-stats { flex: 0 0 auto; }
.omp-native-message, .omp-native-summary { min-width: 0; overflow-wrap: anywhere; }
.omp-native-message header { display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; margin-bottom: 6px; }
.omp-native-message h4 { margin: 8px 0; }
.omp-native-disclosure, .omp-native-child { margin: 6px 0; }
.omp-native-disclosure > summary, .omp-native-child > summary { cursor: pointer; color: var(--omp-muted); }
.omp-native-code, .omp-native-output, .omp-native-message pre { font-family: var(--omp-mono); font-size: var(--omp-mono-size); white-space: pre-wrap; overflow-wrap: anywhere; max-width: 100%; }
.omp-native-code { padding: 8px; color: var(--vscode-foreground); background: var(--vscode-textCodeBlock-background); border-radius: var(--omp-radius); }
.omp-native-status, .omp-native-divider { padding: 6px 0; color: var(--omp-muted); }
.omp-native-divider { border-top: 1px solid var(--omp-border); }
/* Compaction and branch summaries: a rule across the transcript with the label in the middle, as the TUI draws it. */
.omp-native-summary--divider { margin: 12px 0; }
.omp-native-summary--divider > .omp-native-disclosure { margin: 0; }
.omp-native-summary--divider > .omp-native-disclosure > summary { display: flex; align-items: center; gap: 10px; list-style: none; color: var(--omp-muted); }
.omp-native-summary--divider > .omp-native-disclosure > summary::-webkit-details-marker { display: none; }
.omp-native-summary--divider > .omp-native-disclosure > summary::before, .omp-native-summary--divider > .omp-native-disclosure > summary::after { content: ""; flex: 1 1 24px; border-top: 1px solid var(--omp-border); }
.omp-native-summary-label { flex: 0 1 auto; text-align: center; }
.omp-native-summary-amount { font-family: var(--omp-mono); font-size: var(--omp-mono-size); }
.omp-native-summary--divider > .omp-native-disclosure[open] > summary { margin-bottom: 8px; }
.omp-native-badge { border: 1px solid var(--omp-border); border-radius: 4px; padding: 0 5px; font-size: 0.85em; color: var(--omp-muted); }
.omp-native-image { margin: 6px 0; }
.omp-native-image img { display: block; max-width: 100%; max-height: 480px; object-fit: contain; }
.omp-native-image-label { margin-top: 2px; color: var(--omp-muted); font-size: 11px; }
.omp-native-image:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
.omp-user .omp-native-image img { max-height: 240px; }
.omp-image-ref { display: inline; padding: 0 4px; border: 0; border-radius: 3px; font: inherit; color: var(--vscode-textLink-foreground, inherit); background: color-mix(in srgb, var(--vscode-textLink-foreground, var(--vscode-focusBorder, #3794ff)) 18%, transparent); cursor: pointer; }
.omp-image-ref:hover { background: color-mix(in srgb, var(--vscode-textLink-foreground, var(--vscode-focusBorder, #3794ff)) 32%, transparent); }
.omp-image-ref:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
.omp-image-ref .codicon { font-size: 0.95em; margin-right: 3px; vertical-align: -1px; }
.omp-image-unavailable { display: inline-block; padding: 6px 10px; border: 1px dashed var(--omp-border); border-radius: var(--omp-radius); color: var(--omp-muted); font-size: 12px; }
.omp-error { color: var(--vscode-errorForeground); }
.omp-success { color: var(--vscode-testing-iconPassed); }
.omp-native-child-body { padding: 8px; border: 1px solid var(--omp-border); border-radius: var(--omp-radius); }
.omp-native-child-toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.omp-native-child button { font: inherit; color: var(--vscode-foreground); background: var(--vscode-button-secondaryBackground); border: 1px solid var(--omp-border); border-radius: 4px; cursor: pointer; }
.omp-native-child .omp-transcript { max-height: none; min-height: 100px; overflow: visible; }
${TOOL_STYLES}
/* Action buttons share VS Code's secondary tokens; transcript disclosure rows remain flat. */
.omp-jump-latest, .omp-reply-copy, .omp-attachment-remove, .omp-earlier button, .omp-history-pages button, .omp-native-child button, .omp-hud-open {
	border: 1px solid var(--vscode-button-border, var(--vscode-contrastBorder, transparent));
	background: var(--vscode-button-secondaryBackground);
	color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
}
.omp-jump-latest:hover:not(:disabled), .omp-reply-copy:hover:not(:disabled), .omp-attachment-remove:hover:not(:disabled), .omp-earlier button:hover:not(:disabled), .omp-history-pages button:hover:not(:disabled), .omp-native-child button:hover:not(:disabled), .omp-hud-open:hover:not(:disabled) {
	background: var(--vscode-button-secondaryHoverBackground);
	color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
}
`;

/**
 * Inject the panel stylesheet once. `nonce` must be the CSP nonce the host
 * stamped on the document script, or the stylesheet is blocked by CSP.
 */
export function injectGuestStyles(nonce: string): void {
	if (document.getElementById("omp-guest-styles") !== null) return;
	const style = document.createElement("style");
	style.id = "omp-guest-styles";
	if (nonce.length > 0) style.nonce = nonce;
	style.textContent = CSS;
	document.head.appendChild(style);
}

import { HUD_HEADER_PX, HUD_STACK_PAD_PX } from "../chat/hud-summary.ts";

/**
 * The side-question panel of the bottom block (docs/designs/2026-10-19-chat-btw-side-questions.md). Theme variables only. It has the
 * TODO, Agents and queue rows' column width and header height, sits in normal flow directly above the composer, and keeps its own
 * height bounded: the body scrolls inside the panel (a share of the viewport, never more than 420px) so a long answer cannot push the
 * transcript out of the page. Nothing here changes the transcript's own styles.
 */
export const BTW_STYLES = `
.omp-btw { flex: 0 0 auto; display: flex; flex-direction: column; width: min(840px, calc(100% - 24px)); min-width: 0; box-sizing: border-box; margin: 0 auto ${HUD_STACK_PAD_PX}px; border: 1px solid var(--omp-border); border-radius: var(--omp-radius); background: var(--vscode-editorWidget-background, transparent); line-height: 18px; }
.omp-btw .codicon { flex: none; }
.omp-btw-head { display: flex; gap: 4px; align-items: center; min-width: 0; height: ${HUD_HEADER_PX}px; box-sizing: border-box; padding: 0 4px 0 0; }
.omp-btw-title { display: flex; flex: 1 1 auto; min-width: 0; gap: 6px; align-items: center; padding: 4px 8px; }
.omp-btw-summary { flex: 1 1 auto; min-width: 0; overflow: hidden; color: var(--omp-muted); text-overflow: ellipsis; white-space: nowrap; }
.omp-btw-status { flex: none; color: var(--omp-muted); font-size: 0.85em; white-space: nowrap; }
.omp-btw-status--running { color: var(--vscode-charts-blue); }
.omp-btw-status--error { color: var(--vscode-errorForeground); }
.omp-btw-action { display: flex; flex: none; align-items: center; justify-content: center; width: 22px; height: 20px; padding: 0; border: 0; border-radius: var(--omp-radius); background: none; color: var(--omp-muted); cursor: pointer; }
.omp-btw-action:hover:not(:disabled) { background: var(--vscode-list-hoverBackground); color: var(--vscode-foreground); }
.omp-btw-action:focus-visible, .omp-btw-send:focus-visible, .omp-btw-item:focus-visible, .omp-btw-body:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
.omp-btw-action:disabled, .omp-btw-send:disabled { opacity: 0.55; cursor: default; }
.omp-btw-cancel { color: var(--vscode-errorForeground); }
.omp-btw-copy { flex: none; }
.omp-btw-body { min-height: 0; max-height: min(40vh, 420px); overflow-y: auto; padding: 0 12px 8px; border-top: 1px solid var(--omp-border); }
.omp-btw-turn + .omp-btw-turn { margin-top: 10px; padding-top: 8px; border-top: 1px dashed var(--omp-border); }
.omp-btw-question { padding-top: 8px; color: var(--omp-muted); white-space: pre-wrap; overflow-wrap: anywhere; }
.omp-btw-answer { min-width: 0; padding-top: 4px; overflow-wrap: anywhere; }
.omp-btw-wait { display: flex; gap: 6px; align-items: center; padding-top: 4px; color: var(--omp-muted); }
.omp-btw-error { padding-top: 4px; color: var(--vscode-errorForeground); white-space: pre-wrap; overflow-wrap: anywhere; }
.omp-btw-note { padding: 4px 12px; color: var(--omp-muted); font-size: 0.9em; }
.omp-btw-empty { padding: 8px 12px; border-top: 1px solid var(--omp-border); }
.omp-btw-follow { display: flex; gap: 4px; align-items: flex-end; padding: 6px 8px; border-top: 1px solid var(--omp-border); }
.omp-btw-input { flex: 1 1 auto; min-width: 0; box-sizing: border-box; min-height: 24px; max-height: 96px; padding: 3px 6px; resize: none; border: 1px solid var(--vscode-input-border, var(--omp-border)); border-radius: var(--omp-radius); background: var(--vscode-input-background); color: var(--vscode-input-foreground); font: inherit; line-height: 18px; field-sizing: content; }
.omp-btw-input:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
.omp-btw-send { display: flex; flex: none; align-items: center; justify-content: center; width: 26px; height: 24px; padding: 0; border: 0; border-radius: var(--omp-radius); background: var(--vscode-button-background); color: var(--vscode-button-foreground); cursor: pointer; }
.omp-btw-send:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
.omp-btw-list { list-style: none; margin: 0; padding: 0 0 4px; max-height: min(40vh, 420px); overflow-y: auto; border-top: 1px solid var(--omp-border); }
.omp-btw-item { display: flex; gap: 8px; align-items: baseline; width: 100%; min-width: 0; box-sizing: border-box; padding: 3px 12px; border: 0; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.omp-btw-item:hover { background: var(--vscode-list-hoverBackground); }
.omp-btw-item-text { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.omp-btw-item-meta { flex: none; color: var(--omp-muted); font-size: 0.85em; white-space: nowrap; }
.omp-btw-notice { display: flex; gap: 6px; align-items: center; min-width: 0; padding: 2px 8px; border-top: 1px solid var(--omp-border); }
.omp-btw-notice .codicon-warning { color: var(--vscode-editorWarning-foreground); }
.omp-btw-notice-text { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
.vscode-high-contrast .omp-btw, .vscode-high-contrast-light .omp-btw { border-color: var(--vscode-contrastBorder, var(--omp-border)); }
`;

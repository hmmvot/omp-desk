import { HUD_HEADER_PX, HUD_LINE_PX, HUD_LIST_PAD_PX, HUD_STACK_PAD_PX } from "../chat/hud-summary.ts";

/**
 * The queued-messages row of the bottom block. Theme variables only. It is the TODO/Agents rows' flat tool
 * row — the same column width, header height, line height and hover — in normal flow with no overflow or
 * scroll region, so the dock's size (and therefore the transcript's bottom anchor) changes exactly as it does
 * when a HUD row opens. Every item is one clipped line with its full text in `title`.
 */
export const QUEUE_STYLES = `
.omp-queue { flex: 0 0 auto; width: min(840px, calc(100% - 24px)); min-width: 0; margin: 0 auto; padding-bottom: ${HUD_STACK_PAD_PX}px; line-height: 18px; }
.omp-queue .codicon { flex: none; }
.omp-queue-head { display: flex; align-items: center; min-width: 0; height: ${HUD_HEADER_PX}px; box-sizing: border-box; }
.omp-queue-title { display: flex; flex: 1 1 auto; min-width: 0; height: 100%; box-sizing: border-box; gap: 6px; align-items: center; padding: 4px 8px; }
.omp-queue-all { display: flex; flex: none; gap: 4px; align-items: center; align-self: stretch; padding: 0 8px; border: 0; border-radius: 4px; background: none; color: var(--omp-muted); font: inherit; cursor: pointer; }
.omp-queue-all:hover:not(:disabled), .omp-queue-action:hover:not(:disabled) { background: var(--vscode-list-hoverBackground); color: var(--vscode-foreground); }
.omp-queue-all:focus-visible, .omp-queue-action:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
.omp-queue-all:disabled, .omp-queue-action:disabled { opacity: 0.55; cursor: default; }
.omp-queue-rows { padding-bottom: ${HUD_LIST_PAD_PX}px; }
.omp-queue-item { display: flex; gap: 6px; align-items: center; min-width: 0; height: ${HUD_LINE_PX}px; box-sizing: border-box; padding: 1px 0; overflow: hidden; white-space: nowrap; }
.omp-queue-kind { flex: none; color: var(--omp-muted); font-size: 0.85em; }
.omp-queue-item--steering .omp-queue-kind { color: var(--vscode-charts-blue); }
.omp-queue-text { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.omp-queue-more { color: var(--omp-muted); }
.omp-queue-action { display: flex; flex: none; align-items: center; justify-content: center; width: 20px; height: 18px; padding: 0; border: 0; border-radius: 3px; background: none; color: var(--omp-muted); cursor: pointer; }
.omp-queue-status { display: flex; gap: 6px; align-items: center; min-width: 0; height: ${HUD_LINE_PX}px; box-sizing: border-box; padding: 1px 8px 1px 30px; overflow: hidden; white-space: nowrap; }
.omp-queue-status--warn .codicon-warning { color: var(--vscode-editorWarning-foreground); }
.omp-queue-status-text { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
`;

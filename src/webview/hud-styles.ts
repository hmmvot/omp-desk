import { HUD_HEADER_PX, HUD_LINE_PX, HUD_LIST_PAD_PX, HUD_STACK_PAD_PX } from "../chat/hud-summary.ts";

/**
 * The TODO and Agents rows of the bottom block, and the detail tabs. Theme variables only. The
 * rows are flat tool rows (no panel background, no band) in the chat column's own width, in normal
 * flow with no overflow or scroll region: the transcript stays the one vertical scroll owner.
 * Every row has a fixed height (the constants `hudSectionLines` budgets with) and is one clipped
 * line with its full text in `title`, so a narrow window truncates instead of wrapping.
 */
export const HUD_STYLES = `
.omp-hud-stack { flex: 0 0 auto; width: min(840px, calc(100% - 24px)); min-width: 0; margin: 0 auto; padding-bottom: ${HUD_STACK_PAD_PX}px; }
.omp-hud { min-width: 0; line-height: 18px; }
.omp-hud-head { display: flex; align-items: center; min-width: 0; height: ${HUD_HEADER_PX}px; box-sizing: border-box; }
.omp-hud-toggle { display: flex; flex: 1 1 auto; min-width: 0; height: 100%; box-sizing: border-box; gap: 6px; align-items: center; padding: 4px 8px; border: 0; border-radius: 4px; background: none; color: inherit; font: inherit; line-height: 18px; text-align: left; cursor: pointer; }
.omp-hud-toggle:hover, .omp-hud-open:hover:not(:disabled), .omp-hud-agent:hover:not(:disabled), .omp-hud-more:hover:not(:disabled) { background: var(--vscode-list-hoverBackground); }
.omp-hud-toggle:focus-visible, .omp-hud-open:focus-visible, .omp-hud-agent:focus-visible, .omp-hud-more:focus-visible, .omp-detail-agent:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
.omp-hud .codicon { flex: none; }
.omp-hud-label { flex: none; font-weight: 600; }
.omp-hud-summary { flex: 1 1 auto; min-width: 0; overflow: hidden; color: var(--omp-muted); text-overflow: ellipsis; white-space: nowrap; }
.omp-hud-summary--warn { color: var(--vscode-editorWarning-foreground); }
.omp-hud-counter { flex: none; color: var(--omp-muted); font-variant-numeric: tabular-nums; }
.omp-hud-open { flex: none; align-self: stretch; padding: 0 8px; border: 0; border-radius: 4px; background: none; color: var(--omp-muted); cursor: pointer; }
.omp-hud-open:disabled, .omp-hud-agent:disabled, .omp-hud-more:disabled { opacity: 0.55; cursor: default; }
.omp-hud-rows { list-style: none; margin: 0; padding: 0 8px ${HUD_LIST_PAD_PX}px 30px; }
.omp-hud-line { display: flex; gap: 6px; align-items: center; min-width: 0; height: ${HUD_LINE_PX}px; box-sizing: border-box; padding: 1px 0; overflow: hidden; white-space: nowrap; }
.omp-hud-dim { flex: none; color: var(--omp-muted); }
.omp-hud-phase { color: var(--omp-muted); }
.omp-hud-phase--current { color: var(--vscode-foreground); font-weight: 600; }
.omp-hud-tone--success { color: var(--vscode-testing-iconPassed); }
.omp-hud-tone--accent { color: var(--vscode-charts-blue); }
.omp-hud-tone--dim { color: var(--omp-muted); }
.omp-hud-tone--error { color: var(--vscode-errorForeground); }
.omp-hud-tone--warning { color: var(--vscode-editorWarning-foreground); }
/* Status tones belong to glyphs, never to closed task prose. */
.omp-hud-task.omp-hud-tone--success, .omp-hud-task.omp-hud-tone--error,
.omp-detail-task.omp-hud-tone--success, .omp-detail-task.omp-hud-tone--error { color: var(--vscode-descriptionForeground); }
.omp-hud-task.omp-hud-tone--success > .codicon, .omp-detail-task.omp-hud-tone--success > .omp-detail-task-head > .codicon { color: var(--vscode-testing-iconPassed); }
.omp-hud-task.omp-hud-tone--error > .codicon, .omp-detail-task.omp-hud-tone--error > .omp-detail-task-head > .codicon { color: var(--vscode-descriptionForeground); }
.omp-hud-agent, .omp-hud-more { width: 100%; padding: 1px 0; border: 0; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.omp-hud-more { padding: 0; color: var(--omp-muted); }
.omp-hud-agent { flex-wrap: wrap; height: auto; min-height: ${HUD_LINE_PX}px; }
.omp-hud-agent-id { flex: none; max-width: 100%; white-space: normal; overflow-wrap: anywhere; color: var(--vscode-charts-blue); font-weight: 600; }
.omp-hud-agent .omp-hud-badge { flex: none; max-width: 100%; white-space: normal; overflow-wrap: anywhere; }
.omp-hud-agent .omp-hud-activity { flex: 1 1 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.omp-hud-elapsed { flex: none; margin-left: auto; padding-left: 8px; color: var(--omp-muted); font-variant-numeric: tabular-nums; }
.omp-hud-agent--failed .omp-hud-agent-id { color: var(--vscode-errorForeground); }
.omp-hud-agent--completed .codicon-check { color: var(--vscode-testing-iconPassed); }
@media (prefers-reduced-motion: reduce) { .codicon.codicon-loading.codicon-modifier-spin, .codicon.codicon-sync.codicon-modifier-spin, .codicon.codicon-gear.codicon-modifier-spin { animation: none; } }

.omp-detail { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.omp-detail--todo, .omp-detail--agents { overflow-y: auto; }
.omp-detail-body { display: flex; flex-direction: column; min-height: 0; padding: 12px max(12px, calc((100% - 840px) / 2)) 24px; }
.omp-detail-body--agent { flex: 1 1 auto; padding-bottom: 0; }
.omp-detail-title { display: flex; flex-wrap: wrap; gap: 6px; align-items: baseline; margin: 0 0 8px; font-size: 1.15em; font-weight: 600; }
.omp-detail-count, .omp-detail-status { color: var(--omp-muted); font-size: 0.85em; font-weight: 400; }
.omp-detail-phase h2 { margin: 14px 0 4px; font-size: 1em; }
.omp-detail-tasks, .omp-detail-agents { list-style: none; margin: 0; padding: 0; }
.omp-detail-task { padding: 5px 0; border-bottom: 1px solid var(--omp-border); }
.omp-detail-task-head { display: flex; gap: 6px; align-items: baseline; }
.omp-detail-task-text { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
.omp-detail-blocker { margin: 2px 0 0 20px; color: var(--vscode-editorWarning-foreground); }
.omp-detail-section { margin: 4px 0 0 20px; }
.omp-detail-section h3 { margin: 0; font-size: 0.85em; color: var(--omp-muted); letter-spacing: 0.04em; }
.omp-detail-section ul { margin: 2px 0; padding-left: 18px; }
.omp-detail-agent { display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: baseline; width: 100%; padding: 6px 4px; border: 0; border-bottom: 1px solid var(--omp-border); background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.omp-detail-agent:hover:not(:disabled) { background: var(--vscode-list-hoverBackground); }
.omp-detail-agent-line { flex: 1 1 100%; min-width: 0; overflow-wrap: anywhere; }
.omp-detail-agent > .omp-native-agent-progress { flex: 1 1 100%; }
.omp-detail-agent-head { flex: none; }
.omp-detail-assignment { flex: none; margin: 4px 0 8px; }
.omp-detail--agent .omp-native-child-body { display: flex; flex: 1 1 auto; flex-direction: column; min-height: 0; border: 0; padding: 0; }
.omp-detail--agent .omp-native-child-toolbar { flex: none; padding: 4px 0; }
.omp-detail--agent .omp-transcript-frame { flex: 1 1 auto; min-height: 0; }
`;

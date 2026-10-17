/**
 * The find bar of the transcript (`components/TranscriptFind.tsx`) and the paint of what it finds. Theme variables only: the bar is
 * VS Code's find widget in the corner of the transcript, the occurrences use the editor's find colours.
 */
export const FIND_STYLES = `
.omp-find { position: absolute; top: 8px; right: 18px; z-index: 3; box-sizing: border-box; width: min(420px, calc(100% - 36px)); padding: 4px 6px; border: 1px solid var(--vscode-widget-border, var(--omp-border)); border-radius: var(--omp-radius-card); background: var(--vscode-editorWidget-background); color: var(--vscode-editorWidget-foreground, var(--vscode-foreground)); box-shadow: 0 0 8px 2px var(--vscode-widget-shadow, transparent); }
.omp-find-row { display: flex; gap: 2px; align-items: center; min-width: 0; }
.omp-find-input { flex: 1 1 auto; min-width: 0; box-sizing: border-box; height: 24px; padding: 2px 6px; border: 1px solid var(--vscode-input-border, transparent); border-radius: var(--omp-radius); background: var(--vscode-input-background); color: var(--vscode-input-foreground); font: inherit; }
.omp-find-input::placeholder { color: var(--vscode-input-placeholderForeground); }
.omp-find-input:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
.omp-find-status { flex: none; min-width: 7ch; padding: 0 6px; color: var(--omp-muted); font-size: 0.92em; text-align: center; white-space: nowrap; }
.omp-find-button { display: flex; flex: none; align-items: center; justify-content: center; width: 22px; height: 22px; padding: 0; border: 1px solid transparent; border-radius: var(--omp-radius); background: none; color: inherit; cursor: pointer; }
.omp-find-button:hover:not(:disabled) { background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground)); }
.omp-find-button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
.omp-find-button:disabled { opacity: 0.4; cursor: default; }
.omp-find-button[aria-pressed="true"] { border-color: var(--vscode-inputOption-activeBorder, transparent); background: var(--vscode-inputOption-activeBackground); color: var(--vscode-inputOption-activeForeground, inherit); }
.omp-find-note { padding: 3px 4px 1px; color: var(--omp-muted); font-size: 0.92em; }
.vscode-high-contrast .omp-find, .vscode-high-contrast-light .omp-find { border-color: var(--vscode-contrastBorder, var(--omp-border)); }
::highlight(omp-find) { background-color: var(--vscode-editor-findMatchHighlightBackground, rgba(234, 92, 0, 0.33)); color: inherit; }
::highlight(omp-find-current) { background-color: var(--vscode-editor-findMatchBackground, rgba(162, 98, 0, 0.9)); color: inherit; }
.vscode-high-contrast ::highlight(omp-find-current), .vscode-high-contrast-light ::highlight(omp-find-current) { text-decoration: underline; }
/* A current match whose text is not in the page (deep in a long output) or that cannot be painted: its row is marked. */
.omp-row[data-find-current] { outline: 1px solid var(--vscode-editor-findMatchBorder, var(--vscode-focusBorder)); outline-offset: -1px; }
`;

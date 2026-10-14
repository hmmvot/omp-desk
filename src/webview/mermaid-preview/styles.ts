/** Styles of the diagram tab (`./main.ts`), injected as one nonce'd `<style>`; the colours are the VS Code theme's own variables. */
export const MERMAID_PREVIEW_STYLES = `
html, body { height: 100%; margin: 0; }
body { display: flex; flex-direction: column; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
.bar { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; padding: 6px 12px; border-bottom: 1px solid var(--vscode-panel-border, transparent); background: var(--vscode-editorWidget-background, var(--vscode-editor-background)); }
.bar button { padding: 2px 8px; border: 1px solid var(--vscode-button-border, transparent); border-radius: 2px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); font: inherit; cursor: pointer; }
.bar button:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
.bar button:disabled { opacity: 0.5; cursor: default; }
.bar button:focus-visible, .stage:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
.bar .gap { flex: 1 1 auto; }
.status { display: inline-flex; align-items: center; gap: 6px; color: var(--vscode-descriptionForeground); min-height: 1.4em; }
.spinner { width: 12px; height: 12px; box-sizing: border-box; border: 2px solid var(--vscode-descriptionForeground); border-right-color: transparent; border-radius: 50%; animation: omp-spin 0.9s linear infinite; }
@keyframes omp-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .spinner { animation: none; border-right-color: var(--vscode-descriptionForeground); } }
.stage { flex: 1 1 auto; overflow: auto; padding: 16px; }
.stage img { display: block; margin: 0 auto; }
.stage[data-fit] img { max-width: 100%; height: auto; }
.waiting { display: flex; align-items: center; justify-content: center; gap: 10px; height: 100%; color: var(--vscode-descriptionForeground); font-size: 1.2em; }
.failure { max-width: 900px; margin: 0 auto; }
.failure h1 { margin: 0 0 8px; font-size: 1.1em; font-weight: 600; color: var(--vscode-errorForeground); }
.failure pre { overflow: auto; margin: 0; padding: 8px 12px; border: 1px solid var(--vscode-panel-border, transparent); border-radius: 2px; background: var(--vscode-textCodeBlock-background); font-family: var(--vscode-editor-font-family, monospace); font-size: var(--vscode-editor-font-size, 1em); white-space: pre; }
.vscode-high-contrast .bar, .vscode-high-contrast-light .bar, .vscode-high-contrast .bar button, .vscode-high-contrast-light .bar button, .vscode-high-contrast .failure pre, .vscode-high-contrast-light .failure pre { border-color: var(--vscode-contrastBorder); }
`;

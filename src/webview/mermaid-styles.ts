/** Styles of a `mermaid` block (`components/MermaidBlock.tsx`): the drawn diagram, its corner toolbar and the one-line note. */
export const MERMAID_STYLES = `
.omp-mermaid { position: relative; }
/* The diagram sits on the editor's own background in a frame like the code block's; a wide one scrolls inside it. */
.omp-mermaid-frame { overflow-x: auto; margin: 8px 0; border: 1px solid var(--omp-border); border-radius: var(--omp-radius-card); background: var(--vscode-editor-background); padding: 8px; }
.omp-mermaid-zoom { display: block; margin: 0 auto; padding: 0; border: 0; background: none; color: inherit; font: inherit; line-height: 0; cursor: zoom-in; }
.omp-mermaid-frame[data-full] .omp-mermaid-zoom { cursor: zoom-out; }
.omp-mermaid-zoom:disabled { cursor: default; }
.omp-mermaid-zoom:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
/* Fitted: never wider than the block, never upscaled; full size: the diagram's own size, scrolled. */
.omp-mermaid-zoom img { display: block; max-width: 100%; height: auto; }
.omp-mermaid-frame[data-full] .omp-mermaid-zoom img { max-width: none; }
/* Diagram | Source and Copy: hidden until the block is hovered or focused, like Copy on a code block. */
.omp-mermaid-bar { position: absolute; top: 12px; right: 4px; display: flex; align-items: center; gap: 2px; opacity: 0; }
.omp-mermaid:hover .omp-mermaid-bar, .omp-mermaid:focus-within .omp-mermaid-bar { opacity: 1; }
.omp-mermaid-tab { padding: 2px 6px; border: 1px solid var(--vscode-button-border, transparent); border-radius: var(--omp-radius); background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); font: inherit; font-size: 11px; cursor: pointer; }
.omp-mermaid-tab:hover { background: var(--vscode-button-secondaryHoverBackground); }
.omp-mermaid-tab[aria-pressed="true"] { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.omp-mermaid-tab:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
.omp-mermaid-copy { margin-left: 2px; }
.vscode-high-contrast .omp-mermaid-frame, .vscode-high-contrast-light .omp-mermaid-frame { border-color: var(--vscode-contrastBorder); }
.vscode-high-contrast .omp-mermaid-tab, .vscode-high-contrast-light .omp-mermaid-tab { border-color: var(--vscode-contrastBorder); }
/* Why a block is still code: one muted line under it. */
.omp-mermaid-note { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; margin: -2px 0 8px; color: var(--omp-muted); font-size: 11px; }
.omp-mermaid-open { padding: 0; border: 0; background: none; color: var(--vscode-textLink-foreground); font: inherit; cursor: pointer; text-decoration: underline; }
.omp-mermaid-open:hover { color: var(--vscode-textLink-activeForeground, var(--vscode-textLink-foreground)); }
.omp-mermaid-open:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
`;

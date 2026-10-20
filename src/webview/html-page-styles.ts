/**
 * Styles of a reply's HTML page (`components/HtmlPageBlock.tsx`): one bordered block of a header row, the frame (or the source) and, for
 * a page taller than the cap, a bottom row with Show full page / Show less. Nothing lies over the page: the header is a row of its own,
 * always visible. The page buttons reuse the Mermaid block's tab and copy look (`mermaid-styles.ts`).
 */
export const HTML_PAGE_STYLES = `
.omp-htmlpage { margin: 8px 0; border: 1px solid var(--omp-border); border-radius: var(--omp-radius-card); overflow: hidden; }
.omp-htmlpage-head { display: flex; align-items: center; gap: 2px; padding: 3px 6px; border-bottom: 1px solid var(--omp-border); background: var(--vscode-textCodeBlock-background); }
.omp-htmlpage-copy { margin-left: auto; }
.omp-htmlpage-frame { display: block; width: 100%; border: 0; }
.omp-htmlpage-source .omp-code-block pre { margin: 0; border: 0; border-radius: 0; }
.omp-htmlpage-streaming { overflow-y: auto; }
.omp-htmlpage-more { display: block; width: 100%; padding: 4px 8px; border: 0; border-top: 1px solid var(--omp-border); background: var(--vscode-textCodeBlock-background); color: var(--omp-muted); font: inherit; font-size: 11px; cursor: pointer; }
.omp-htmlpage-more:hover { color: var(--vscode-foreground); }
.omp-htmlpage-more:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
.vscode-high-contrast .omp-htmlpage, .vscode-high-contrast-light .omp-htmlpage, .vscode-high-contrast .omp-htmlpage-head, .vscode-high-contrast-light .omp-htmlpage-head, .vscode-high-contrast .omp-htmlpage-more, .vscode-high-contrast-light .omp-htmlpage-more { border-color: var(--vscode-contrastBorder); }
`;

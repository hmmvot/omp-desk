/**
 * Styles of a reply's HTML page (`components/HtmlPageBlock.tsx`). The corner toolbar and the note reuse the Mermaid block's classes
 * (`mermaid-styles.ts`); only the frame's box is new. The frame is as wide as the block; its height is set by the page's own report,
 * never beyond 70% of the view, so a tall page scrolls inside itself and never takes the transcript's scroll.
 */
export const HTML_PAGE_STYLES = `
.omp-htmlpage-box { margin: 8px 0; border: 1px solid var(--omp-border); border-radius: var(--omp-radius-card); overflow: hidden; }
.omp-htmlpage-frame { display: block; width: 100%; max-height: 70vh; border: 0; }
.vscode-high-contrast .omp-htmlpage-box, .vscode-high-contrast-light .omp-htmlpage-box { border-color: var(--vscode-contrastBorder); }
`;

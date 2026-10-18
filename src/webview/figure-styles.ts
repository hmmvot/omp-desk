/**
 * Styles of an `svg` figure (`components/SvgFigureBlock.tsx`). The corner toolbar, the note and the block itself reuse the
 * Mermaid block's classes (`mermaid-styles.ts`); only the frame and the image are new.
 */
export const FIGURE_STYLES = `
/* The drawing sits straight on the page, in a frame like the code block's: its colours were resolved against the theme's own
   background, so no fill of ours is added (and none in High Contrast, where the page is plain). A wide one is never wider than the block. */
.omp-figure-frame { margin: 8px 0; border: 1px solid var(--omp-border); border-radius: var(--omp-radius-card); padding: 8px; }
.omp-figure-frame img { display: block; max-width: 100%; height: auto; margin: 0 auto; }
.vscode-high-contrast .omp-figure-frame, .vscode-high-contrast-light .omp-figure-frame { border-color: var(--vscode-contrastBorder); }
`;

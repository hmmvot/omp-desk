/**
 * Math in a message (`components/Markdown.tsx`, `components/MathBlock.tsx`): inline formulas are text in a font that has the
 * mathematical glyphs; a display block is the stacked layout as monospace text (the columns must line up), the block without
 * the code block's frame.
 */
export const MATH_STYLES = `
.omp-md .omp-math { font-family: "Cambria Math", "STIX Two Math", "Segoe UI Symbol", var(--vscode-font-family), sans-serif; }
.omp-math-block { margin: 6px 0; }
.omp-md .omp-math-block pre { margin: 0; padding: 2px 0; background: transparent; border: 0; text-align: left; }
.omp-md .omp-math-block pre code { font-family: var(--omp-mono), "Cambria Math", "Segoe UI Symbol", monospace; line-height: 1.3; white-space: pre; }
`;

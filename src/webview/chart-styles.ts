/**
 * The chart under a table of numbers (`components/TableChart.tsx`). Theme variables only, so a theme change repaints it with no
 * JavaScript: series colours are the editor's chart colours (with fallbacks for themes that leave them unset), text the foreground
 * and muted colours, gridlines the border colour.
 */
export const CHART_STYLES = `
.omp-chart { max-width: 720px; margin: 8px 0 12px; }
.omp-chart-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; margin-bottom: 2px; }
.omp-chart-title { min-width: 0; overflow: hidden; color: var(--omp-muted); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.omp-chart-toggle { flex: none; padding: 0 6px; border: 1px solid transparent; border-radius: var(--omp-radius); background: none; color: var(--omp-muted); font: inherit; font-size: 11px; line-height: 18px; cursor: pointer; }
.omp-chart-toggle:hover { background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground)); color: var(--vscode-foreground); }
.omp-chart-toggle:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
/* Charts hidden: one muted line under the table. */
.omp-chart-collapsed { margin: 2px 0 8px; }
.omp-chart-collapsed .omp-chart-toggle { padding-left: 0; }
.omp-chart-figure { margin: 0; }
.omp-chart-svg { display: block; width: 100%; height: auto; max-width: 720px; overflow: visible; font-family: var(--vscode-font-family); font-size: 12px; }
.omp-chart-grid { stroke: var(--omp-border); stroke-opacity: 0.5; stroke-width: 1; shape-rendering: crispEdges; }
.omp-chart-zero { stroke: var(--omp-border); stroke-width: 1; shape-rendering: crispEdges; }
.omp-chart-label, .omp-chart-value { fill: var(--vscode-foreground); font-size: 12px; }
.omp-chart-tick, .omp-chart-legend { fill: var(--omp-muted); font-size: 11px; }
.omp-chart-c1 { --omp-chart-color: var(--vscode-charts-blue, #3794ff); }
.omp-chart-c2 { --omp-chart-color: var(--vscode-charts-orange, #d18616); }
.omp-chart-c3 { --omp-chart-color: var(--vscode-charts-green, #89d185); }
.omp-chart-c4 { --omp-chart-color: var(--vscode-charts-purple, #b180d7); }
.omp-chart-c5 { --omp-chart-color: var(--vscode-charts-red, #f14c4c); }
.omp-chart-c6 { --omp-chart-color: var(--vscode-charts-yellow, #cca700); }
.omp-chart-bar, .omp-chart-swatch, .omp-chart-dot { fill: var(--omp-chart-color); }
.omp-chart-line { fill: none; stroke: var(--omp-chart-color); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
`;

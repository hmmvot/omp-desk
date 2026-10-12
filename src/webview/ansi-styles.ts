/**
 * Terminal styling in native text (`AnsiText`). The 16 palette colors come from the theme's own terminal
 * variables, so a `/context` bar or a colored diff reads exactly as it does in VS Code's terminal; the
 * fallbacks are VS Code's Dark+ terminal colors for a theme that leaves one unset. 256-color and truecolor
 * values have no theme variable and are set per span.
 */
const PALETTE = [
	["Black", "#000000"], ["Red", "#cd3131"], ["Green", "#0dbc79"], ["Yellow", "#e5e510"],
	["Blue", "#2472c8"], ["Magenta", "#bc3fbc"], ["Cyan", "#11a8cd"], ["White", "#e5e5e5"],
	["BrightBlack", "#666666"], ["BrightRed", "#f14c4c"], ["BrightGreen", "#23d18b"], ["BrightYellow", "#f5f543"],
	["BrightBlue", "#3b8eea"], ["BrightMagenta", "#d670d6"], ["BrightCyan", "#29b8db"], ["BrightWhite", "#e5e5e5"],
] as const;

const COLOR_RULES = PALETTE.map(([name, fallback], index) => {
	const color = `var(--vscode-terminal-ansi${name}, ${fallback})`;
	return `.omp-ansi-fg-${index} { color: ${color}; }\n.omp-ansi-bg-${index} { background-color: ${color}; }`;
}).join("\n");

export const ANSI_STYLES = `
${COLOR_RULES}
.omp-ansi-inverse-fg { color: var(--vscode-terminal-background, var(--vscode-editor-background)); }
.omp-ansi-inverse-bg { background-color: var(--vscode-terminal-foreground, var(--vscode-foreground)); }
.omp-ansi-bold { font-weight: 700; }
.omp-ansi-dim { opacity: 0.7; }
.omp-ansi-italic { font-style: italic; }
.omp-ansi-underline { text-decoration: underline; }
.omp-ansi-strike { text-decoration: line-through; }
.omp-ansi-underline.omp-ansi-strike { text-decoration: underline line-through; }
`;

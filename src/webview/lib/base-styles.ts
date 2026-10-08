/**
 * The rules every guest document needs, and the theme variables they read.
 *
 * Two documents are rendered by this extension: the session panel (chat plus the
 * terminal pane) and a folder shell's editor. They are different bundles and
 * different documents, so each injects its own sheet — and this is the part they
 * share, kept in one place so a change to a theme variable cannot land in one
 * document and miss the other.
 *
 * Every color is a VS Code theme variable, never a literal, so both documents follow
 * the user's theme in light and dark.
 */
export const BASE_CSS = `:root {
	color-scheme: light dark;
	--omp-gap: 8px;
	--omp-radius: 4px;
	--omp-border: var(--vscode-widget-border, var(--vscode-panel-border));
	--omp-muted: var(--vscode-descriptionForeground);
	--omp-surface: var(--vscode-editorWidget-background, var(--vscode-editor-background));
	--omp-mono: var(--vscode-editor-font-family, ui-monospace, "Cascadia Mono", Consolas, monospace);
	--omp-mono-size: var(--vscode-editor-font-size, 12px);
}

* { box-sizing: border-box; }

html, body {
	margin: 0;
	padding: 0;
	height: 100%;
	overflow: hidden;
}

body {
	background: var(--vscode-editor-background);
	color: var(--vscode-foreground);
	font-family: var(--vscode-font-family, system-ui, sans-serif);
	font-size: var(--vscode-font-size, 13px);
	line-height: 1.5;
}

#root { height: 100vh; }`;

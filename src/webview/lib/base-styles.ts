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
	/* Three radius steps: controls, cards, the composer. Circles and pills are shapes, not steps. */
	--omp-radius: 4px;
	--omp-radius-card: 6px;
	--omp-radius-composer: 10px;
	/* Hierarchy derived from the theme's own foreground and background, so every theme (Light Modern, whose description colour is its foreground, included) gets a real step. */
	--omp-border: color-mix(in srgb, var(--vscode-foreground) 18%, transparent);
	--omp-muted: color-mix(in srgb, var(--vscode-foreground) 72%, var(--vscode-editor-background));
	--omp-surface: var(--vscode-editorWidget-background, var(--vscode-editor-background));
	--omp-mono: var(--vscode-editor-font-family, ui-monospace, "Cascadia Mono", Consolas, monospace);
	--omp-mono-size: var(--vscode-editor-font-size, 12px);
}

/* High Contrast keeps the theme's own colours: a mix of two near-black/near-white values would lower the separation these themes guarantee. */
.vscode-high-contrast, .vscode-high-contrast-light {
	--omp-border: var(--vscode-contrastBorder, var(--vscode-widget-border, var(--vscode-panel-border)));
	--omp-muted: var(--vscode-descriptionForeground, var(--vscode-foreground));
}

* { box-sizing: border-box; }

html, body {
	margin: 0;
	padding: 0;
	height: 100%;
	overflow: hidden;
}

/* The page never scrolls: the body is a real box (the document element owns the viewport overflow), and a body that is only hidden stays
   scrollable by the keyboard and by caret reveal as soon as anything in it overflows. Clip is not scrollable at all. */
body {
	overflow: clip;
	background: var(--vscode-editor-background);
	color: var(--vscode-foreground);
	font-family: var(--vscode-font-family, system-ui, sans-serif);
	font-size: var(--vscode-font-size, 13px);
	line-height: 1.5;
}

#root { height: 100vh; overflow: clip; }`;

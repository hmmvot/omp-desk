/**
 * The terminal renderer's appearance, read from the document's own theme.
 *
 * The panel styles itself entirely from VS Code's theme variables, and the terminal
 * is no exception: the renderer takes concrete colors, so this module reads the
 * computed values of the terminal's own variables and hands over only the ones the
 * theme actually defines. A variable the theme does not set is **omitted**, which
 * leaves the renderer's own default in place — inventing a color here would make the
 * terminal disagree with the editor around it.
 *
 * It takes the reader as an argument (a computed-style probe for one variable) so the
 * mapping can be exercised without a DOM.
 */
import type { ITheme } from "@xterm/xterm";

/** Everything the renderer needs to draw text and colors the way the theme does. */
export interface TerminalAppearance {
	readonly theme: ITheme;
	readonly fontFamily: string;
	readonly fontSize: number;
	readonly fontWeight: "normal" | "bold" | number;
}

/** The palette variables VS Code exposes for its own terminal. */
const PALETTE: Record<string, keyof ITheme> = {
	"--vscode-terminal-ansiBlack": "black",
	"--vscode-terminal-ansiRed": "red",
	"--vscode-terminal-ansiGreen": "green",
	"--vscode-terminal-ansiYellow": "yellow",
	"--vscode-terminal-ansiBlue": "blue",
	"--vscode-terminal-ansiMagenta": "magenta",
	"--vscode-terminal-ansiCyan": "cyan",
	"--vscode-terminal-ansiWhite": "white",
	"--vscode-terminal-ansiBrightBlack": "brightBlack",
	"--vscode-terminal-ansiBrightRed": "brightRed",
	"--vscode-terminal-ansiBrightGreen": "brightGreen",
	"--vscode-terminal-ansiBrightYellow": "brightYellow",
	"--vscode-terminal-ansiBrightBlue": "brightBlue",
	"--vscode-terminal-ansiBrightMagenta": "brightMagenta",
	"--vscode-terminal-ansiBrightCyan": "brightCyan",
	"--vscode-terminal-ansiBrightWhite": "brightWhite",
};

/** The non-palette colors, each with the variable that describes it best. */
const COLORS: readonly (readonly [keyof ITheme, string])[] = [
	["background", "--vscode-terminal-background"],
	["foreground", "--vscode-terminal-foreground"],
	["cursor", "--vscode-terminalCursor-foreground"],
	["cursorAccent", "--vscode-terminalCursor-background"],
	["selectionBackground", "--vscode-terminal-selectionBackground"],
	["scrollbarSliderBackground", "--vscode-scrollbarSlider-background"],
	["scrollbarSliderHoverBackground", "--vscode-scrollbarSlider-hoverBackground"],
	["scrollbarSliderActiveBackground", "--vscode-scrollbarSlider-activeBackground"],
];

/** Local glyph faces precede ordinary monospace, without replacing configured fonts. */
const NERD_FAMILIES = [
	"CaskaydiaCove Nerd Font Mono", "CaskaydiaCove Nerd Font", "Cascadia Code NF", "Cascadia Mono NF",
	"Symbols Nerd Font Mono", "Symbols Nerd Font",
] as const;
const MONOSPACE_FALLBACK = `"Segoe UI Symbol", codicon, ui-monospace, "Cascadia Mono", Consolas, "Courier New", monospace`;
const COMMON_NERD_FALLBACK = NERD_FAMILIES.map(name => JSON.stringify(name)).join(", ");

export function terminalFontFamily(family: string, installed: readonly string[] = []): string {
	const extra = installed.length === 0 ? "" : installed.filter(name => !NERD_FAMILIES.some(common => common.toLowerCase() === name.toLowerCase())).map(name => JSON.stringify(name)).join(", ");
	const fallback = `${COMMON_NERD_FALLBACK}${extra === "" ? "" : `, ${extra}`}, ${MONOSPACE_FALLBACK}`;
	return family.trim() === "" ? fallback : `${family}, ${fallback}`;
}

/** Read one appearance from a variable reader; the reader returns `""` when unset. */
export function terminalAppearanceFrom(read: (name: string) => string): TerminalAppearance {
	const theme: Record<string, string> = {};
	for (const [key, variable] of COLORS) {
		const value = read(variable).trim();
		if (value.length > 0) theme[key] = value;
	}
	for (const [variable, key] of Object.entries(PALETTE)) {
		const value = read(variable).trim();
		if (value.length > 0) theme[key] = value;
	}
	// The editor's own colors are the terminal's when the terminal's are not set: a
	// theme that styles the editor but not the terminal still yields a readable screen.
	if (theme.background === undefined) {
		const fallback = read("--vscode-editor-background").trim();
		if (fallback.length > 0) theme.background = fallback;
	}
	if (theme.foreground === undefined) {
		const fallback = read("--vscode-foreground").trim();
		if (fallback.length > 0) theme.foreground = fallback;
	}

	const family = read("--vscode-editor-font-family").trim();
	const size = Number.parseFloat(read("--vscode-editor-font-size"));
	const weight = read("--vscode-editor-font-weight").trim();
	return {
		theme: theme as ITheme,
		fontFamily: terminalFontFamily(family),
		fontSize: Number.isFinite(size) && size >= 6 && size <= 40 ? size : 12,
		fontWeight: weight === "bold" ? "bold" : weight === "normal" ? "normal" : Number.parseInt(weight, 10) || "normal",
	};
}

import type { CSSProperties, ReactNode } from "react";
import { Fragment, useMemo } from "react";
import { paletteHex, parseAnsi, type AnsiColor, type AnsiLine, type AnsiStyle } from "../../chat/ansi";

/** The color an inverse run shows where its own side is the terminal default: the other default. */
const DEFAULT_SIDE = "default";

function paint(role: "fg" | "bg", color: AnsiColor, classes: string[], css: CSSProperties): void {
	if (color === DEFAULT_SIDE) classes.push(role === "fg" ? "omp-ansi-inverse-fg" : "omp-ansi-inverse-bg");
	else if (typeof color === "number" && color < 16) classes.push(`omp-ansi-${role}-${color}`);
	else css[role === "fg" ? "color" : "backgroundColor"] = typeof color === "number" ? paletteHex(color) : color;
}

/**
 * The classes and CSSOM properties one style needs. The 16 palette colors are classes over the VS Code terminal
 * theme variables; 256-color and truecolor values are set as properties (React applies them through the CSSOM,
 * which the page's stylesheet policy allows) because there is no theme variable for them.
 */
function appearance(style: AnsiStyle): { className: string; css: CSSProperties } {
	const classes: string[] = [];
	const css: CSSProperties = {};
	const fg = style.inverse ? style.bg ?? DEFAULT_SIDE : style.fg;
	const bg = style.inverse ? style.fg ?? DEFAULT_SIDE : style.bg;
	if (fg !== undefined) paint("fg", fg, classes, css);
	if (bg !== undefined) paint("bg", bg, classes, css);
	if (style.bold) classes.push("omp-ansi-bold");
	if (style.dim) classes.push("omp-ansi-dim");
	if (style.italic) classes.push("omp-ansi-italic");
	if (style.underline) classes.push("omp-ansi-underline");
	if (style.strike) classes.push("omp-ansi-strike");
	return { className: classes.join(" "), css };
}

/** Parsed lines as styled spans joined by newline text nodes: selecting or copying yields plain text only. */
export function AnsiLines({ lines }: { lines: readonly AnsiLine[] }): ReactNode {
	return <>{lines.map((line, row) => <Fragment key={row}>
		{row > 0 && "\n"}
		{line.map((span, index) => {
			if (span.style === null) return span.text;
			const { className, css } = appearance(span.style);
			return <span key={index} className={className} style={css}>{span.text}</span>;
		})}
	</Fragment>)}</>;
}

/** Text that may carry terminal styling, drawn as styled spans; no escape sequence is ever shown. */
export function AnsiText({ text }: { text: string }): ReactNode {
	const lines = useMemo(() => parseAnsi(text), [text]);
	return <AnsiLines lines={lines} />;
}

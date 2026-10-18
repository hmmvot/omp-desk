/**
 * A fenced `svg` block of an assistant reply: the drawing once the block is complete, the code until then, as the terminal UI shows it.
 *
 * What the reader sees, by state:
 * - not the assistant's own reply text (a user message, a tool result, thinking): the plain code block, nothing drawn;
 * - the closing fence has not arrived (the reply is streaming): the code block; the text changes with every token;
 * - closed and made safe ({@link prepareSvgFigure}): the drawing as an image (an SVG image cannot run script or reach the page),
 *   with a Figure | Source toggle and Copy of the source in the corner, and a muted note when parts had to be removed;
 * - refused, or an image the browser cannot decode: the code block and one muted line saying why.
 */
import { useContext, useMemo, useState } from "react";
import { useFigurePalette } from "../lib/figure-palette.ts";
import { prepareSvgFigure, svgDataUrl, type PreparedFigure } from "../lib/svg-figure.ts";
import { AssistantReplyContext } from "./FileLinks.tsx";
import { CodeBlock } from "./CodeBlock.tsx";
import { CopyButton } from "./CopyButton.tsx";

/** Longest reason shown on the one muted line. */
const NOTE_CHARS = 160;
const PREFERENCE_ENTRIES = 64;

type View = "figure" | "source";
type Drawn = Extract<PreparedFigure, { ok: true }>;

const preferences = new Map<string, View>();

/** The view the reader left this source in; the transcript unmounts rows that scroll away and mounts them again. */
function preferenceFor(source: string): View {
	return preferences.get(source) ?? "figure";
}

function rememberPreference(source: string, view: View): void {
	preferences.delete(source);
	preferences.set(source, view);
	if (preferences.size > PREFERENCE_ENTRIES) preferences.delete(preferences.keys().next().value as string);
}

/** `leaf` is the quote record number of the block (`data-md-leaf`); the drawn figure carries none and contributes nothing to a quote, the Source view and the code fallback carry it. */
export function SvgFigureBlock({ source, closed, leaf }: { source: string; closed: boolean; leaf?: number }) {
	// Only the assistant's own reply text is drawn; the same fence in a user message, a tool result or thinking is the code it was written as.
	const eligible = useContext(AssistantReplyContext);
	return eligible ? <FigureBlock source={source} closed={closed} leaf={leaf} /> : <CodeBlock language="svg" source={source} closed={closed} leaf={leaf} />;
}

function FigureBlock({ source, closed, leaf }: { source: string; closed: boolean; leaf?: number }) {
	const palette = useFigurePalette();
	// A changed theme prepares the figure again: its colours are written into it.
	const prepared = useMemo(() => (closed ? prepareSvgFigure(source, palette) : null), [closed, source, palette]);
	const src = useMemo(() => (prepared?.ok === true ? svgDataUrl(prepared.svg) : null), [prepared]);
	// The image the browser failed to decode; another theme's image is another attempt.
	const [failedSrc, setFailedSrc] = useState<string | null>(null);

	if (prepared?.ok === true && src !== null && failedSrc !== src) {
		return <DrawnFigure key={source} source={source} figure={prepared} src={src} leaf={leaf} onError={() => setFailedSrc(src)} />;
	}
	const reason = prepared === null ? null : prepared.ok ? "The browser could not draw this SVG" : prepared.reason;
	return (
		<div className="omp-mermaid">
			<CodeBlock language="svg" source={source} closed={closed} leaf={leaf} />
			{reason !== null && (
				<div className="omp-mermaid-note">
					<span>Figure not drawn: {reason.length > NOTE_CHARS ? `${reason.slice(0, NOTE_CHARS - 1)}…` : reason}</span>
				</div>
			)}
		</div>
	);
}

function DrawnFigure({ source, figure, src, leaf, onError }: { source: string; figure: Drawn; src: string; leaf?: number; onError: () => void }) {
	const [view, setView] = useState<View>(() => preferenceFor(source));
	const choose = (next: View): void => {
		setView(next);
		rememberPreference(source, next);
	};
	return (
		<div className="omp-mermaid omp-mermaid--drawn">
			{view === "figure" ? (
				<div className="omp-figure-frame">
					<img src={src} width={figure.width} height={figure.height} alt={figure.title.length > 0 ? figure.title : "SVG figure"} draggable={false} onError={onError} />
				</div>
			) : (
				<CodeBlock language="svg" source={source} closed copy={false} leaf={leaf} />
			)}
			{view === "figure" && figure.stripped && (
				<div className="omp-mermaid-note">
					<span>Unsafe or unsupported parts were removed.</span>
				</div>
			)}
			<div className="omp-mermaid-bar" role="toolbar" aria-label="Figure view">
				<button type="button" className="omp-mermaid-tab" aria-pressed={view === "figure"} onClick={() => choose("figure")}>Figure</button>
				<button type="button" className="omp-mermaid-tab" aria-pressed={view === "source"} onClick={() => choose("source")}>Source</button>
				<CopyButton text={source} label="Copy SVG source" className="omp-mermaid-copy" />
			</div>
		</div>
	);
}

/**
 * A fenced `mermaid` block of a message: the diagram once the block is complete and drawn, the code until then.
 *
 * What the reader sees, by state:
 * - the closing fence has not arrived (the reply is streaming): the code block; nothing is drawn, because the
 *   text changes with every token;
 * - closed, waiting for the renderer or its turn: the same code block; the swap to the image is the one reflow
 *   a diagram costs, and a diagram drawn before (a remounted row, another theme) is shown at once from the cache;
 * - drawn: the diagram as an image (an SVG image cannot run script or reach the page), with a Diagram | Source
 *   toggle and Copy of the source in the corner;
 * - refused, failed or unsupported: the code block and one muted line saying why;
 * - not the assistant's own reply text (a user message, a tool result, thinking): the plain code block, nothing drawn.
 */
import { useContext, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { guestTransport } from "../bridge.ts";
import { mermaidSourceRefusal } from "../mermaid/contract.ts";
import { isOpenableMermaidSource } from "../../protocol/mermaid-preview.ts";
import { mermaidKind } from "../../shared/mermaid-source.ts";
import { mermaidPreference, mermaidVersion, peekMermaid, requestMermaid, setMermaidPreference, subscribeMermaid, type MermaidOutcome, type MermaidPreference } from "../lib/mermaid-render.ts";
import { AssistantReplyContext } from "./FileLinks.tsx";
import { CodeBlock } from "./CodeBlock.tsx";
import { CopyButton } from "./CopyButton.tsx";

/** Longest reason shown on the one muted line. */
const NOTE_CHARS = 160;

type Diagram = Extract<MermaidOutcome, { kind: "diagram" }>;

export function MermaidBlock({ source, closed }: { source: string; closed: boolean }) {
	// Only the assistant's own reply text is drawn; the same fence in a user message, a tool result or thinking is the code it was written as.
	const eligible = useContext(AssistantReplyContext);
	return eligible ? <DiagramBlock source={source} closed={closed} /> : <CodeBlock language="mermaid" source={source} closed={closed} />;
}

function DiagramBlock({ source, closed }: { source: string; closed: boolean }) {
	// The tab is opened through the panel; a bridged editor (after an extension-host restart) cannot ask, and says so.
	const [notOpened, setNotOpened] = useState(false);
	const version = useSyncExternalStore(subscribeMermaid, mermaidVersion, mermaidVersion);
	const refusal = closed ? mermaidSourceRefusal(source) : null;
	const wanted = closed && refusal === null;
	// `version` re-runs the request after a theme change or a finished render; a result already cached asks for nothing.
	useEffect(() => (wanted ? requestMermaid(source) : undefined), [wanted, source, version]);
	const outcome = wanted ? peekMermaid(source) : null;

	// While the new theme's diagram is drawn the previous one stays on screen: a theme change never blanks the block.
	const lastDiagram = useRef<{ readonly source: string; readonly diagram: Diagram } | null>(null);
	if (outcome?.kind === "diagram") lastDiagram.current = { source, diagram: outcome };
	const diagram = outcome?.kind === "diagram" ? outcome : wanted && lastDiagram.current?.source === source ? lastDiagram.current.diagram : null;
	if (diagram !== null) return <MermaidFigure source={source} diagram={diagram} />;

	const reason = refusal ?? (outcome?.kind === "failed" ? outcome.message : null);
	// A refusal and a diagram drawn too large are limits of the transcript; the diagram tab has wider ones and the reader may ask for it.
	const tabHelps = (refusal !== null || (outcome?.kind === "failed" && outcome.tab)) && isOpenableMermaidSource(source);
	return (
		<div className="omp-mermaid">
			<CodeBlock language="mermaid" source={source} closed={closed} />
			{reason !== null && (
				<div className="omp-mermaid-note">
					<span>Diagram not rendered: {reason.length > NOTE_CHARS ? `${reason.slice(0, NOTE_CHARS - 1)}…` : reason}</span>
					{tabHelps && (
						<button type="button" className="omp-mermaid-open" title="Draw this diagram in an editor tab of its own, without the transcript's size limits" onClick={() => setNotOpened(!guestTransport.post({ type: "omp:open-mermaid", source }))}>
							Open diagram in a tab
						</button>
					)}
					{notOpened && <span role="status">The tab cannot be opened from this editor now. Reload the window.</span>}
				</div>
			)}
		</div>
	);
}

function MermaidFigure({ source, diagram }: { source: string; diagram: Diagram }) {
	const [preference, setPreference] = useState<MermaidPreference>(() => mermaidPreference(source));
	const choose = (next: MermaidPreference): void => {
		setPreference(next);
		setMermaidPreference(source, next);
	};
	const frame = useRef<HTMLDivElement>(null);
	// A diagram wider than the block is scaled down to fit; only then is there anything for a click to enlarge. The width the
	// block offers is measured, never the image's own: at full size the image is as wide as the diagram, which would read as
	// "nothing to enlarge" and disable the control the reader just pressed, taking their keyboard focus with it.
	const [scaled, setScaled] = useState(false);
	useEffect(() => {
		const element = frame.current;
		if (element === null) return;
		const measure = (): void => {
			const style = getComputedStyle(element);
			setScaled(element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) < diagram.width - 1);
		};
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		measure();
		return () => observer.disconnect();
	}, [diagram.width, preference.view]);
	const kind = mermaidKind(source);
	const zoomable = scaled || preference.full;
	return (
		<div className="omp-mermaid omp-mermaid--drawn">
			{preference.view === "diagram" ? (
				<div className="omp-mermaid-frame" ref={frame} data-full={preference.full ? "" : undefined}>
					<button
						type="button"
						className="omp-mermaid-zoom"
						disabled={!zoomable}
						aria-pressed={preference.full}
						aria-label={`Mermaid ${kind} diagram, full size`}
						title={preference.full ? "Fit to width" : "Show full size"}
						onClick={() => choose({ ...preference, full: !preference.full })}
					>
						<img src={diagram.src} width={diagram.width} height={diagram.height} alt={`Mermaid ${kind} diagram`} draggable={false} />
					</button>
				</div>
			) : (
				<CodeBlock language="mermaid" source={source} closed copy={false} />
			)}
			<div className="omp-mermaid-bar" role="toolbar" aria-label="Diagram view">
				<button type="button" className="omp-mermaid-tab" aria-pressed={preference.view === "diagram"} onClick={() => choose({ ...preference, view: "diagram" })}>Diagram</button>
				<button type="button" className="omp-mermaid-tab" aria-pressed={preference.view === "source"} onClick={() => choose({ ...preference, view: "source" })}>Source</button>
				<CopyButton text={source} label="Copy mermaid source" className="omp-mermaid-copy" />
			</div>
		</div>
	);
}

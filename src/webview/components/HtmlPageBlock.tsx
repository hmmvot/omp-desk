/**
 * A fenced `html` block of an assistant reply: a live page once the block is complete, the code until then.
 *
 * What the reader sees, by state:
 * - not the assistant's own reply text (a user message, a tool result, thinking), or `ompDesk.chatHtmlPages` off: the plain code block, nothing run;
 * - the closing fence has not arrived (the reply is streaming): the code block; the text changes with every token;
 * - closed ({@link prepareHtmlPage}): one bordered block: a header row of its own (always visible, never over the page) with Page | Source and
 *   Copy, the sandboxed frame (`lib/html-page.ts` says what that frame can and cannot do) and, for a page taller than the cap, a bottom row with
 *   Show full page / Show less;
 * - refused (empty, too large, no nonce): the code block and one muted line saying why.
 *
 * The frame reports its content height by message (only the window of this block's own frame is listened to). Collapsed, the frame is that
 * height up to the cap and the page scrolls inside it; expanded it is the whole content height, with no inner scroll, and follows the content.
 * The block's size change reaches the transcript through its rows' `ResizeObserver`, like any other row that grows.
 */
import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { HTML_PAGE_INITIAL_HEIGHT, HTML_PAGE_MAX_HEIGHT, htmlPageMessage, htmlPageThemeMessage, isHtmlPageReady, parseHtmlPageSize, prepareHtmlPage } from "../lib/html-page.ts";
import { HTML_PAGE_FRAME_CLASS, holdHtmlPageFocusGuard } from "../lib/html-page-focus.ts";
import { htmlPageFrameUrl, useHtmlPageTheme } from "../lib/html-page-theme.ts";
import { useHtmlPagesEnabled } from "../lib/html-pages-enabled.ts";
import { AssistantReplyContext } from "./FileLinks.tsx";
import { CodeBlock } from "./CodeBlock.tsx";
import { CopyButton } from "./CopyButton.tsx";

/** Longest reason shown on the one muted line. */
const NOTE_CHARS = 160;
const MEMORY_ENTRIES = 64;
/** How long a frame has to say `ready` before the block gives up and stays code. */
const FRAME_TIMEOUT_MS = 6000;
const NO_FRAME = "This window has no page frame; reload the window to start it";
const FRAME_SILENT = "The page frame did not answer";

type View = "page" | "source";

const preferences = new Map<string, View>();
const heights = new Map<string, number>();
const expansions = new Map<string, boolean>();

/** The view the reader left this source in, and the height its page last had: the transcript unmounts rows that scroll away and mounts them again. */
function remember<T>(memory: Map<string, T>, source: string, value: T): void {
	memory.delete(source);
	memory.set(source, value);
	if (memory.size > MEMORY_ENTRIES) memory.delete(memory.keys().next().value as string);
}

/** `leaf` is the quote record number of the block (`data-md-leaf`); the live page carries none and contributes nothing to a quote, the Source view and the code fallback carry it. */
export function HtmlPageBlock({ source, closed, leaf }: { source: string; closed: boolean; leaf?: number }) {
	// Only the assistant's own reply text runs a page; the same fence in a user message, a tool result or thinking is the code it was written as.
	const eligible = useContext(AssistantReplyContext);
	const enabled = useHtmlPagesEnabled();
	return eligible && enabled ? <PageBlock source={source} closed={closed} leaf={leaf} /> : <CodeBlock language="html" source={source} closed={closed} leaf={leaf} />;
}

function PageBlock({ source, closed, leaf }: { source: string; closed: boolean; leaf?: number }) {
	const prepared = useMemo(() => (closed ? prepareHtmlPage(source) : null), [closed, source]);
	const frameUrl = useMemo(htmlPageFrameUrl, []);
	if (prepared?.ok === true && frameUrl !== null) return <DrawnPage key={source} source={source} frameUrl={frameUrl} leaf={leaf} />;
	const reason = prepared === null ? null : prepared.ok ? NO_FRAME : prepared.reason;
	return <CodeWithNote source={source} closed={closed} reason={reason} leaf={leaf} />;
}

/** The code block, and one muted line saying why it is not a page, when there is a reason. */
function CodeWithNote({ source, closed, reason, leaf }: { source: string; closed: boolean; reason: string | null; leaf?: number }) {
	return (
		<div className="omp-mermaid">
			<CodeBlock language="html" source={source} closed={closed} leaf={leaf} />
			{reason !== null && (
				<div className="omp-mermaid-note">
					<span>Page not shown: {reason.length > NOTE_CHARS ? `${reason.slice(0, NOTE_CHARS - 1)}…` : reason}</span>
				</div>
			)}
		</div>
	);
}

function DrawnPage({ source, frameUrl, leaf }: { source: string; frameUrl: string; leaf?: number }) {
	const theme = useHtmlPageTheme();
	const frame = useRef<HTMLIFrameElement>(null);
	const latest = useRef(theme);
	latest.current = theme;
	const [view, setView] = useState<View>(() => preferences.get(source) ?? "page");
	const [content, setContent] = useState(() => heights.get(source) ?? HTML_PAGE_INITIAL_HEIGHT);
	const [expanded, setExpanded] = useState(() => expansions.get(source) === true);
	const toggle = (next: boolean): void => {
		setExpanded(next);
		remember(expansions, source, next);
	};
	const [status, setStatus] = useState<"loading" | "ready" | "failed">("loading");
	const choose = (next: View): void => {
		setView(next);
		remember(preferences, source, next);
	};

	useEffect(() => holdHtmlPageFocusGuard(), []);
	useEffect(() => {
		if (view !== "page") return;
		setStatus("loading");
		const timer = window.setTimeout(() => setStatus(current => (current === "ready" ? current : "failed")), FRAME_TIMEOUT_MS);
		const onMessage = (event: MessageEvent): void => {
			// Only this block's own frame: a message from any other window, the host's included, is neither a report nor a request.
			const element = frame.current;
			if (element === null || event.source === null || event.source !== element.contentWindow) return;
			if (isHtmlPageReady(event.data)) {
				element.contentWindow?.postMessage(htmlPageMessage(source, latest.current), "*");
				window.clearTimeout(timer);
				setStatus("ready");
				return;
			}
			const next = parseHtmlPageSize(event.data);
			if (next === null) return;
			setContent(next);
			remember(heights, source, next);
		};
		window.addEventListener("message", onMessage);
		return () => {
			window.removeEventListener("message", onMessage);
			window.clearTimeout(timer);
		};
	}, [source, view]);
	// A change of theme reaches the running page by message; the page itself was sent once, in the theme of that moment.
	useEffect(() => {
		if (status === "ready") frame.current?.contentWindow?.postMessage(htmlPageThemeMessage(theme), "*");
	}, [theme, status]);

	if (status === "failed" && view === "page") return <CodeWithNote source={source} closed reason={FRAME_SILENT} leaf={leaf} />;
	const overflows = content > HTML_PAGE_MAX_HEIGHT;
	const open = expanded && overflows;
	return (
		<div className="omp-htmlpage">
			<div className="omp-htmlpage-head" role="toolbar" aria-label="Page view">
				<button type="button" className="omp-mermaid-tab" aria-pressed={view === "page"} onClick={() => choose("page")}>Page</button>
				<button type="button" className="omp-mermaid-tab" aria-pressed={view === "source"} onClick={() => choose("source")}>Source</button>
				<CopyButton text={source} label="Copy HTML source" className="omp-htmlpage-copy" />
			</div>
			{view === "page" ? (
				<iframe
					ref={frame}
					className={HTML_PAGE_FRAME_CLASS}
					title="HTML page"
					sandbox="allow-scripts"
					allow=""
					referrerPolicy="no-referrer"
					src={frameUrl}
					style={{ height: open ? content : Math.min(content, HTML_PAGE_MAX_HEIGHT) }}
				/>
			) : (
				<div className="omp-htmlpage-source">
					<CodeBlock language="html" source={source} closed copy={false} leaf={leaf} />
				</div>
			)}
			{view === "page" && overflows && (
				<button type="button" className="omp-htmlpage-more" aria-expanded={open} onClick={() => toggle(!open)}>
					{open ? "Show less" : "Show full page"}
				</button>
			)}
		</div>
	);
}

/**
 * Clickable file and folder references in the Chat.
 *
 * A reference stays ordinary text until the host proves the file or folder exists (the Terminal mode
 * validation, answered from the document's cache); then the very same characters are wrapped in a
 * link. Without a provider — a detail tab, a static render — nothing is wrapped, so the text, its
 * selection and its copy are the same either way. Opening goes through the host's Terminal mode
 * path, which re-resolves against the session cwd and refuses anything that is not an existing local file or folder.
 */
import type { MouseEvent, KeyboardEvent, ReactNode, RefObject } from "react";
import { createContext, useContext, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { GuestHostMessage, GuestWebviewMessage } from "../messages";
import { fileLinkMenuContext } from "../terminal-links";
import type { FileLinkAction } from "../terminal-links";
import { ChatFileLinks, detectChatFileLinks, isFileLinkCandidate } from "../lib/chat-file-links";
import { ChatSymbolLinks } from "../lib/chat-symbol-links";
import type { SymbolLink } from "../lib/chat-symbol-links";

/** Exported for static renders, which cannot run the provider's effect. */
export const FileLinksContext = createContext<ChatFileLinks | null>(null);
/** The document's code-symbol answers; present exactly when {@link FileLinksContext} is. */
export const SymbolLinksContext = createContext<ChatSymbolLinks | null>(null);
/** Whether code symbols below may be linked: only assistant reply text opts in; user text, tool output, notices and thinking never ask the host. */
export const SymbolLinksEligibleContext = createContext(false);

/** Gives every file reference and code symbol below it the document's validation cache; `cwd` is only a cache key — the host owns resolution. */
export function FileLinksProvider({ transport, cwd, children }: {
	transport: { post(message: GuestWebviewMessage): boolean; subscribe(listener: (message: GuestHostMessage) => void): () => void };
	cwd: string | undefined;
	children: ReactNode;
}): ReactNode {
	const [links, setLinks] = useState<{ files: ChatFileLinks; symbols: ChatSymbolLinks } | null>(null);
	useEffect(() => {
		const created = { files: new ChatFileLinks(transport), symbols: new ChatSymbolLinks(transport) };
		setLinks(created);
		return () => { created.files.dispose(); created.symbols.dispose(); };
	}, [transport, cwd]);
	return <FileLinksContext.Provider value={links?.files ?? null}><SymbolLinksContext.Provider value={links?.symbols ?? null}>{children}</SymbolLinksContext.Provider></FileLinksContext.Provider>;
}

/** How long a burst of text changes (a streaming reply) settles before the host is asked about it. */
const SETTLE_MS = 200;

/** Which of `targets` the host has proven to be files; unknown ones are asked for once the text settles. */
function useProvenTargets(links: ChatFileLinks | null, targets: readonly string[], revalidate: unknown): ReadonlySet<string> {
	const [, refresh] = useReducer((count: number) => count + 1, 0);
	const remembered = useRef<{ links: ChatFileLinks | null; valid: Map<string, boolean> }>({ links, valid: new Map() });
	if (remembered.current.links !== links) remembered.current = { links, valid: new Map() };
	const proven = new Set<string>();
	for (const target of targets) {
		const fresh = links?.peek(target);
		if (fresh !== undefined) remembered.current.valid.set(target, fresh);
		// A stale answer keeps its link while the host is asked again, so a repaint never flickers the text.
		if (remembered.current.valid.get(target) === true) proven.add(target);
	}
	const key = targets.join("\n");
	useEffect(() => {
		if (links === null) return;
		const missing = targets.filter(target => links.peek(target) === undefined);
		if (missing.length === 0) return;
		let live = true;
		const timer = setTimeout(() => {
			void Promise.all(missing.map(target => links.resolve(target).then(valid => { remembered.current.valid.set(target, valid); }))).then(() => { if (live) refresh(); });
		}, SETTLE_MS);
		return () => { live = false; clearTimeout(timer); };
	}, [links, key, revalidate]);
	return proven;
}

/**
 * Whether a click or key press on a Chat link should activate it. Either way it goes no further: a
 * link inside a disclosure header must not toggle it, and a key the link handles must not reach VS
 * Code's keybindings (Ctrl+Enter would also send the draft). A drag that selected text is a selection, not a click.
 */
export function claimLinkActivation(event: MouseEvent | KeyboardEvent): boolean {
	event.stopPropagation();
	if (event.type === "click" && (window.getSelection()?.toString() ?? "") !== "") return false;
	event.preventDefault();
	return true;
}

/** Ctrl+Click (or Ctrl+Enter) reveals the target in VS Code's Explorer instead of opening it; with Shift it shows the target in the system file manager. */
export function fileLinkAction(event: { ctrlKey: boolean; shiftKey: boolean }): FileLinkAction | undefined {
	return !event.ctrlKey ? undefined : event.shiftKey ? "os" : "reveal";
}

function Anchor({ links, target, children }: { links: ChatFileLinks; target: string; children: ReactNode }): ReactNode {
	return <span
		className="omp-file-link"
		role="link"
		tabIndex={0}
		data-file-target={target}
		data-vscode-context={fileLinkMenuContext(target)}
		title={`${target}\nOpen · Ctrl+Click to reveal in Explorer · Ctrl+Shift+Click to show in File Explorer`}
		// Shift+mousedown would extend the text selection, and the click then reads as a selection, not an activation.
		onMouseDown={event => { if (event.shiftKey) event.preventDefault(); }}
		onClick={event => { if (claimLinkActivation(event)) links.open(target, fileLinkAction(event)); }}
		onKeyDown={event => { if ((event.key === "Enter" || event.key === " ") && claimLinkActivation(event)) links.open(target, fileLinkAction(event)); }}
	>{children}</span>;
}

/**
 * A code symbol with several different definitions: the same look as a link, dotted, and a click (or Ctrl+Click, there
 * is no single file to reveal) opens VS Code's workspace symbol search for its name, where the user chooses. Never a guessed definition.
 */
function SymbolSearchAnchor({ links, symbol, definitions, children }: { links: ChatFileLinks; symbol: string; definitions: number; children: ReactNode }): ReactNode {
	return <span
		className="omp-symbol-search"
		role="link"
		tabIndex={0}
		data-symbol-search={symbol}
		title={`${definitions} definitions — click to choose`}
		onMouseDown={event => { if (event.shiftKey) event.preventDefault(); }}
		onClick={event => { if (claimLinkActivation(event)) links.openSymbolSearch(symbol); }}
		onKeyDown={event => { if ((event.key === "Enter" || event.key === " ") && claimLinkActivation(event)) links.openSymbolSearch(symbol); }}
	>{children}</span>;
}

/**
 * `children` as the link to one known file target once the host proves it; plain `children` before and otherwise.
 * `proof` is what the host is asked about when it differs from what a click opens (a file, not each of its lines).
 */
export function FileLink({ target, proof = target, children, revalidate }: { target: string; proof?: string; children: ReactNode; revalidate?: unknown }): ReactNode {
	const links = useContext(FileLinksContext);
	const proven = useProvenTargets(links, links === null ? [] : [proof], revalidate);
	return links !== null && proven.has(proof) ? <Anchor links={links} target={target}>{children}</Anchor> : <>{children}</>;
}

/** One piece of `text` to open as `target` once the host proves `proof`, instead of what detection would make of it. */
export interface ExplicitFileLink { readonly text: string; readonly target: string; readonly proof: string }

/**
 * `text` with every host-proven file reference in it wrapped in a link; the characters themselves are never altered.
 * `link` names one piece of the text that is a known file at a known position (a path whose first changed line is known).
 */
export function FileLinkText({ text, link, revalidate }: { text: string; link?: ExplicitFileLink; revalidate?: unknown }): ReactNode {
	const links = useContext(FileLinksContext);
	const candidates = useMemo(() => {
		if (links === null) return [];
		const found = detectChatFileLinks(text).map(candidate => ({ ...candidate, proof: candidate.target }));
		const at = link === undefined ? -1 : text.indexOf(link.text);
		if (link === undefined || at < 0) return found;
		const end = at + link.text.length;
		return [...found.filter(candidate => candidate.end <= at || candidate.start >= end), { target: link.target, proof: link.proof, start: at, end }].sort((a, b) => a.start - b.start);
	}, [links, text, link?.text, link?.target, link?.proof]);
	const proven = useProvenTargets(links, candidates.map(candidate => candidate.proof), revalidate);
	if (links === null || !candidates.some(candidate => proven.has(candidate.proof))) return text;
	const nodes: ReactNode[] = [];
	let cursor = 0;
	candidates.forEach((candidate, index) => {
		if (!proven.has(candidate.proof) || candidate.start < cursor) return;
		if (candidate.start > cursor) nodes.push(text.slice(cursor, candidate.start));
		nodes.push(<Anchor key={index} links={links} target={candidate.target}>{text.slice(candidate.start, candidate.end)}</Anchor>);
		cursor = candidate.end;
	});
	if (cursor < text.length) nodes.push(text.slice(cursor));
	return <>{nodes}</>;
}

/** Whether the element has been on screen once; always true where there is no `IntersectionObserver` (a static render). */
function useSeen(): [RefObject<HTMLElement | null>, boolean] {
	const ref = useRef<HTMLElement | null>(null);
	const [seen, setSeen] = useState(typeof IntersectionObserver === "undefined");
	useEffect(() => {
		const node = ref.current;
		if (seen || node === null) return;
		const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { setSeen(true); observer.disconnect(); } });
		observer.observe(node);
		return () => observer.disconnect();
	}, [seen]);
	return [ref, seen];
}

/**
 * The definition the host found for `token` once it is asked (after the text settles); `null` before and when there is none.
 * An answer is not polled: once it has expired the next render of the span asks again, and while it is being asked
 * the previous answer stays so a repaint never flickers the text. While the host has the feature off nothing is shown.
 */
function useSymbolLink(symbols: ChatSymbolLinks | null, token: string | null): SymbolLink | null {
	const [, refresh] = useReducer((count: number) => count + 1, 0);
	const remembered = useRef<{ symbols: ChatSymbolLinks | null; answers: Map<string, SymbolLink | null> }>({ symbols, answers: new Map() });
	if (remembered.current.symbols !== symbols) remembered.current = { symbols, answers: new Map() };
	const fresh = symbols === null || token === null ? undefined : symbols.peek(token);
	if (token !== null && fresh !== undefined) remembered.current.answers.set(token, fresh);
	const off = symbols?.disabled === true;
	// The client says that tokens it left unresolved may be asked again (the host's provider became ready or its queue
	// drained, or the page budget has room): a span still without an answer renders again, which runs the effect below.
	useEffect(() => {
		if (symbols === null || token === null) return;
		return symbols.subscribe(() => { if (symbols.peek(token) === undefined) refresh(); });
	}, [symbols, token]);
	// No dependency list: a token the client refused (its budget was full) is offered again on any later render of the
	// span, and a token that is known or off does nothing. The state is refreshed only once an answer is recorded, so
	// a refusal cannot make the span re-render itself in a loop.
	useEffect(() => {
		if (symbols === null || token === null || off || symbols.peek(token) !== undefined) return;
		// Only the timer is cancelled by a later render; an answer that arrives still refreshes the span (a dispatch after unmount is a no-op).
		const timer = setTimeout(() => {
			void symbols.resolve(token).then(link => {
				if (symbols.peek(token) === undefined) return;
				remembered.current.answers.set(token, link);
				refresh();
			});
		}, SETTLE_MS);
		return () => clearTimeout(timer);
	});
	return token === null || off ? null : fresh ?? remembered.current.answers.get(token) ?? null;
}

/**
 * One inline code span that may name a code symbol. `path` is the whole span when it also looks like a path:
 * the file proof comes first, and the symbol is asked about only once the host refuses that path (`A.B` looks like
 * a file with an extension). The span becomes a link to the file or to the symbol's definition once the host proves
 * it, and asks only once it has been on screen. The characters are the same either way.
 */
export function CodeSymbolSpan({ content, path }: { content: string; path: string | null }): ReactNode {
	const links = useContext(FileLinksContext);
	const eligible = useContext(SymbolLinksEligibleContext);
	const symbols = useContext(SymbolLinksContext);
	const proven = useProvenTargets(links, links === null || path === null ? [] : [path], undefined);
	const fileProven = path !== null && proven.has(path);
	const fileRefused = path === null || (links !== null && links.peek(path) === false);
	const [ref, seen] = useSeen();
	const symbol = useSymbolLink(eligible ? symbols : null, !fileProven && fileRefused && seen ? content : null);
	if (!fileProven && links !== null && symbol?.definitions !== undefined) {
		return <code ref={ref}><SymbolSearchAnchor links={links} symbol={content} definitions={symbol.definitions}>{content}</SymbolSearchAnchor></code>;
	}
	const target = fileProven ? path : symbol?.target;
	return <code ref={ref}>{links !== null && target !== undefined ? <Anchor links={links} target={target}>{content}</Anchor> : content}</code>;
}

/** The position a read call's displayed target carries (`src/a.ts:50-200`), for the link that opens at it. */
function displayedPosition(displayed: string): string {
	const selector = /:(L?\d+)(?:-L?\d+)?$/i.exec(displayed);
	return selector === null ? "" : `:${selector[1]!.replace(/^L/i, "")}`;
}

/**
 * A tool row's target text. A read's path becomes a link to that file at its line selector; an
 * edit's single path (not a rename `a → b`, not `N files`) links to the file at its first changed
 * line, however the result spells the path (absolute, relative, any drive-letter case). Anything
 * else links each reference the text names.
 */
export function ToolTargetText({ category, paths, text, line, revalidate }: { category: string; paths: readonly string[]; text: string; line?: number; revalidate?: unknown }): ReactNode {
	if (category === "read" && paths.length >= 1) return <FileLink target={`${paths[0]}${displayedPosition(text)}`} proof={paths[0]} revalidate={revalidate}>{text}</FileLink>;
	const single = category === "edit" && isFileLinkCandidate(text) && !text.includes("→") && !text.includes(", ") && !/^\d+ files?$/.test(text);
	if (single) return <FileLink target={line === undefined ? text : `${text}:${line}`} proof={text} revalidate={revalidate}>{text}</FileLink>;
	return category === "read" || category === "edit" ? <FileLinkText text={text} revalidate={revalidate} /> : text;
}

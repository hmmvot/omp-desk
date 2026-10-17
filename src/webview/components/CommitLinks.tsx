/**
 * Commit hashes in an assistant reply (`docs/designs/2026-10-17-commit-hash-links.md`). A 7 to 40 digit hash stays ordinary text
 * until the host proves that a commit with that hash exists in the repositories of the session's folder (the Chat file-link validation
 * exchange, target `commit://<hex>`); then the very same characters are wrapped in a link whose click shows the commit in Source Control.
 * Only the assistant's own reply text asks: user text, tool output, notices and thinking never do, and neither does a page without link context.
 */
import type { ReactNode } from "react";
import { useContext, useEffect, useReducer, useRef } from "react";
import type { ChatFileLinks } from "../lib/chat-file-links";
import { AssistantReplyContext, FileLinksContext, claimLinkActivation } from "./FileLinks";
import { breakable } from "./BreakPoints";

/** How long a burst of text changes (a streaming reply) settles before the host is asked about it. */
const SETTLE_MS = 200;

/**
 * The host's verdict on `target`: `undefined` until it is known, then whether a commit exists. An answer is not polled: once it
 * has expired the next render asks again, and meanwhile the previous verdict stays so a repaint never flickers the text.
 */
function useCommitVerdict(links: ChatFileLinks | null, target: string): boolean | undefined {
	const [, refresh] = useReducer((count: number) => count + 1, 0);
	const remembered = useRef<{ links: ChatFileLinks | null; target: string; verdict: boolean | undefined }>({ links, target, verdict: undefined });
	if (remembered.current.links !== links || remembered.current.target !== target) remembered.current = { links, target, verdict: undefined };
	const fresh = links?.peek(target);
	if (fresh !== undefined) remembered.current.verdict = fresh;
	// No dependency list: an expired answer is asked again on the next render; a known one does nothing, so an answer
	// that changes nothing cannot make the component render itself in a loop.
	useEffect(() => {
		if (links === null || links.peek(target) !== undefined) return;
		const timer = setTimeout(() => {
			void links.resolve(target).then(valid => {
				if (remembered.current.links !== links || remembered.current.target !== target) return;
				const changed = remembered.current.verdict !== valid;
				remembered.current.verdict = valid;
				if (changed) refresh();
			});
		}, SETTLE_MS);
		return () => clearTimeout(timer);
	});
	return remembered.current.verdict;
}

function CommitAnchor({ links, target, children }: { links: ChatFileLinks; target: string; children: ReactNode }): ReactNode {
	const hex = target.slice("commit://".length);
	return <span
		className="omp-file-link omp-commit-link"
		role="link"
		tabIndex={0}
		data-commit-target={target}
		title={`Commit ${hex}\nShow in Source Control`}
		onMouseDown={event => { if (event.shiftKey) event.preventDefault(); }}
		onClick={event => { if (claimLinkActivation(event)) links.open(target); }}
		onKeyDown={event => { if ((event.key === "Enter" || event.key === " ") && claimLinkActivation(event)) links.open(target); }}
	>{children}</span>;
}

/** `children` (a hash in prose) as the link to its commit once the host proves it exists; plain `children` before and otherwise. */
export function CommitLink({ target, children }: { target: string; children: ReactNode }): ReactNode {
	const links = useContext(FileLinksContext);
	const eligible = useContext(AssistantReplyContext);
	const verdict = useCommitVerdict(eligible ? links : null, target);
	return links !== null && eligible && verdict === true ? <CommitAnchor links={links} target={target}>{children}</CommitAnchor> : <>{children}</>;
}

/**
 * An inline code span that is one hash. It is asked about as a commit first, because a span such as `c7398070` also reads as a code
 * symbol: while the host has not answered the span is plain code, a commit makes it a link, and where there is none `plain` is what
 * the span would have been without this feature (the symbol and file lookups), so those lookups are never made for a real commit.
 */
export function CommitHashSpan({ target, content, plain }: { target: string; content: string; plain: ReactNode }): ReactNode {
	const links = useContext(FileLinksContext);
	const eligible = useContext(AssistantReplyContext);
	const verdict = useCommitVerdict(eligible ? links : null, target);
	if (links === null || !eligible) return plain;
	if (verdict === true) return <code><CommitAnchor links={links} target={target}>{breakable(content)}</CommitAnchor></code>;
	return verdict === undefined ? <code>{breakable(content)}</code> : plain;
}

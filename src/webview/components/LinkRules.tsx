/**
 * Text that one of the user's link rules matches (`ompDesk.chatLinkRules`, `docs/designs/2026-10-27-chat-link-rules.md`): the same characters in a
 * focusable `role="link"` span with the look of a web link, never an `<a href>`. A click or Enter asks the host to open it in an editor tab, Ctrl+Click or Ctrl+Enter in the external
 * browser, like every web link. The request carries the rule's position, the matched characters and that gesture, never a URL: the host runs the rule again and builds
 * the URL itself (`omp:terminal-link-open`, target `link-rule://<rule>/<text>`). The title shows the URL the host will build.
 * Only the assistant's own reply text is linked; user text, tool output, notices and thinking stay text, and so does a page without a link client.
 */
import type { ReactNode } from "react";
import { useContext } from "react";
import { linkRuleTarget, linkRuleTitle } from "../../shared/link-rules";
import type { LinkRuleMatch } from "../../shared/link-rules";
import { AssistantReplyContext, claimLinkActivation } from "./FileLinks";
import { WebLinksContext } from "./WebLinks";

/** `children` (the matched characters, or a code span holding them) as the link of `match`, with `text` the characters the rule matched. */
export function LinkRuleLink({ rule, text, url, children }: { rule: LinkRuleMatch["rule"]; text: string; url: string; children: ReactNode }): ReactNode {
	const client = useContext(WebLinksContext);
	const eligible = useContext(AssistantReplyContext);
	if (client === null || !eligible) return <>{children}</>;
	const target = linkRuleTarget(rule.id, text);
	return <span
		className="omp-web-link omp-rule-link"
		role="link"
		tabIndex={0}
		data-rule-target={target}
		title={linkRuleTitle(rule, url)}
		onClick={event => { if (claimLinkActivation(event)) client.openLinkRule(target, event.ctrlKey ? "external" : "editor"); }}
		onKeyDown={event => { if ((event.key === "Enter" || event.key === " ") && claimLinkActivation(event)) client.openLinkRule(target, event.ctrlKey ? "external" : "editor"); }}
	>{children}</span>;
}

/** An inline code span that is one rule match: the link around the code when the page links, `plain` (what the span is without rules) otherwise. */
export function LinkRuleSpan({ rule, text, url, content, plain }: { rule: LinkRuleMatch["rule"]; text: string; url: string; content: ReactNode; plain: ReactNode }): ReactNode {
	const client = useContext(WebLinksContext);
	const eligible = useContext(AssistantReplyContext);
	if (client === null || !eligible) return plain;
	return <LinkRuleLink rule={rule} text={text} url={url}><code>{content}</code></LinkRuleLink>;
}

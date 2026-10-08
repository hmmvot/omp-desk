/**
 * Clickable web links in the Chat and its detail tabs.
 *
 * A web link follows the file-link convention (./FileLinks.tsx): the same characters in a focusable
 * `role="link"` span, never an `<a href>`, so this document never navigates itself and VS Code's own
 * webview link handling never sees it. Activation posts the Terminal mode's open request
 * (`omp:terminal-link-open`) with the normalized `http(s)` URL and where it should open: a plain click
 * or Enter in an editor tab (Simple Browser), Ctrl+Click or Ctrl+Enter in the external browser. The host
 * re-validates the URL before it opens anything. Without a provider (a static render) the text stays text.
 */
import type { ReactNode } from "react";
import { createContext, useContext, useEffect, useState } from "react";
import type { GuestHostMessage, GuestWebviewMessage } from "../messages";
import { TerminalLinkClient } from "../lib/terminal-link-client";
import { WEB_LINK_HINT } from "../lib/chat-web-links";
import { claimLinkActivation } from "./FileLinks";

/** Exported for static renders, which cannot run the provider's effect. */
export const WebLinksContext = createContext<TerminalLinkClient | null>(null);

/** Gives every web link below it a way to ask the host to open it. */
export function WebLinksProvider({ transport, children }: {
	transport: { post(message: GuestWebviewMessage): boolean; subscribe(listener: (message: GuestHostMessage) => void): () => void };
	children: ReactNode;
}): ReactNode {
	const [client, setClient] = useState<TerminalLinkClient | null>(null);
	useEffect(() => {
		const created = new TerminalLinkClient(transport);
		setClient(created);
		return () => created.dispose();
	}, [transport]);
	return <WebLinksContext.Provider value={client}>{children}</WebLinksContext.Provider>;
}

/** `children` as the link to `url`, an `http(s)` URL already normalized by `webLinkUrl`. */
export function WebLink({ url, children }: { url: string; children: ReactNode }): ReactNode {
	const client = useContext(WebLinksContext);
	if (client === null) return <>{children}</>;
	return <span
		className="omp-web-link"
		role="link"
		tabIndex={0}
		data-web-url={url}
		title={`${url}\n${WEB_LINK_HINT}`}
		onClick={event => { if (claimLinkActivation(event)) client.open(url, event.ctrlKey ? "external" : "editor"); }}
		onKeyDown={event => { if ((event.key === "Enter" || event.key === " ") && claimLinkActivation(event)) client.open(url, event.ctrlKey ? "external" : "editor"); }}
	>{children}</span>;
}

/**
 * Chat page entry point.
 *
 * Runs inside the VS Code Webview produced by {@link createGuestHtml}. It installs the
 * document's own style policy (the nonce'd stylesheet), creates the chat client and attaches
 * it to the host transport, and only then announces the document and mounts the page: the
 * host answers the announcement with its `omp:chat-state` and `omp:chat-snapshot`, and the
 * client must already be listening when they arrive.
 */
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { guestTransport, readCspNonce } from "./bridge";
import { ChatClient } from "./lib/chat-client";
import { injectGuestStyles } from "./styles";
import { adoptNonceForCreatedStyles } from "./lib/nonce-styles";
import { attachSessionView, sessionViewSnapshot } from "./lib/session-view";
import { attachCodeTheme } from "./lib/code-theme-store";
import { attachKeyHints } from "./lib/key-hints-store";
import { attachLinkRules } from "./lib/link-rules-store";
import { attachMagicKeywordSettings } from "./lib/magic-keyword-settings";
import { attachInsertedText } from "./lib/insert-text";
import { restoreFocusTakenByHost } from "./lib/frame-focus";
import { installFocusTrace } from "./lib/focus-trace";
import { installTypeToFocus } from "./lib/type-to-focus";
import { installSelectionFocusHold } from "./lib/selection-focus";
import { installPageHealth } from "./lib/page-health";
import { installPageMotion } from "./lib/page-motion";
import { DETAIL_META } from "../protocol/detail-target";

function boot(): void {
	// A composer that loses focus without the user moving it is reported to the OMP Desk output, with what the page saw.
	installFocusTrace(window, element => element.classList.contains("omp-composer-input"), detail => guestTransport.post({ type: "omp:focus-trace", detail }));
	// VS Code focuses the webview again when its window gains focus, which empties the page's focus; put it back.
	restoreFocusTakenByHost(window);
	// Typing while the page has the keyboard focus but nothing editable does goes into the composer.
	installTypeToFocus(window);
	// A text selection holds the focus, so VS Code's Copy does not refocus the composer over it.
	installSelectionFocusHold(window);
	// The page's spinners, text sweep and progress bar move by custom properties written at a low rate, not by CSS animations that keep the browser drawing.
	installPageMotion(window);
	// A visible session page reports to the host that it is alive, so a page whose main thread freezes leaves a trace in the log. A detail
	// tab is not a session editor and has no slot to be watched under. A diagnostic never stops the page from mounting.
	if (document.querySelector(`meta[name="${DETAIL_META}"]`) === null) {
		try {
			installPageHealth(window, guestTransport);
		} catch {
			// The page works without its liveness report.
		}
	}
	const nonce = readCspNonce();
	adoptNonceForCreatedStyles(nonce);
	injectGuestStyles(nonce);
	const client = new ChatClient(guestTransport);
	client.attach(guestTransport);
	attachSessionView(guestTransport);
	attachCodeTheme(guestTransport);
	attachKeyHints(guestTransport);
	// The user's link rules (`ompDesk.chatLinkRules`): drawn as links in assistant text.
	attachLinkRules(guestTransport);
	// Which magic keywords OMP acts on: the host answers a question the page asks when a keyword is on screen.
	attachMagicKeywordSettings(guestTransport);
	// `omp:insert-text` (an editor reference) is attached here, not in a React effect: the host posts it as
	// soon as it has seen the announcement below, which can be before the page has mounted.
	attachInsertedText(guestTransport, () => sessionViewSnapshot().mode);
	// Announce the document, including its bridge ticket and Origin when it has one:
	// the host pins the Origin from this report and from nothing else.
	guestTransport.announce();
	const container = document.getElementById("root");
	if (container === null) throw new Error("chat page container element is missing");
	createRoot(container).render(<App client={client} />);
}

boot();

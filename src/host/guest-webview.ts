/**
 * Host-side factory for the documents one OMP editor can show.
 *
 * An editor is restored across a restart by VS Code only when it carries state
 * its own document persisted (see `src/webview/panel-identity.ts`), so every
 * document here stamps the same non-secret tab identity into a meta tag — the
 * chat page reads it with the bundle, and the explanation document's nonce-gated
 * inline script persists it directly:
 *
 * - {@link createGuestHtml} is the chat page: exactly one script (the esbuild
 *   bundle at `media/guest.js`), one CSP nonce, and a `connect-src` naming this
 *   document's own bridge listener and nothing else — or `'none'` when the
 *   document has no bridge. The chat's data arrives over the VS Code message
 *   channel (and, after an extension-host restart, that bridge), never over a
 *   network origin the page chose. `default-src 'none'` blocks everything not
 *   named here, so the panel cannot reach a CDN, another loopback port, or
 *   any third-party origin even if its code tried. Scripts and stylesheets are
 *   limited to the extension's own resource origin and the nonce. Style attributes
 *   are allowed for xterm's ANSI colors and cell geometry.
 * - {@link createUnavailableGuestHtml} is the bounded explanation a panel shows
 *   when the extension cannot hand it a chat page. It grants no network
 *   permission at all.
 */
import { randomBytes } from "node:crypto";
import type * as vscode from "vscode";
import { PANEL_BRIDGE_META, PANEL_IDENTITY_META, isPanelTabId, panelBridgeMetaValue, panelDocumentIdentityBootstrapSource } from "../webview/panel-identity.ts";
import { SHELL_SLOT_META, isShellSlotId } from "../webview/panel-identity.ts";
import { DETAIL_META, detailMetaValue, type DetailTarget } from "../webview/detail-target.ts";


/**
 * Escape text placed in an element's body.
 *
 * The explanations are fixed text this extension writes, and the reason may quote
 * a launcher detail; escaping it keeps a session title or a path from becoming
 * markup in a document that has no scripts to defend itself with.
 */
function escapeText(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * The identity meta tag, or nothing when the document has no session identity.
 *
 * The id itself is interpolated unescaped because only the shape this contract
 * mints — `tab:<uuid>` — is stamped at all, so the attribute cannot be closed
 * early. An id of any other shape is simply not stamped, and an unstamped
 * document persists nothing.
 */
function identityMeta(tabId: string | undefined): string {
	if (tabId === undefined || !isPanelTabId(tabId)) return "";
	return `\t\t<meta name="${PANEL_IDENTITY_META}" content="${tabId}" />\n`;
}

/**
 * The bridge ticket meta tag, or nothing when this document has no bridge.
 *
 * The value is minted by this host and carries no secret; the page reports it back
 * over the panel route, which is what lets the host attribute an Origin report to
 * the exact document it created.
 */
function bridgeMeta(bridge: GuestBridgeTicket | null): string {
	if (bridge === null) return "";
	return `\t\t<meta name="${PANEL_BRIDGE_META}" content="${panelBridgeMetaValue(bridge)}" />\n`;
}

/**
 * The bridge facts one document is rendered with.
 *
 * All four are host-minted identities, none is a credential: the editor id, the
 * document incarnation, the bootstrap correlation id and the loopback port. They
 * exist so the page can report its own ticket and Origin over the panel route —
 * the only channel that may teach the host an Origin — and so its `connect-src`
 * names the one listener it may reach.
 */
export interface GuestBridgeTicket {
	readonly editorId: string;
	readonly documentId: string;
	readonly bootstrapId: string;
	readonly port: number;
}

/**
 * The document policy every guest document shares: nothing is allowed unless named, scripts and
 * stylesheets come only from the extension's own resource origin and this document's nonce, and
 * style attributes are allowed for xterm's ANSI colors and cell geometry.
 */
function guestCsp(webview: vscode.Webview, nonce: string, connectSrc: string): string {
	return [
		"default-src 'none'",
		"base-uri 'none'",
		"form-action 'none'",
		`img-src ${webview.cspSource} data:`,
		`font-src ${webview.cspSource}`,
		`style-src 'nonce-${nonce}' ${webview.cspSource}`,
		"style-src-attr 'unsafe-inline'",
		`script-src 'nonce-${nonce}' ${webview.cspSource}`,
		`connect-src ${connectSrc}`,
	].join("; ");
}

/** Native settings are message-only pages: no bridge listener or network capability. */
export function createSettingsHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
	const nonce = randomBytes(16).toString("base64url");
	const root = extensionUri.path.replace(/\/$/, "");
	const script = webview.asWebviewUri(extensionUri.with({ path: `${root}/media/settings.js` }));
	return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${guestCsp(webview, nonce, "'none'")}">
<meta name="csp-nonce" content="${nonce}"><title>OMP Settings</title></head>
<body><div id="root"></div><script nonce="${nonce}" src="${script}"></script></body></html>`;
}

/**
 * Build the chat page document.
 *
 * @param webview the panel's webview (supplies `cspSource` and asset URIs)
 * @param extensionUri extension root; the bundle is expected at `media/guest.js`
 * @param tabId the tab this editor belongs to; it is stamped only when it is an
 *   id this contract accepts, and only then does the bundle persist it so VS Code
 *   can restore the editor.
 * @param bridge this document's listener, or `null` for a panel with no bridge —
 *   in which case the document may connect to nothing at all (`connect-src 'none'`).
 */
export function createGuestHtml(
	webview: vscode.Webview,
	extensionUri: vscode.Uri,
	tabId: string,
	bridge: GuestBridgeTicket | null,
	mode: "chat" | "terminal" = "chat",
): string {
	const nonce = randomBytes(16).toString("base64url");
	// Derive the asset URI from the passed Uri instance rather than the `vscode`
	// module: this file then has no runtime dependency on the extension host API.
	const mediaRoot = extensionUri.path.endsWith("/") ? extensionUri.path.slice(0, -1) : extensionUri.path;
	const scriptUri = webview.asWebviewUri(extensionUri.with({ path: `${mediaRoot}/media/guest.js` }));
	const iconsUri = webview.asWebviewUri(extensionUri.with({ path: `${mediaRoot}/media/codicons/codicon.css` }));
	// `connect-src` names the document's own bridge listener — the `http:` form (for a
	// `fetch`) and the `ws:` form (for the WebSocket the bridge uses) — and nothing
	// else, so a page cannot be talked into connecting to another loopback service even
	// if its own code tried. A document without a bridge may connect to nothing.
	const connectSrc =
		bridge === null ? "'none'" : `http://127.0.0.1:${bridge.port} ws://127.0.0.1:${bridge.port}`;
	const csp = guestCsp(webview, nonce, connectSrc);

	return `<!DOCTYPE html>
<html lang="en">
	<head>
		<meta charset="UTF-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1.0" />
		<meta http-equiv="Content-Security-Policy" content="${csp}" />
${identityMeta(tabId)}${bridgeMeta(bridge)}\t\t<meta name="omp-session-mode" content="${mode}" />
		<title>OMP session</title>
		<link rel="stylesheet" href="${iconsUri.toString()}" />
	</head>
	<body>
		<div id="root"></div>
		<script nonce="${nonce}" src="${scriptUri.toString()}"></script>
	</body>
</html>
`;
}

/**
 * Build the document of a detail tab (the whole TODO, the agent roster or one agent).
 *
 * The same bundle and policy as the chat page, with three deliberate differences: `connect-src` is
 * always `'none'` (a detail tab has no bridge, ticket or port; its data arrives over the panel's
 * own message channel), no identity meta is stamped (so the page persists no state and VS Code has
 * nothing to restore), and `omp-detail` names what the page shows.
 */
export function createDetailHtml(webview: vscode.Webview, extensionUri: vscode.Uri, target: DetailTarget): string {
	const nonce = randomBytes(16).toString("base64url");
	const mediaRoot = extensionUri.path.endsWith("/") ? extensionUri.path.slice(0, -1) : extensionUri.path;
	const scriptUri = webview.asWebviewUri(extensionUri.with({ path: `${mediaRoot}/media/guest.js` }));
	const iconsUri = webview.asWebviewUri(extensionUri.with({ path: `${mediaRoot}/media/codicons/codicon.css` }));
	return `<!DOCTYPE html>
<html lang="en">
	<head>
		<meta charset="UTF-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1.0" />
		<meta http-equiv="Content-Security-Policy" content="${guestCsp(webview, nonce, "'none'")}" />
		<meta name="${DETAIL_META}" content="${detailMetaValue(target)}" />
		<title>OMP detail</title>
		<link rel="stylesheet" href="${iconsUri.toString()}" />
	</head>
	<body>
		<div id="root"></div>
		<script nonce="${nonce}" src="${scriptUri.toString()}"></script>
	</body>
</html>
`;
}

/**
 * The identity a fallback document must persist for the editor it is showing.
 *
 * `editorId` is the actual editor id (`E`) of an editor of a dynamic view type —
 * the same value its viewType names and the guest document would persist — or
 * `null` for an editor of the legacy static view type, which has no editor id and
 * keeps the version-1 chat identity.
 */
export interface GuestFallbackIdentity {
	readonly tabId: string;
	readonly editorId: string | null;
}

/**
 * Build the document a panel shows when it has no session to connect to.
 *
 * This is deliberately not the chat page: it loads no asset and grants no
 * `connect-src`, so a panel that could not be given a chat page cannot reach the
 * network at all — it explains the state and keeps its editor restorable.
 *
 * The editor is *kept* rather than disposed because VS Code has already restored
 * it for the user; the panel says what is missing and how to try again, which is
 * the honest form of "not available yet".
 *
 * @param detail the bounded reason, written by this extension (never guest text)
 * @param identity the identity this editor's document must persist; omitted for an
 *   editor whose session could not be identified, which consequently persists
 *   nothing and is not restored again.
 */
export function createUnavailableGuestHtml(detail: string, identity?: GuestFallbackIdentity): string {
	const nonce = randomBytes(16).toString("base64url");
	// The bootstrap saves the *same* identity the guest document would: version 2 with
	// the actual editor id for an editor of a dynamic view type, version 1 for the
	// legacy static type. Anything this contract refuses generates neither a bootstrap
	// nor a meta tag: such an editor persists nothing and is simply not restored again.
	const bootstrap =
		identity === undefined ? null : panelDocumentIdentityBootstrapSource(identity.tabId, identity.editorId);
	const identified = identity === undefined || bootstrap === null ? undefined : identity.tabId;
	const csp = ["default-src 'none'", "base-uri 'none'", "form-action 'none'", `style-src 'nonce-${nonce}'`, `script-src 'nonce-${nonce}'`].join(
		"; ",
	);
	// The bootstrap is the only script this document may run: it persists this
	// editor's identity so a restart still has an editor to restore. With no usable id
	// the CSP permits no script at all.
	const script = bootstrap === null ? "" : `\t\t<script nonce="${nonce}">${bootstrap}</script>\n`;

	return `<!DOCTYPE html>
<html lang="en">
	<head>
		<meta charset="UTF-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1.0" />
		<meta http-equiv="Content-Security-Policy" content="${csp}" />
${identityMeta(identified)}\t\t<title>OMP session</title>
		<style nonce="${nonce}">
			body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 1.25rem; line-height: 1.5; }
			h1 { font-size: 1rem; margin: 0 0 0.5rem; }
			p { margin: 0 0 0.75rem; max-width: 40rem; }
			.reason { color: var(--vscode-descriptionForeground); }
		</style>
	</head>
	<body>
		<h1>OMP session</h1>
		<p class="reason">${escapeText(detail)}</p>
		<p>
			This editor is kept rather than closed. The OMP output channel records what is missing. If this condition
			persists, use the session's row in the OMP launcher to reopen the session without discarding this tab.
		</p>
${script}\t</body>
</html>
`;
}

/**
 * Build the document a folder-shell editor shows.
 *
 * A shell is deliberately *not* the chat page: it has no bridge and no
 * `connect-src` at all, because its terminal is a plain shell PTY the extension
 * host relays over the panel message channel. A page whose host is gone renders
 * the last screen it received and reports that the extension host is not
 * answering, which is why it needs no socket of its own — the folder's Reconnect
 * action re-binds the same broker from the host side.
 *
 * The identity is a distinct kind (`shell:<uuid>`, stamped in the shell's own meta
 * tag) and carries no secret: it names the durable recoverable shell slot, so a
 * recreated or restored editor can be matched to the exact broker generation it
 * shows without the chat readers ever mistaking it for a session tab.
 *
 * @param webview the panel's webview (supplies `cspSource` and asset URIs)
 * @param extensionUri extension root; the shell bundle is expected at `media/shell.js`
 * @param slotId the durable shell slot this editor shows; stamped only when it is
 *   the exact shape this contract accepts, so a malformed id persists nothing and
 *   is simply not restored again.
 */
export function createShellHtml(webview: vscode.Webview, extensionUri: vscode.Uri, slotId: string): string {
	const nonce = randomBytes(16).toString("base64url");
	const mediaRoot = extensionUri.path.endsWith("/") ? extensionUri.path.slice(0, -1) : extensionUri.path;
	const scriptUri = webview.asWebviewUri(extensionUri.with({ path: `${mediaRoot}/media/shell.js` }));
	const iconsUri = webview.asWebviewUri(extensionUri.with({ path: `${mediaRoot}/media/codicons/codicon.css` }));
	const identified = isShellSlotId(slotId);
	// Same policy as `guestCsp`, written out: stylesheets stay nonce/resource-gated and only
	// style attributes are inline-enabled (xterm's DOM renderer sets ANSI colors and cell
	// geometry through them). Scripts and network access stay locked down.
	const csp = [
		"default-src 'none'",
		"base-uri 'none'",
		"form-action 'none'",
		`img-src ${webview.cspSource} data:`,
		`font-src ${webview.cspSource}`,
		`style-src 'nonce-${nonce}' ${webview.cspSource}`,
		"style-src-attr 'unsafe-inline'",
		`script-src 'nonce-${nonce}' ${webview.cspSource}`,
		"connect-src 'none'",
	].join("; ");
	const slotMeta = identified ? `\t\t<meta name="${SHELL_SLOT_META}" content="${slotId}" />\n` : "";

	return `<!DOCTYPE html>
<html lang="en">
	<head>
		<meta charset="UTF-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1.0" />
		<meta http-equiv="Content-Security-Policy" content="${csp}" />
${slotMeta}\t\t<title>OMP terminal</title>
		<link rel="stylesheet" href="${iconsUri.toString()}" />
	</head>
	<body>
		<div id="root"></div>
		<script nonce="${nonce}" src="${scriptUri.toString()}"></script>
	</body>
</html>
`;
}

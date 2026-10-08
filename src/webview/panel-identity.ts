/**
 * The one identity an OMP chat editor persists, so VS Code can restore it.
 *
 * An editor is restored across a full restart only when two things exist: a
 * `WebviewPanelSerializer` registered for the panel's view type, and state the
 * panel's own document saved through `acquireVsCodeApi().setState()`. This module
 * is that state's entire contract, shared by the two sides that must agree on it:
 *
 * - the extension host stamps a validated tab id into the panel document
 *   (`src/host/guest-webview.ts`) and validates the state VS Code hands back
 *   (`src/extension.ts`);
 * - the guest bootstrap persists it — the bundle through `setState`
 *   (`src/webview/bridge.ts`), and a document without the bundle through the
 *   inline source this module generates, so a loading or failure panel keeps its
 *   editor restorable too.
 *
 * Which identity an editor saves is decided by the editor, not by the document that
 * happens to be showing: an editor of a dynamic view type saves the version-2 state
 * carrying its actual editor id (`panelIdentityForEditor`), and one of the legacy
 * static type saves the version-1 tab identity (`panelIdentityFor`). A document built
 * for the wrong kind would leave its editor unidentified at the next restart, so both
 * constructors are used by the bundle and by the generated bootstrap alike.
 *
 * It deliberately carries no capability and no session facts: no host-control
 * key, no token, no session file, no transcript and no connection
 * status. The tab id is the launcher's own opaque editor identity — the value a
 * sidebar row already displays — so persisting it grants nothing.
 */

/** Version of the persisted identity. A state that is not exactly this is refused. */
export const PANEL_IDENTITY_VERSION = 1;

/**
 * Meta tag the extension stamps the tab id into. It is the only place the guest
 * bootstrap reads an identity from, and a document without it persists nothing.
 */
export const PANEL_IDENTITY_META = "omp-tab-id";

/**
 * Meta tag a bridge-capable document carries: the editor, the document
 * incarnation and the loopback port this page belongs to.
 *
 * It is *not* a credential — no secret, no link, no native key — and it holds
 * nothing that is not already true of the document that carries it. It exists so a
 * page can report its own ticket and Origin to the host before any other channel
 * exists (an inline script never runs in the installed Webview, and a
 * `postMessage` needs a ticket the host can attribute). The value is
 * `<editorId>.<documentId>.<bootstrapId>.<port>`, all minted by the host.
 */
export const PANEL_BRIDGE_META = "omp-bridge";

/** The bridge facts one document carries, or `null` when it carries none. */
export interface PanelBridgeTicket {
	/** Actual editor id (`E`), 32 lowercase hex. */
	readonly editorId: string;
	/** HTML document incarnation (`D`), 32 lowercase hex. */
	readonly documentId: string;
	/** Bootstrap correlation id, 32 lowercase hex. */
	readonly bootstrapId: string;
	/** The exact loopback port this document's listener is bound to. */
	readonly port: number;
}

const BRIDGE_TOKEN = /^[0-9a-f]{32}$/;

/**
 * Parse one `omp-bridge` meta value.
 *
 * Every field is validated: a document whose tag is malformed reports no ticket at
 * all rather than a partial one, because the host pins an Origin only for a ticket
 * it can match against the document it actually created.
 */
export function parsePanelBridgeTicket(value: unknown): PanelBridgeTicket | null {
	if (typeof value !== "string") return null;
	const parts = value.split(".");
	if (parts.length !== 4) return null;
	const [editorId, documentId, bootstrapId, port] = parts;
	if (editorId === undefined || documentId === undefined || bootstrapId === undefined || port === undefined) return null;
	if (!BRIDGE_TOKEN.test(editorId) || !BRIDGE_TOKEN.test(documentId) || !BRIDGE_TOKEN.test(bootstrapId)) return null;
	if (!/^[1-9][0-9]{0,4}$/.test(port)) return null;
	const parsed = Number.parseInt(port, 10);
	if (parsed <= 0 || parsed > 65535) return null;
	return { editorId, documentId, bootstrapId, port: parsed };
}

/** The meta value for one ticket; the host writes this and nothing else does. */
export function panelBridgeMetaValue(ticket: {
	readonly editorId: string;
	readonly documentId: string;
	readonly bootstrapId: string;
	readonly port: number;
}): string {
	if (!BRIDGE_TOKEN.test(ticket.editorId) || !BRIDGE_TOKEN.test(ticket.documentId) || !BRIDGE_TOKEN.test(ticket.bootstrapId)) {
		throw new TypeError("a bridge ticket carries three 32-hex ids");
	}
	if (!Number.isInteger(ticket.port) || ticket.port <= 0 || ticket.port > 65535) throw new TypeError("a bridge ticket carries a legal TCP port");
	return `${ticket.editorId}.${ticket.documentId}.${ticket.bootstrapId}.${ticket.port}`;
}

/**
 * Stable launcher identity of one OMP editor tab: `SessionIndex` mints
 * `tab:<uuid>` (`src/host/session-index.ts`).
 *
 * Only that exact grammar is accepted here. The value crosses back into the
 * extension host as deserialized state — an input this window did not write in
 * this process — so anything longer, shorter or differently shaped is refused
 * instead of being carried into an index lookup, a document or a message. The
 * caller still resolves an accepted id against the live index: a well-formed id
 * for a row this window no longer has is stale, not a match.
 */
const TAB_ID = /^tab:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What one panel's document persists for its editor. */
export interface PersistedPanelIdentity {
	readonly version: number;
	/** The launcher tab this editor belongs to; an identity, never a capability. */
	readonly tabId: string;
	/**
	 * The actual editor id (`E`), 32 lowercase hex, on a version-2 state.
	 *
	 * `E` is what makes one VS Code editor distinguishable from another editor of
	 * the same tab, which is what a host-only restart needs: the surviving page and
	 * the saved editor must agree about *which* editor this is before a saved
	 * callback may be treated as its revival.
	 */
	readonly editorId?: string;
}

/** True for a tab id this contract accepts. */
export function isPanelTabId(value: unknown): value is string {
	return typeof value === "string" && TAB_ID.test(value);
}

/** Version 2 adds the actual editor id to the persisted identity. */
export const PANEL_IDENTITY_VERSION_EDITOR = 2;

/**
 * The state one bridge-capable panel persists: `{version:2, tabId, editorId}`.
 *
 * Still identity-only: no link, no secret, no native key, no connection state.
 * `editorId` is a random id this profile minted for one editor, so persisting it
 * grants nothing a tab id does not already grant.
 */
export function panelIdentityForEditor(tabId: unknown, editorId: unknown): PersistedPanelIdentity | null {
	if (!isPanelTabId(tabId)) return null;
	if (typeof editorId !== "string" || !/^[0-9a-f]{32}$/.test(editorId)) return null;
	return { version: PANEL_IDENTITY_VERSION_EDITOR, tabId, editorId };
}

/**
 * The editor id in state VS Code deserialized, or `null` when that state is not a
 * version-2 identity of this contract. A malformed, foreign or older value is
 * refused rather than upgraded: the caller treats a version-1 state as the legacy
 * migration case and anything else as unidentified.
 */
export function persistedPanelEditorId(state: unknown): string | null {
	if (typeof state !== "object" || state === null || Array.isArray(state)) return null;
	const candidate = state as { readonly version?: unknown; readonly tabId?: unknown; readonly editorId?: unknown };
	if (candidate.version !== PANEL_IDENTITY_VERSION_EDITOR) return null;
	if (!isPanelTabId(candidate.tabId)) return null;
	return typeof candidate.editorId === "string" && /^[0-9a-f]{32}$/.test(candidate.editorId) ? candidate.editorId : null;
}

/**
 * The state to persist for `tabId`, or `null` when `tabId` is not one this
 * contract accepts.
 *
 * A fresh object with exactly these two fields is constructed, never a caller's
 * own: nothing a caller happens to hold — a link, a key, a connection object —
 * can travel into webview state through this path.
 */
export function panelIdentityFor(tabId: unknown): PersistedPanelIdentity | null {
	return isPanelTabId(tabId) ? { version: PANEL_IDENTITY_VERSION, tabId } : null;
}

/**
 * The tab id in state VS Code deserialized, or `null` when that state is not this
 * contract's — a different version, a malformed value, a string, or nothing.
 *
 * Deserialized state is untrusted: VS Code persists whatever a document set, in
 * whatever build that document came from, and hands it back untouched. Only the
 * exact shape is accepted here, and a `null` result is what makes the caller show
 * a bounded explanation instead of guessing a session.
 */
export function persistedTabId(state: unknown): string | null {
	if (typeof state !== "object" || state === null || Array.isArray(state)) return null;
	const candidate = state as { readonly version?: unknown; readonly tabId?: unknown };
	if (candidate.version !== PANEL_IDENTITY_VERSION) return null;
	return isPanelTabId(candidate.tabId) ? candidate.tabId : null;
}

/**
 * The persisted state as JSON text, or `null` when `tabId` is not one this
 * contract accepts.
 *
 * `JSON.stringify` of the two validated fields cannot carry anything else, and
 * the HTML-significant characters are escaped even though a minted tab id
 * contains none, so the text is safe to splice into a document's inline script.
 */
export function panelIdentityLiteral(tabId: unknown): string | null {
	return identityLiteral(panelIdentityFor(tabId));
}

/** One identity, as the JSON text a document may inline. */
function identityLiteral(identity: PersistedPanelIdentity | PersistedShellIdentity | null): string | null {
	if (identity === null) return null;
	return JSON.stringify(identity)
		.replace(/</g, "\\u003c")
		.replace(/>/g, "\\u003e")
		.replace(/&/g, "\\u0026");
}

/**
 * Meta tag the extension stamps a folder shell's slot id into.
 *
 * A folder shell is not a session editor: it has no launcher tab and no session
 * identity, so it persists the slot the extension host minted for it and nothing
 * else. The tag is the host's (`src/host/guest-webview.ts` writes it) and this
 * module is where its value is accepted, persisted and read back.
 */
export const SHELL_SLOT_META = "omp-shell-slot";

/**
 * Stable identity of one folder-shell editor: `shell:<uuid>`.
 *
 * The extension host mints it and resolves it against its own shell records, so
 * only this exact grammar is accepted: a restored state is an input this window did
 * not write in this process.
 */
const SHELL_SLOT = /^shell:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Version 3 is the folder shell's identity, which carries no tab and no editor id. */
export const PANEL_IDENTITY_VERSION_SHELL = 3;

/** True for a shell slot id this contract accepts. */
export function isShellSlotId(value: unknown): value is string {
	return typeof value === "string" && SHELL_SLOT.test(value);
}

/** What one folder shell's document persists. Identity only, like the chat's state. */
export interface PersistedShellIdentity {
	readonly version: number;
	/** The slot the extension host minted for this shell editor. */
	readonly slotId: string;
}

/**
 * The state a folder-shell document persists: `{version:3, slotId}`.
 *
 * A fresh object with exactly these two fields is constructed, so nothing the
 * caller holds can travel into webview state through this path.
 */
export function shellIdentityFor(slotId: unknown): PersistedShellIdentity | null {
	return isShellSlotId(slotId) ? { version: PANEL_IDENTITY_VERSION_SHELL, slotId } : null;
}

/**
 * The shell slot in state VS Code deserialized, or `null` when that state is not
 * this contract's. A version-1 or version-2 chat identity is refused rather than
 * read: it describes a different kind of editor.
 */
export function persistedShellSlotId(state: unknown): string | null {
	if (typeof state !== "object" || state === null || Array.isArray(state)) return null;
	const candidate = state as { readonly version?: unknown; readonly slotId?: unknown };
	if (candidate.version !== PANEL_IDENTITY_VERSION_SHELL) return null;
	return isShellSlotId(candidate.slotId) ? candidate.slotId : null;
}

/** The shell identity as JSON text, or `null` for a slot id this contract refuses. */
export function shellIdentityLiteral(slotId: unknown): string | null {
	return identityLiteral(shellIdentityFor(slotId));
}

/**
 * The inline bootstrap a shell document without the bundle runs to persist its
 * identity — the same object, written the same way, as the bundle itself.
 *
 * @returns the script body, or `null` for a slot id this contract refuses.
 */
export function shellIdentityBootstrapSource(slotId: unknown): string | null {
	return identityBootstrapScript(shellIdentityLiteral(slotId));
}

/**
 * The inline bootstrap a document without the guest bundle runs to persist its
 * editor's identity — the same objects, written the same way, as the bundle
 * itself (`src/webview/bridge.ts` picks between the same two constructors).
 *
 * The document names the same identity the guest would, because a mismatch is not
 * a cosmetic difference: VS Code hands the state back to the serializer whose
 * viewType names that editor, and a state that does not carry the editor id can
 * leave a restored editor unidentified at the next restart. `editorId` is the
 * editor's own id (`E`) for an editor of a dynamic view type — the value the
 * viewType names and the one the guest bundle persists — and `null` only for the
 * legacy static view type, which has no editor id and keeps the version-1 chat
 * identity.
 *
 * A failure or loading panel still owns an editor VS Code may restore, so its
 * identity must be saved before that document is replaced or the app closes. The
 * script is nonce-gated by the caller's CSP, tolerates a missing or hostile
 * injected API, and persists nothing when an id is not this contract's.
 *
 * @returns the script body, or `null` when the id (or pair) is not one this
 *   contract accepts — in which case the document persists nothing.
 */
export function panelDocumentIdentityBootstrapSource(tabId: unknown, editorId: unknown): string | null {
	return identityBootstrapScript(identityLiteral(editorId === null ? panelIdentityFor(tabId) : panelIdentityForEditor(tabId, editorId)));
}

/** The one bootstrap body both identities share; only the literal differs. */
function identityBootstrapScript(literal: string | null): string | null {
	if (literal === null) return null;
	return (
		"(function(){" +
		'var factory=typeof acquireVsCodeApi==="function"?acquireVsCodeApi:null;' +
		"if(factory===null)return;" +
		"try{" +
		"var api=Reflect.apply(factory,window,[]);" +
		'if(api&&typeof api.setState==="function")api.setState(' +
		literal +
		");" +
		"}catch(error){}" +
		"})();"
	);
}

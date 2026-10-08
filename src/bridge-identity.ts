/**
 * Editor and document identity for the reconnecting host bridge (ADR-0023).
 *
 * Three identifiers, deliberately not interchangeable:
 *
 * - `T` is the indexed tab id (`tab:<uuid>`). It survives every reload and is
 *   what the session index, the claims and the Sessions rows key on.
 * - `E` is one **actual editor**: a fresh random 128-bit id minted when this
 *   extension creates (or migrates onto) a panel. It is embedded in the panel's
 *   viewType and persisted in Webview state, so VS Code's own serializer
 *   re-creates *that* editor for *that* id. Two windows showing one `T` have
 *   different `E`s, which is what makes a close attributable to one editor.
 * - `D` is one **HTML document incarnation**: a fresh random 128-bit id every
 *   time `webview.html` is assigned. A host-only restart keeps the same page and
 *   therefore the same `D`; a reload, a migration or any HTML replacement mints
 *   a new one and retires the previous credential.
 *
 * The viewType carries `T` and `E` in a form VS Code will accept and echo back
 * through `TabInputWebview.viewType`. The installed workbench (verified against
 * 1.139.1) prefixes every webview tab input with `mainThreadWebview-`, so a
 * registered *external* type must be recovered by stripping that prefix — and a
 * type that does not carry our own namespace is refused rather than interpreted.
 */
import { persistedTabId } from "./webview/panel-identity.ts";

/** Namespace and version of the bridge panel viewType. */
export const BRIDGE_VIEW_TYPE_NAMESPACE = "omp.session.b";
export const BRIDGE_VIEW_TYPE_VERSION = 2;

/** The prefix the installed workbench adds to a webview tab input's viewType. */
export const TAB_INPUT_VIEW_TYPE_PREFIX = "mainThreadWebview-";

/** The legacy generic type: it cannot gain a new viewType in place. */
export const LEGACY_VIEW_TYPE = "omp.session";

const TOKEN_RE = /^[0-9a-f]{32}$/;
const TAB_ID_RE = /^tab:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** `true` when `value` is exactly the canonical tab id shape the index mints. */
export function isBridgeTabId(value: unknown): value is string {
	return typeof value === "string" && TAB_ID_RE.test(value);
}

/** `true` for one canonical 32-hex id of this bridge (`E` or `D`). */
export function isBridgeEditorId(value: unknown): value is string {
	return typeof value === "string" && TOKEN_RE.test(value);
}

/**
 * The shape of the canonical Origin an installed Webview reports.
 *
 * In VS Code 1.139.1, `location.origin` of an installed Webview is
 * `vscode-webview://<document id>`: a **non-opaque** origin whose host is the
 * document id, stable for one document and different per document. A page on any
 * other origin — including a hosted `https:` page, the opaque `null` origin, or a
 * `*` wildcard — is not a Webview this bridge can pin its listener to. Only the
 * exact scheme, a non-empty host and nothing else (no port, path, query,
 * credentials) is accepted.
 */
export function isCanonicalWebviewOrigin(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const prefix = "vscode-webview://";
	if (!value.startsWith(prefix)) return false;
	const host = value.slice(prefix.length);
	if (host.length === 0 || host.length > 128) return false;
	// The host is the document id: lowercase base36-ish alphanumerics with no
	// separators, so a spoofed `vscode-webview://user@host/path` cannot pass.
	return /^[a-z0-9]+$/.test(host);
}

/** The 32-hex token that stands for a tab id inside a viewType. */
export function tabIdToken(tabId: string): string {
	if (!isBridgeTabId(tabId)) throw new TypeError("a bridge tab id must be tab:<uuid>");
	return tabId.slice("tab:".length).replace(/-/g, "").toLowerCase();
}

/** The tab id a viewType token stands for. */
export function tabIdFromToken(token: string): string {
	if (!TOKEN_RE.test(token)) throw new TypeError("a bridge tab token must be 32 lowercase hex characters");
	return `tab:${token.slice(0, 8)}-${token.slice(8, 12)}-${token.slice(12, 16)}-${token.slice(16, 20)}-${token.slice(20)}`;
}

/** A viewType for one actual editor of one indexed tab. */
export function bridgeViewType(tabId: string, editorIdHex: string): string {
	if (!TOKEN_RE.test(editorIdHex)) throw new TypeError("a bridge editor id must be 32 lowercase hex characters");
	return `${BRIDGE_VIEW_TYPE_NAMESPACE}${BRIDGE_VIEW_TYPE_VERSION}.${tabIdToken(tabId)}.${editorIdHex}`;
}

/** What a recognized bridge viewType names. */
export interface BridgeViewTypeIdentity {
	readonly tabId: string;
	readonly editorIdHex: string;
}

/**
 * Recover the identity a *registered external* viewType names, or `null` when it
 * is not one of ours. Nothing is guessed: the namespace, the version, the field
 * count and both token shapes must match exactly.
 */
export function decodeBridgeViewType(viewType: unknown): BridgeViewTypeIdentity | null {
	if (typeof viewType !== "string") return null;
	// The namespace itself contains dots (`omp.session.b2`), so the prefix is
	// removed first and only the remainder is split.
	const prefix = `${BRIDGE_VIEW_TYPE_NAMESPACE}${BRIDGE_VIEW_TYPE_VERSION}.`;
	if (!viewType.startsWith(prefix)) return null;
	const rest = viewType.slice(prefix.length).split(".");
	if (rest.length !== 2) return null;
	const tabToken = rest[0];
	const editorIdHex = rest[1];
	if (tabToken === undefined || editorIdHex === undefined) return null;
	if (!TOKEN_RE.test(tabToken) || !TOKEN_RE.test(editorIdHex)) return null;
	return { tabId: tabIdFromToken(tabToken), editorIdHex };
}

/**
 * Recover the *external* viewType from the value a `TabInputWebview` reports.
 *
 * The installed workbench stores webview tab inputs under
 * `mainThreadWebview-<external viewType>` and exposes the raw spelling through
 * the tab input. Only our own namespace is unwrapped; anything else is `null`, so
 * a foreign editor can never be mistaken for one of ours.
 */
export function externalBridgeViewType(tabInputViewType: unknown): string | null {
	if (typeof tabInputViewType !== "string") return null;
	const stripped = tabInputViewType.startsWith(TAB_INPUT_VIEW_TYPE_PREFIX)
		? tabInputViewType.slice(TAB_INPUT_VIEW_TYPE_PREFIX.length)
		: tabInputViewType;
	return decodeBridgeViewType(stripped) === null ? null : stripped;
}

/** The identity a tab input names, prefix or not, or `null`. */
export function tabInputIdentity(tabInputViewType: unknown): BridgeViewTypeIdentity | null {
	const external = externalBridgeViewType(tabInputViewType);
	return external === null ? null : decodeBridgeViewType(external);
}

/** Identity-only Webview state, version 2. Anything else is refused, not upgraded. */
export interface BridgePanelState {
	readonly version: 2;
	readonly tabId: string;
	readonly editorId: string;
}

/** The exact state this bridge persists for a panel it created or migrated. */
export function bridgePanelState(tabId: string, editorIdHex: string): BridgePanelState {
	if (!isBridgeTabId(tabId)) throw new TypeError("a bridge tab id must be the canonical tab:<uuid> spelling");
	if (!TOKEN_RE.test(editorIdHex)) throw new TypeError("a bridge editor id must be 32 lowercase hex characters");
	return { version: 2, tabId, editorId: editorIdHex };
}

/** Read a persisted version-2 identity, or `null` when it is not exactly that. */
export function persistedBridgeState(value: unknown): BridgePanelState | null {
	if (typeof value !== "object" || value === null) return null;
	const candidate: { version?: unknown; tabId?: unknown; editorId?: unknown } = value;
	if (candidate.version !== 2) return null;
	if (!isBridgeTabId(candidate.tabId)) return null;
	if (typeof candidate.editorId !== "string" || !TOKEN_RE.test(candidate.editorId)) return null;
	return { version: 2, tabId: candidate.tabId, editorId: candidate.editorId };
}

/**
 * The durable binding facts a legacy identity is corroborated against: which
 * conversation one editor slot currently controls, and in which role.
 *
 * It is a narrowing of the session index's own binding record rather than a new
 * fact, so this module stays free of the index: the caller passes the lookup it
 * already owns.
 */
export interface CommittedSlotBinding {
	readonly tabId: string;
	readonly role: string;
}

/**
 * The version-2 identity a *legacy* persisted state stands for, or `null` when the
 * editor's own identity does not prove it.
 *
 * An earlier build's fallback document — the bounded explanation a panel shows
 * while it has no bridge endpoint — persisted the version-1 chat identity `{version:1,tabId}`
 * even on an editor of a dynamic view type, so that editor's saved state named a
 * tab but no longer said *which* editor it is, and every later restart refused it.
 * Such a state is accepted only when three independent facts name the same
 * `(T, E)` pair: the editor's own registered `viewType` decodes to that pair, the
 * saved tab equals that `T`, and the durable binding commits `E` to `T` as its
 * **controlling** slot. Anything else — no recognizable viewType, no version-1
 * state, a mismatched tab, an absent or passive binding — stays refused, so a
 * foreign editor is never guessed and a conversation never gains a second writer.
 *
 * The returned state is a freshly built version-2 identity; the caller adopts the
 * editor as an ordinary version-2 revival, and that editor's next document saves
 * the version-2 identity the type expects.
 */
export function recoveredBridgePanelState(
	viewType: unknown,
	state: unknown,
	bindingOf: (editorIdHex: string) => CommittedSlotBinding | null,
): BridgePanelState | null {
	const identity = decodeBridgeViewType(viewType);
	if (identity === null) return null;
	const savedTab = persistedTabId(state);
	if (savedTab === null || savedTab.toLowerCase() !== identity.tabId.toLowerCase()) return null;
	const binding = bindingOf(identity.editorIdHex);
	if (binding === null || binding.role !== "controlling" || binding.tabId.toLowerCase() !== identity.tabId.toLowerCase()) return null;
	return bridgePanelState(identity.tabId, identity.editorIdHex);
}

/**
 * The text one profile's workspace is identified by.
 *
 * `W` must be identical in every window of one workspace on one machine and
 * different for another workspace or profile, because it is the first field of
 * the handshake transcript and the first path segment of every durable record.
 * A saved workspace file is used verbatim when there is one (a multi-root or
 * `.code-workspace` window is one workspace), and the folder list otherwise, with
 * a stable sort so two windows that opened the same folders in another order
 * agree.
 */
export function workspaceIdentityText(folderPaths: readonly string[], workspaceFile: string | null): string {
	if (workspaceFile !== null && workspaceFile.length > 0) return `file:${workspaceFile}`;
	const normalized = folderPaths.map(folder => folder.replace(/\\/g, "/")).sort();
	return `folders:${normalized.join("|")}`;
}

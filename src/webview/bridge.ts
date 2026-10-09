/**
 * VS Code Webview transport for the guest panel — one page, two routes.
 *
 * `acquireVsCodeApi()` may be called once per document and is injected only by the
 * VS Code webview host; when it is absent the panel reports `not-hosted` instead of
 * inventing a fallback channel. The injected object is probed for `postMessage` and
 * `setState`, and this module is the only place either is touched.
 *
 * `setState` carries identity and nothing else. A document the bridge stamped
 * persists `{version:2, tabId, editorId}` (`./panel-identity.ts`); a document
 * without a bridge ticket persists the older `{version:1, tabId}` so an editor
 * created by a previous build is still restorable. It is written at module
 * evaluation — before `omp:ready` and independently of any relay or link — so an
 * editor that never connected is still restored. No capability ever reaches
 * webview state: the host-control key, the bridge secret and every other
 * credential stay in this page's memory.
 *
 * ## Routes
 *
 * The extension host selects **one** route for this document and offers it with a
 * generation the page must acknowledge. The panel route is the ordinary VS Code
 * message channel; the bridge route is the exact loopback listener this document
 * was given a secret for, which keeps a surviving page's chat and model/thinking
 * controls working after the extension host that created it is restarted. The
 * page never infers route health from the existence of the VS Code API, and it
 * never fans a request out over both: `post` sends on the acknowledged route only.
 *
 * The bridge deliberately carries a smaller vocabulary than the panel — the chat
 * channel's commands (prompt, steer, follow-up, abort, dialog answers, older-row
 * loads and Resume), read-only child history, shared chat density preferences and
 * current model/thinking snapshots and mutations. The host can serve these from
 * the attached conversation without a panel handle. Every other exchange
 * stays panel-only, and `routeKind()` lets the UI say so instead of appearing to work.
 */
// Explicit `.ts` specifiers: this module is imported by the node:test runner
// through `src/webview/bridge.test.ts`, and Node's ESM loader does not resolve
// extensionless specifiers (the Webview bundle itself does not care).
import { BridgeClient } from "./lib/bridge-client.ts";
import { HostLink } from "./lib/host-link.ts";
import type { BridgeClientEndpoint } from "./lib/bridge-client.ts";
import { createToken, decodeBase64Url } from "../bridge-protocol.ts";
import type { GuestHostMessage, GuestWebviewMessage } from "./messages.ts";
import { GUEST_PROTOCOL_VERSION, parseGuestHostMessage } from "./messages.ts";
import {
	PANEL_BRIDGE_META,
	PANEL_IDENTITY_META,
	SHELL_SLOT_META,
	panelIdentityFor,
	panelIdentityForEditor,
	parsePanelBridgeTicket,
	shellIdentityFor,
} from "./panel-identity.ts";
import type { PanelBridgeTicket } from "./panel-identity.ts";

/**
 * The capabilities this panel uses from the injected VS Code API.
 *
 * `setState` is optional because the probe must not require it: a host that
 * injects only `postMessage` still has a working panel, it simply cannot have its
 * editor restored.
 */
interface WebviewHostApi {
	postMessage(message: unknown): void;
	setState?(state: unknown): void;
}

/** Which transport may carry this document's traffic right now. */
export type GuestRouteKind = "none" | "panel" | "bridge";

interface TransportState {
	api: WebviewHostApi | null;
	buffer: GuestHostMessage[];
	/** Every live subscriber; the panel has one owner plus feature listeners. */
	listeners: Set<(message: GuestHostMessage) => void>;
	/** The ticket this document was rendered with, or `null`. */
	ticket: PanelBridgeTicket | null;
	/** The acknowledged route generation and the transport that carried it. */
	route: { readonly kind: GuestRouteKind; readonly hostGeneration: string; readonly documentId: string; readonly routeGeneration: string } | null;
	/** The bridge client, once this document was handed a secret. */
	bridge: BridgeClient | null;
	/** Route listeners, so the UI can be honest about what a route carries. */
	routeListeners: Set<(kind: GuestRouteKind) => void>;
	/** The document's own strictly increasing mutation sequence. */
	actionSeq: number;
	/** Whether a connection that was up has been lost; chat commands are refused meanwhile. */
	hostLink: HostLink;
}

const MAX_BUFFERED = 16;

/**
 * Probe the injected VS Code API without trusting its shape: the factory is
 * looked up dynamically, and only a `postMessage` function is required while a
 * `setState` function is retained when the host provides one.
 */
function resolveHostApi(): WebviewHostApi | null {
	const factory: unknown = Reflect.get(globalThis, "acquireVsCodeApi");
	if (typeof factory !== "function") return null;
	let candidate: unknown;
	try {
		candidate = Reflect.apply(factory, globalThis, []);
	} catch {
		return null;
	}
	if (typeof candidate !== "object" || candidate === null || !("postMessage" in candidate)) return null;
	const postMessage = candidate.postMessage;
	if (typeof postMessage !== "function") return null;
	const setState = Reflect.get(candidate, "setState");
	return {
		postMessage(message: unknown): void {
			Reflect.apply(postMessage, candidate, [message]);
		},
		...(typeof setState === "function"
			? {
					setState(state: unknown): void {
						Reflect.apply(setState, candidate, [state]);
					},
				}
			: {}),
	};
}

/** The raw content of one meta tag this document carries, or `null`. */
function metaContent(name: string): string | null {
	if (typeof document === "undefined") return null;
	const meta = document.querySelector(`meta[name="${name}"]`);
	return meta === null ? null : meta.getAttribute("content");
}

/** This document's bridge ticket, or `null` when it carries none. */
export function panelBridgeTicket(): PanelBridgeTicket | null {
	return parsePanelBridgeTicket(metaContent(PANEL_BRIDGE_META));
}

const state: TransportState = {
	api: resolveHostApi(),
	buffer: [],
	listeners: new Set(),
	ticket: panelBridgeTicket(),
	route: null,
	bridge: null,
	routeListeners: new Set(),
	actionSeq: 0,
	hostLink: new HostLink(),
};

/**
 * Persist this document's identity for VS Code's own restart recovery.
 *
 * A bridge-capable session panel persists its editor id as well, because that is what
 * tells a later activation which editor a saved callback belongs to; a panel without a
 * bridge ticket persists the older identity so nothing an earlier build created loses
 * its restart record. A folder shell persists its own slot instead — a different kind
 * of editor, with no tab and no session.
 *
 * The host stamps exactly one of the two tags, so at most one identity is written, and
 * a document carrying neither persists nothing. Nothing here is conditional on a
 * relay, a link or a rendered panel, and nothing but an identity ever crosses: the
 * mode a session editor is showing belongs to the extension host, not to this state.
 */
function rememberDocumentIdentity(): void {
	const setState = state.api?.setState;
	if (setState === undefined) return;
	const tabId = metaContent(PANEL_IDENTITY_META);
	const identity =
		state.ticket === null
			? (panelIdentityFor(tabId) ?? shellIdentityFor(metaContent(SHELL_SLOT_META)))
			: (panelIdentityForEditor(tabId, state.ticket.editorId) ?? panelIdentityFor(tabId));
	if (identity === null) return;
	try {
		setState(identity);
	} catch {
		// The state is VS Code's to keep; a failure to keep it is not a panel error.
	}
}

rememberDocumentIdentity();

/** Hand one validated host message to the panel's own subscribers. */
function deliver(message: GuestHostMessage): void {
	if (state.listeners.size > 0) {
		for (const listener of state.listeners) listener(message);
	} else if (state.buffer.length < MAX_BUFFERED) {
		state.buffer.push(message);
	}
}

/** Which channel carried one inbound message. */
type InboundSource = "panel" | "bridge";

/** Accept an untrusted payload from either route; a wrong shape is dropped. */
function deliverRaw(payload: unknown, source: InboundSource): void {
	const parsed = parseGuestHostMessage(payload);
	if (parsed === null) return;
	if (parsed.type === "omp:route-offer") {
		handleRouteOffer(parsed, source);
		return;
	}
	if (parsed.type === "omp:bridge-bind") {
		startBridge(parsed);
		return;
	}
	deliver(parsed);
}

/**
 * The bridge operation one outgoing message is served as, or `null` when the exchange
 * is panel-only.
 *
 * `@`-completion and the composer's popup report need the panel handle the restarted
 * host no longer has. Footer picker reads and mutations and host metadata use the same
 * authenticated routes as chat.
 *
 * Terminal frames travel the bridge because a surviving page *is* the terminal: its
 * PTY outlived the extension host, and the host authorizes each frame against the
 * editor, the broker generation and the claim rather than against the panel. Chat
 * commands travel it because the conversation's process outlived the host too: the
 * restarted host re-attaches it and serves the surviving page from that session.
 */
function bridgeOperation(message: GuestWebviewMessage): string | null {
	switch (message.type) {
		case "omp:control-request":
			return message.action === "snapshot" ? "snapshot" : message.action;
		case "omp:chat-command":
			return message.command === "provider-login" ? "provider-login" : null;
		case "omp:chat-prompt":
			return "chat-prompt";
		case "omp:chat-steer":
			return "chat-steer";
		case "omp:chat-follow-up":
			return "chat-follow-up";
		case "omp:chat-abort":
			return "chat-abort";
		case "omp:chat-ui-response":
			return "chat-ui-response";
		case "omp:chat-load-older":
			return "chat-load-older";
		case "omp:chat-subagent-read":
			return "chat-subagent-read";
		case "omp:chat-tool-detail":
			return "chat-tool-detail";
		case "omp:chat-resume":
			return "chat-resume";
		case "omp:chat-reconnect":
			return "chat-reconnect";
		case "omp:chat-restart":
			return "chat-restart";
		case "omp:chat-queue-remove":
			return "chat-queue-remove";
		case "omp:terminal-attach":
			return "terminal-attach";
		case "omp:terminal-probe":
			return "terminal-probe";
		case "omp:terminal-copy-reply":
			return "terminal-copy-reply";
		case "omp:terminal-link-validate":
			return "terminal-link-validate";
		case "omp:terminal-link-open":
			return "terminal-link-open";
		case "omp:terminal-input":
			return "terminal-input";
		case "omp:terminal-resize":
			return "terminal-resize";
		case "omp:terminal-focus":
			return "terminal-focus";
		case "omp:terminal-visibility":
			return "terminal-visibility";
		default:
			return null;
	}
}

/**
 * Acknowledge one route offer over the transport that carried it.
 *
 * The offer is authoritative — the host offers exactly one route at a time, and it
 * is the host that knows whether it still holds this document's panel handle — so
 * the newest offer wins even when it moves the page off the route it was using.
 * The route is adopted only after the acknowledgement actually went out: a page
 * that dispatched into a generation the host had fenced would be answering a route
 * nobody selected.
 */
function handleRouteOffer(message: Extract<GuestHostMessage, { type: "omp:route-offer" }>, source: InboundSource): void {
	if (source === "bridge") {
		const client = state.bridge;
		if (client === null || !client.acknowledgeRoute(message.routeGeneration)) return;
		adoptRoute("bridge", message.hostGeneration, message.documentId, message.routeGeneration);
		// A surviving older guest never sends this sealed, read-only announcement.
		// The host keeps its snapshot detached until this connection proves v9.
		client.request({ routeGeneration: message.routeGeneration, requestId: createToken(), actionSeq: "0",
			operation: "guest-version", payload: { protocolVersion: GUEST_PROTOCOL_VERSION, fragments: true } });
		return;
	}
	postOverPanel({ type: "omp:route-ack", hostGeneration: message.hostGeneration, documentId: message.documentId, routeGeneration: message.routeGeneration });
	adoptRoute("panel", message.hostGeneration, message.documentId, message.routeGeneration);
}

/** The window's own message channel: the panel route's inbound half. */
if (typeof window !== "undefined") {
	window.addEventListener("message", (event: MessageEvent) => {
		deliverRaw(event.data, "panel");
	});
}

/** Turn one accepted bridge secret into a live client. */
function startBridge(bind: Extract<GuestHostMessage, { type: "omp:bridge-bind" }>): void {
	let secret: Uint8Array;
	try {
		secret = decodeBase64Url(bind.secret, 32);
	} catch {
		// The secret reaches this page from the host's own encoder; a value this
		// boundary cannot decode is a mismatch, and running without a bridge is the
		// honest outcome rather than guessing at one.
		return;
	}
	state.bridge?.stop();
	const endpoint: BridgeClientEndpoint = {
		workspace: bind.workspace,
		tabId: bind.tabId,
		editorId: bind.editorId,
		documentId: bind.documentId,
		port: bind.port,
		origin: bind.origin,
		bindingHash: bind.bindingHash,
		secret,
	};
	const client = new BridgeClient(endpoint, {
		onRouteOffer: (routeGeneration, status) => {
			if (state.bridge !== client) return;
			handleRouteOffer({ type: "omp:route-offer", hostGeneration: bind.hostGeneration, documentId: bind.documentId, routeGeneration, status }, "bridge");
		},
		onInvalidate: routeGeneration => {
			// An invalidation only ever concerns the route it names: one for a fenced
			// generation must not clear the correlation of the live one.
			if (state.route?.kind !== "bridge" || state.route.routeGeneration !== routeGeneration) return;
			deliver({ type: "omp:control-invalidate" });
		},
		onReply: (_requestId, payload) => {
			deliverRaw(payload, "bridge");
		},
		onMessage: payload => {
			// A pushed message is one this host chose to send, not an answer to anything: it
			// takes the same validated path every other inbound message takes, so a frame the
			// boundary refuses is dropped rather than reaching a surface.
			deliverRaw(payload, "bridge");
		},
		onConnection: connected => {
			state.hostLink.noteConnection(connected);
			if (state.route?.kind === "panel") {
				for (const listener of state.routeListeners) listener("panel");
			}
			// A lost connection invalidates the *route* it was carrying: the page must
			// never dispatch under a generation the new host has fenced, so the route is
			// cleared here and re-adopted when the host offers one again.
			if (connected || state.bridge !== client || state.route?.kind !== "bridge") return;
			adoptRoute("none", "", "", "");
		},
		onRecoveryFailed: () => {
			if (state.bridge !== client || !state.hostLink.lost) return;
			state.hostLink.noteRecoveryFailed();
			for (const listener of state.routeListeners) listener(state.route?.kind ?? "none");
		},
	});
	state.bridge = client;
	client.start();
	// Acknowledging the binding over the panel is what tells the host that this page
	// received the secret and the instantiation the binding was pinned to.
	post({ type: "omp:bridge-ack", hostGeneration: bind.hostGeneration, documentId: bind.documentId, bindingHash: bind.bindingHash });
}

/** Adopt one acknowledged route and tell the UI, without remounting anything. */
function adoptRoute(kind: GuestRouteKind, hostGeneration: string, documentId: string, routeGeneration: string): void {
	const previous = state.route;
	state.route = { kind, hostGeneration, documentId, routeGeneration };
	if (kind === "panel") state.hostLink.noteConnection(true);
	if (previous?.kind !== kind || previous?.hostGeneration !== hostGeneration || previous?.routeGeneration !== routeGeneration) {
		for (const listener of state.routeListeners) listener(kind);
	}
}

/** The document's own strictly increasing sequence for irreversible changes. */
function nextActionSeq(): string {
	state.actionSeq += 1;
	return String(state.actionSeq);
}

/** Send one message over the panel route, unconditionally. */
function postOverPanel(message: GuestWebviewMessage): void {
	state.api?.postMessage(message);
}

/**
 * Send on the acknowledged route, or on the panel when no route is acknowledged.
 *
 * Returns `false` when the message provably went nowhere — a bridge connection that cannot
 * carry it, or an exchange only the panel can serve while the panel is not the route — so a
 * caller that must not lose the user's text (the composer) can keep it and say why. `true`
 * means the message was handed to the route; it is not an acknowledgement.
 */
function post(message: GuestWebviewMessage): boolean {
	// A chat command must not vanish into a dead host: see HostLink.
	if (state.hostLink.refuses(message.type)) return false;
	const route = state.route;
	if (route?.kind === "bridge" && state.bridge !== null) {
		const operation = bridgeOperation(message);
		if (operation !== null) {
			return state.bridge.request({
				routeGeneration: route.routeGeneration,
				requestId: createRequestId(),
				// A mutation sends the sequence of the document it belongs to — the same
				// one the message carries — so the host's single admission ledger sees one
				// strictly increasing counter whichever route carried it.
				actionSeq: message.type === "omp:control-request" && message.actionSeq !== undefined ? message.actionSeq : nextActionSeq(),
				operation,
				payload: message,
			});
		}
		// Panel-only exchange on a bridge route: the host cannot serve it without the
		// panel handle, so it is not sent anywhere and the UI's own timeout and route
		// notice are the honest answer.
		return false;
	}
	postOverPanel(message);
	return true;
}

export const guestTransport = {
	/** False when this document was not loaded by the VS Code webview host. */
	hosted: state.api !== null,
	/** The ticket this document was rendered with, or `null`. */
	ticket(): PanelBridgeTicket | null {
		return state.ticket;
	},
	/** Announce this document and, when it carries a ticket, report that ticket. */
	announce(): void {
		const ticket = state.ticket;
		const origin = typeof location === "undefined" ? "" : location.origin;
		if (ticket === null || origin.length === 0) {
			postOverPanel({ type: "omp:ready", protocolVersion: GUEST_PROTOCOL_VERSION });
			return;
		}
		postOverPanel({
			type: "omp:ready",
			protocolVersion: GUEST_PROTOCOL_VERSION,
			editorId: ticket.editorId,
			documentId: ticket.documentId,
			bootstrapId: ticket.bootstrapId,
			origin,
		});
	},
	/** The route the host selected for this document and this page acknowledged. */
	routeKind(): GuestRouteKind {
		return state.route?.kind ?? "none";
	},
	/** Actual established bridge loss, not an unanswered feature request. */
	hostConnectionLost(): boolean {
		return state.hostLink.lost;
	},
	hostRecoveryFailed(): boolean {
		return state.hostLink.recoveryFailed;
	},
	/** Observe route changes; the UI uses this to say what a route cannot carry. */
	onRouteChange(listener: (kind: GuestRouteKind) => void): () => void {
		state.routeListeners.add(listener);
		return () => {
			state.routeListeners.delete(listener);
		};
	},
	post,
	/** The document's own strictly increasing sequence for irreversible changes. */
	nextActionSeq,
	/**
	 * Register a listener. The panel owner subscribes first and receives any
	 * message buffered before it did; a feature listener added later sees only
	 * messages from that point on, so nothing is delivered twice.
	 */
	subscribe(listener: (message: GuestHostMessage) => void): () => void {
		const first = state.listeners.size === 0;
		state.listeners.add(listener);
		if (first) {
			const pending = state.buffer.splice(0, state.buffer.length);
			for (const message of pending) listener(message);
		}
		return () => {
			state.listeners.delete(listener);
		};
	},
};

/** One fresh correlation id for a bridge request; the host echoes it in its reply. */
function createRequestId(): string {
	const bytes = new Uint8Array(16);
	globalThis.crypto.getRandomValues(bytes);
	let out = "";
	for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
	return out;
}

/**
 * Read the CSP nonce the host stamped on this document's script tag, so the
 * runtime-injected stylesheet satisfies `style-src 'nonce-…'`.
 *
 * `HTMLOrSVGScriptElement.nonce` is optional in the DOM typings, so the value is
 * validated before use rather than asserted.
 */
export function readCspNonce(): string {
	const current = document.currentScript;
	const scriptNonce: string | undefined = current === null ? undefined : current.nonce;
	if (typeof scriptNonce === "string" && scriptNonce.length > 0) return scriptNonce;
	const stamped = document.querySelector("script[nonce]");
	return stamped?.getAttribute("nonce") ?? "";
}

/**
 * One editor's bridge endpoint: its exact listener, its documents and their route.
 *
 * ADR-0023 keeps one listener per actual editor `E` rather than one per window,
 * because the OS bind is the resource-writer lease: the port is what a surviving
 * page knows, and an occupied port is a refusal rather than a reason to look for
 * another one. This module owns exactly that lifecycle:
 *
 * - **bind** — read the port recorded for `E` and bind precisely it; for an `E`
 *   this window has never recorded, bind an ephemeral port and record it
 *   immutably. Rebinding the recorded port after an extension-host restart is what
 *   lets the page that never stopped running find the new host.
 * - **document** — every actual `webview.html` incarnation is a fresh `D` with its
 *   own secret `K`, prepared before the document is installed and committed only
 *   after the page reported its canonical Origin *and* the chat-host binding
 *   `B0` was verified. An HTML replacement retires the previous credential, so an
 *   old page's reconnect is refused instead of trusted. A *surviving* document is
 *   adopted as it is: the manifest already names it and its origin is already
 *   persisted, so nothing is re-minted and the page keeps its secret.
 * - **route** — one {@link BridgeDocumentRoute} per document, offered over the
 *   panel while this host holds that panel's handle and over the bridge for a
 *   surviving page that authenticated. A document is only a route once its page
 *   acknowledged the current generation.
 *
 * Nothing here decides *authorization*: whether a document may act is the
 * extension's answer (`eligible`, `onRequest`). This module refuses only what it
 * can prove wrong — an uncommitted document, a foreign origin, a secret that does
 * not exist, a fenced generation.
 */

import { BridgeRecords, BridgeRecordError } from "./bridge-records.ts";
import type { BridgeDocumentRecord, BridgeNativeBinding, BridgeRecordScope } from "./bridge-records.ts";
import { bindingHashFor } from "./bridge-records.ts";
import { BridgeListener } from "./bridge-listener.ts";
import type { BridgeAdmittedRequest, BridgeDocumentAuthorization, BridgeSession } from "./bridge-listener.ts";
import { BridgeDocumentRoute, BRIDGE_ROUTE_ACK_TIMEOUT_MS } from "./bridge-route.ts";
import type { BridgeEndpointState } from "./bridge-route.ts";
import { isBridgeEditorId, isCanonicalWebviewOrigin } from "../bridge-identity.ts";
import { BRIDGE_DOCUMENT_ID_BYTES, BRIDGE_EDITOR_ID_BYTES, BRIDGE_PATH, decodeHex, encodeHex, randomBytes } from "../bridge-protocol.ts";
import type { BridgeHello } from "../bridge-protocol.ts";
import { GUEST_PROTOCOL_VERSION } from "../webview/messages.ts";
import type { ChatStateMessage } from "../webview/chat-messages.ts";

/** Small enough for the previous guest protocol, without any snapshot or fragment. */
export const BRIDGE_GUEST_RELOAD_REASON = "This page needs the current OMP Desk guest. Run Developer: Reload Window. Your draft is kept.";

interface GuestVersionCheck {
	readonly session: BridgeSession;
	readonly routeGeneration: string;
	readonly deadline: number;
	status: "pending" | "accepted" | "refused";
	timer: NodeJS.Timeout | undefined;
}

/** One document incarnation of an editor, with its route. */
export interface BridgeEditorDocument {
	readonly documentId: string;
	readonly bootstrapId: string;
	readonly route: BridgeDocumentRoute;
}

/** What the panel route tells a document's page once the document is committed. */
export interface BridgeBootstrapDelivery {
	/** The document this secret belongs to (`D`), 32 lowercase hex. */
	readonly documentId: string;
	/** The bootstrap message this delivery answers; the page echoes it back. */
	readonly bootstrapId: string;
	/** The exact port this editor's listener is bound to. */
	readonly port: number;
	/** The canonical Origin the listener accepts for this document. */
	readonly origin: string;
	/** Lowercase SHA-256 hex of the acknowledged chat-host binding `B0`. */
	readonly bindingHash: string;
	/** The document's independent reconnect secret; never persisted by the page. */
	readonly secret: Uint8Array;
}

/** Everything one endpoint needs from the extension. */
export interface BridgeEditorEndpointOptions {
	readonly records: BridgeRecords;
	readonly scope: BridgeRecordScope;
	/** The activation-wide generation every session and frame is fenced to. */
	readonly hostGeneration: Uint8Array;
	/**
	 * Whether one document of this editor may still act.
	 *
	 * The extension answers from this window's actual recognized editor
	 * membership, the indexed row and the current owner — never from a record.
	 */
	readonly eligible: (documentId: string) => boolean;
	/** One admitted request, already fenced by the listener to this document. */
	readonly onRequest: (session: BridgeSession, documentId: string, request: BridgeAdmittedRequest) => void;
	readonly onStateChanged?: (documentId: string, state: BridgeEndpointState) => void;
	/** Optional interval for the authenticated heartbeat (default: protocol interval). */
	readonly heartbeatMs?: number;
	readonly onDiagnostic?: (code: string, detail: string) => void;
}

/** One editor's exact listener, documents and routes. */
export class BridgeEditorEndpoint {
	readonly #records: BridgeRecords;
	readonly #scope: BridgeRecordScope;
	readonly #hooks: BridgeEditorEndpointOptions;
	readonly #documents = new Map<string, BridgeEditorDocument>();
	/** Committed facts per document, as persisted: the origin and the binding. */
	readonly #committed = new Map<string, { readonly origin: string; readonly bindingHash: string; readonly binding: BridgeNativeBinding }>();
	/** The one authenticated session per document, for offers that wait for one. */
	readonly #sessions = new Map<string, BridgeSession>();
	/** Rendering capability belongs to a connection and its acknowledged route, not D alone. */
	readonly #guestVersions = new Map<string, GuestVersionCheck>();
	#listener: BridgeListener | null = null;
	#current: string | null = null;
	/** The Origin a not-yet-committed document reported over the panel route. */
	#reportedOrigin: string | null = null;
	#bindFailure: string | null = null;
	#binding: Promise<number | null> | null = null;
	/** The one commit of each document, so a race cannot mint a second secret. */
	readonly #commits = new Map<string, Promise<BridgeBootstrapDelivery | null>>();
	#closed = false;

	constructor(options: BridgeEditorEndpointOptions) {
		this.#records = options.records;
		this.#scope = options.scope;
		this.#hooks = options;
	}

	get scope(): BridgeRecordScope {
		return this.#scope;
	}

	/** The exact port this editor's listener holds, or `null`. */
	get port(): number | null {
		return this.#listener?.port ?? null;
	}

	/** Why binding failed, if it did. A bounded code. */
	get failure(): string | null {
		return this.#bindFailure;
	}

	get hostGeneration(): Uint8Array {
		return this.#hooks.hostGeneration;
	}

	/** Whether this exact bridge route proved it can consume the current guest DTOs. */
	guestVersionAccepted(documentId: string): boolean {
		const check = this.#guestVersions.get(documentId);
		const document = this.#documents.get(documentId);
		return check?.status === "accepted" && this.#sessions.get(documentId) === check.session
			&& document?.route.offeredKind === "bridge" && document.route.acknowledged
			&& document.route.isCurrentRoute(check.routeGeneration) && check.session.routeAcknowledged(check.routeGeneration);
	}

	/** The document this editor is serving right now, or `null`. */
	get document(): BridgeEditorDocument | null {
		return this.#current === null ? null : this.#documents.get(this.#current) ?? null;
	}

	/**
	 * The canonical Origin this listener accepts, or `null` when none is pinned.
	 *
	 * A committed document's origin is the one persisted with it; a document that
	 * is still being provisioned has only the origin its own page reported. An
	 * unauthenticated socket can therefore never teach the listener an origin: the
	 * report travels the panel route, and only the current document's report counts.
	 */
	get origin(): string | null {
		const document = this.document;
		if (document === null) return null;
		return this.#committed.get(document.documentId)?.origin ?? this.#reportedOrigin;
	}

	routeFor(documentId: string): BridgeDocumentRoute | null {
		return this.#documents.get(documentId)?.route ?? null;
	}

	/** Whether this editor currently serves one document at all. */
	get serving(): boolean {
		return this.#current !== null && !this.#closed;
	}

	/**
	 * Bind — or rebind — this editor's exact port.
	 *
	 * The recorded port is the lease the surviving page knows, so it is used
	 * verbatim when there is one; an ephemeral port is chosen only for an editor
	 * this window has never recorded. A port that cannot be bound is a failure:
	 * this never scans for another one.
	 */
	bind(): Promise<number | null> {
		// One bind per endpoint, however many callers ask at once: two listeners for
		// one editor would fight for the same recorded port and leave one of them
		// holding a port its page never learned.
		this.#binding ??= this.#bindOnce();
		return this.#binding;
	}

	async #bindOnce(): Promise<number | null> {
		if (this.#closed || this.#listener !== null) return this.#listener?.port ?? null;
		let requested: number | null = null;
		try {
			requested = await this.#records.recordedPort(this.#scope);
		} catch (error) {
			this.#bindFailure = error instanceof BridgeRecordError ? `record-${error.code}` : "record-unreadable";
			this.#hooks.onDiagnostic?.("endpoint-record", "this editor's endpoint record could not be read");
			return null;
		}
		const listener = this.#createListener(requested);
		this.#listener = listener;
		if (!(await listener.listen())) {
			this.#bindFailure = listener.failure ?? "bind-failed";
			this.#hooks.onDiagnostic?.(`endpoint-${this.#bindFailure}`, "this editor's exact port could not be bound");
			return null;
		}
		const port = listener.port;
		if (port === null) {
			this.#bindFailure = "bind-failed";
			return null;
		}
		if (requested === null) {
			try {
				await this.#records.writeEndpoint(this.#scope, port);
			} catch (error) {
				// The port is bound but not recorded: an editor with no durable
				// endpoint could never be reconnected to, so it is closed rather than
				// handed out as if it were durable.
				this.#bindFailure = error instanceof BridgeRecordError ? `record-${error.code}` : "record-unwritable";
				this.#hooks.onDiagnostic?.("endpoint-record", "this editor's endpoint record could not be written");
				listener.close();
				this.#listener = null;
				return null;
			}
		}
		return port;
	}

	#createListener(requestedPort: number | null): BridgeListener {
		const endpoint = this;
		return new BridgeListener({
			// Pinned per document, from the document's own persisted or reported
			// origin; every upgrade is refused while this is `null`.
			get origin(): string | null {
				return endpoint.origin;
			},
			requestedPort,
			authorize: hello => this.#authorize(hello),
			onRequest: (session, request) => {
				if (request.operation === "guest-version") this.#guestVersionRequest(session, request);
				else this.#hooks.onRequest(session, encodeHex(session.documentId), request);
			},
			onSessionAuthenticated: session => this.noteSession(session),
			onSessionEnded: session => this.#sessionEnded(session),
			...(this.#hooks.heartbeatMs === undefined ? {} : { heartbeatMs: this.#hooks.heartbeatMs }),
			onRouteAcknowledged: (session, routeGeneration) => this.#routeAcknowledged(session, routeGeneration),
			onDiagnostic: (code, detail) => this.#hooks.onDiagnostic?.(code, detail),
		});
	}

	/** Release the port and end every session. */
	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		for (const document of this.#documents.values()) document.route.retire();
		for (const documentId of this.#guestVersions.keys()) this.#clearGuestVersion(documentId);
		this.#listener?.close();
		this.#listener = null;
		this.#documents.clear();
		this.#committed.clear();
		this.#sessions.clear();
		this.#current = null;
		this.#reportedOrigin = null;
	}

	async #authorize(hello: BridgeHello): Promise<BridgeDocumentAuthorization | null> {
		const documentId = encodeHex(hello.documentId);
		const origin = this.origin;
		if (origin === null || !this.#hooks.eligible(documentId)) return null;
		try {
			const record = await this.#records.readDocument(this.#scope, documentId);
			if (record === null || record.origin !== origin) return null;
			const secret = await this.#records.readSecret(this.#scope, documentId);
			if (secret === null) return null;
			return {
				secret,
				bindingHash: record.bindingHash,
				workspace: this.#scope.workspace,
				tabId: this.#scope.tabId,
				editorId: decodeHex(this.#scope.editorId, BRIDGE_EDITOR_ID_BYTES),
				documentId: decodeHex(documentId, BRIDGE_DOCUMENT_ID_BYTES),
			};
		} catch {
			return null;
		}
	}

	#sessionEnded(session: BridgeSession): void {
		const documentId = encodeHex(session.documentId);
		if (this.#sessions.get(documentId) !== session) return;
		this.#clearGuestVersion(documentId);
		this.#sessions.delete(documentId);
		this.#documents.get(documentId)?.route.bridgeClosed();
	}

	/**
	 * A route acknowledgement from the page.
	 *
	 * The document's own route selection decides: an acknowledgement of the current
	 * generation is adopted; one of a fenced generation is refused and the current
	 * offer is re-sent, so the page converges on the route this host actually
	 * selected without needing a second connection.
	 */
	#routeAcknowledged(session: BridgeSession, routeGeneration: string): boolean {
		const documentId = encodeHex(session.documentId);
		const document = this.#documents.get(documentId);
		if (document === undefined || !this.#hooks.eligible(documentId)) return false;
		if (document.route.acknowledge(routeGeneration, "bridge")) {
			const previous = this.#guestVersions.get(documentId);
			if (previous?.session !== session || previous.routeGeneration !== routeGeneration) {
				this.#clearGuestVersion(documentId);
				const check: GuestVersionCheck = { session, routeGeneration, deadline: performance.now() + BRIDGE_ROUTE_ACK_TIMEOUT_MS,
					status: "pending", timer: undefined };
				this.#guestVersions.set(documentId, check);
				check.timer = setTimeout(() => this.#refuseGuestVersion(documentId, check), BRIDGE_ROUTE_ACK_TIMEOUT_MS);
				check.timer.unref();
			}
			return true;
		}
		try {
			this.#sendOffer(document, document.route.requireRouteGeneration());
		} catch {
			/* the session may have gone away between the acknowledgement and this offer */
		}
		return false;
	}

	#clearGuestVersion(documentId: string): void {
		clearTimeout(this.#guestVersions.get(documentId)?.timer);
		this.#guestVersions.delete(documentId);
	}

	#guestVersionRequest(session: BridgeSession, request: BridgeAdmittedRequest): void {
		const documentId = encodeHex(session.documentId);
		const check = this.#guestVersions.get(documentId);
		const payload = request.payload;
		const matches = check !== undefined && check.session === session && check.routeGeneration === request.routeGeneration;
		const valid = payload !== null && typeof payload === "object" && !Array.isArray(payload)
			&& "protocolVersion" in payload && payload.protocolVersion === GUEST_PROTOCOL_VERSION
			&& "fragments" in payload && payload.fragments === true;
		const accepted = matches && check.status !== "refused" && (check.status === "accepted" || performance.now() <= check.deadline) && valid;
		// Release the transport reservation immediately; this probe never reaches native code.
		session.reply(request.requestId, { accepted });
		if (!matches) return;
		if (!accepted) { this.#refuseGuestVersion(documentId, check); return; }
		if (check.status === "accepted") return;
		clearTimeout(check.timer);
		check.timer = undefined;
		check.status = "accepted";
		const document = this.#documents.get(documentId);
		if (document !== undefined) this.#hooks.onStateChanged?.(documentId, document.route.state);
	}

	#refuseGuestVersion(documentId: string, check: GuestVersionCheck): void {
		const document = this.#documents.get(documentId);
		if (this.#guestVersions.get(documentId) !== check || this.#sessions.get(documentId) !== check.session
			|| document === undefined || !document.route.isCurrentRoute(check.routeGeneration) || check.status === "refused") return;
		clearTimeout(check.timer);
		check.timer = undefined;
		check.status = "refused";
		// Do not attach ChatRuntime: an old surviving page cannot assemble fragments.
		// This existing v8 message disables its composer without touching its draft.
		const payload: ChatStateMessage = {
			type: "omp:chat-state", epoch: { nonce: encodeHex(this.#hooks.hostGeneration), counter: 0 },
			phase: "blocked", code: null, sessionId: null, cwd: null, title: null, readOnlyReason: BRIDGE_GUEST_RELOAD_REASON,
		};
		check.session.send("terminal", { routeGeneration: check.routeGeneration, payload });
		this.#hooks.onStateChanged?.(documentId, document.route.state);
	}

	/**
	 * Begin a new document incarnation of this editor.
	 *
	 * The previous document's credential is retired here — an HTML replacement is
	 * exactly when a page stops being the document this host trusts — and the new
	 * one is prepared before its document is installed, so the manifest never names
	 * a document that could not be described yet.
	 */
	async beginDocument(documentId: string, bootstrapId: string): Promise<BridgeEditorDocument | null> {
		if (this.#closed) return null;
		if (!isBridgeEditorId(documentId) || !isBridgeEditorId(bootstrapId)) return null;
		const previous = this.#current;
		try {
			if (previous !== null && previous !== documentId) await this.#records.retire(this.#scope, previous);
			await this.#records.writePrepared(this.#scope, documentId);
		} catch (error) {
			this.#hooks.onDiagnostic?.(error instanceof BridgeRecordError ? `document-${error.code}` : "document-record", "a bridge document could not be prepared");
			return null;
		}
		if (previous !== null && previous !== documentId) {
			this.#documents.get(previous)?.route.retire();
			this.#clearGuestVersion(previous);
			this.#documents.delete(previous);
			this.#committed.delete(previous);
			this.#sessions.delete(previous);
			// A new document is a new origin: the previous document's report must not
			// be reused for it.
			this.#reportedOrigin = null;
		}
		this.#reportedOrigin = null;
		return this.#install({ documentId, bootstrapId });
	}

	/**
	 * Adopt a document that already exists: the page survived an extension-host
	 * restart, so its manifest and origin are already persisted and nothing is
	 * re-minted. Returns `null` for a document this host cannot serve.
	 */
	async adoptRecordedDocument(): Promise<BridgeEditorDocument | null> {
		let documentId: string | null = null;
		try {
			const manifest = await this.#records.readManifest(this.#scope);
			if (manifest !== null && manifest.state === "committed") documentId = manifest.D;
		} catch {
			return null;
		}
		return documentId === null ? null : this.adoptDocument(documentId);
	}

	/**
	 * Re-send this document's current offer over the bridge.
	 *
	 * The generation is not re-minted: a route the page already acknowledged stays the
	 * one it may dispatch under, and only the status word moves. When no route has been
	 * offered yet, one is.
	 */
	refreshBridgeOffer(): string | null {
		const document = this.document;
		if (document === null || this.#closed) return null;
		const routeGeneration = document.route.routeGeneration ?? document.route.offer("bridge");
		if (document.route.offeredKind !== "bridge") return routeGeneration;
		this.#sendOffer(document, routeGeneration);
		return routeGeneration;
	}

	async adoptDocument(documentId: string): Promise<BridgeEditorDocument | null> {
		if (this.#closed || !isBridgeEditorId(documentId)) return null;
		let record: BridgeDocumentRecord | null;
		try {
			record = await this.#records.readDocument(this.#scope, documentId);
		} catch {
			return null;
		}
		if (record === null || record.E !== this.#scope.editorId) return null;
		// The record tree is not integrity-protected, so an adopted document's persisted
		// origin is re-validated exactly like a live report: an edited descriptor must
		// not be able to point this listener at an origin a browser page can produce.
		if (!isCanonicalWebviewOrigin(record.origin)) {
			this.#hooks.onDiagnostic?.("origin-refused", "an adopted document's origin is not one this bridge accepts");
			return null;
		}
		const previous = this.#current;
		if (previous !== null && previous !== documentId) {
			this.#documents.get(previous)?.route.retire();
			this.#documents.delete(previous);
			this.#committed.delete(previous);
			this.#sessions.delete(previous);
		}
		this.#reportedOrigin = null;
		this.#committed.set(documentId, { origin: record.origin, bindingHash: record.bindingHash, binding: record.nativeBinding });
		return this.#install({ documentId, bootstrapId: record.bootstrapId });
	}

	#install(input: { readonly documentId: string; readonly bootstrapId: string }): BridgeEditorDocument {
		const onStateChanged = this.#hooks.onStateChanged;
		const document: BridgeEditorDocument = {
			documentId: input.documentId,
			bootstrapId: input.bootstrapId,
			route: new BridgeDocumentRoute({
				hostGeneration: this.#hooks.hostGeneration,
				documentId: decodeHex(input.documentId, BRIDGE_DOCUMENT_ID_BYTES),
				...(onStateChanged === undefined ? {} : { hooks: { onStateChanged: state => onStateChanged(input.documentId, state) } }),
			}),
		};
		this.#documents.set(input.documentId, document);
		this.#current = input.documentId;
		return document;
	}

	/**
	 * Pin the canonical Origin the current document reported over the panel route.
	 *
	 * Only the document this host currently serves may pin one, and only a
	 * canonical non-opaque `vscode-webview://…` origin is accepted: anything else
	 * (including `*`, `null` or a differently shaped origin) leaves the listener with
	 * nothing to pin, and every upgrade stays refused.
	 */
	pinOrigin(documentId: string, origin: unknown): boolean {
		if (this.#closed || this.#current !== documentId) return false;
		if (!isCanonicalWebviewOrigin(origin)) {
			this.#hooks.onDiagnostic?.("origin-refused", "a document reported an origin this bridge does not accept");
			return false;
		}
		this.#reportedOrigin = origin;
		return true;
	}

	/**
	 * Commit this document against a verified chat-host binding.
	 *
	 * This is the only moment a document becomes able to authenticate: the complete
	 * descriptor is written, the secret is stored, and the manifest is committed.
	 * It is write-once per document — committing a document that is already
	 * committed would rotate the secret a live page is holding, so it refuses
	 * instead. The caller must have verified the binding against the live native
	 * side first.
	 */
	commit(binding: BridgeNativeBinding): Promise<BridgeBootstrapDelivery | null> {
		const documentId = this.#current;
		// The origin can arrive after native verification. Returning `null` here is not a
		// failed commitment and is not cached, so a later ready report can still commit.
		if (this.#closed || documentId === null || this.#reportedOrigin === null) return Promise.resolve(null);
		// One commit per document, however many callers race into it: two concurrent
		// commits would mint two secrets for one document, and whichever write landed
		// last would invalidate the secret the page may already have received.
		const pending = this.#commits.get(documentId);
		if (pending !== undefined) return pending;
		const started = this.#commitOnce(binding);
		this.#commits.set(documentId, started);
		return started;
	}

	async #commitOnce(binding: BridgeNativeBinding): Promise<BridgeBootstrapDelivery | null> {
		const documentId = this.#current;
		const port = this.#listener?.port ?? null;
		const origin = this.origin;
		const document = documentId === null ? undefined : this.#documents.get(documentId);
		if (this.#closed || documentId === null || document === undefined || port === null || origin === null || this.#committed.has(documentId)) return null;
		bindingCheck(binding);
		const bindingHash = await bindingHashFor(binding);
		const secret = randomBytes(32);
		const descriptor: BridgeDocumentRecord = {
			v: 1,
			W: this.#scope.workspace,
			T: this.#scope.tabId,
			E: this.#scope.editorId,
			D: documentId,
			port,
			path: BRIDGE_PATH,
			origin,
			bootstrapId: document.bootstrapId,
			nativeBinding: binding,
			bindingHash,
		};
		try {
			await this.#records.commitDocument(this.#scope, descriptor);
			await this.#records.writeSecret(this.#scope, documentId, secret);
		} catch (error) {
			this.#hooks.onDiagnostic?.(error instanceof BridgeRecordError ? `commit-${error.code}` : "commit-failed", "a bridge document could not be committed");
			return null;
		}
		this.#committed.set(documentId, { origin, bindingHash, binding });
		return { documentId, bootstrapId: document.bootstrapId, port, origin, bindingHash, secret };
	}

	/**
	 * The delivery to (re)send for the current document, read back from its records.
	 *
	 * A page that announces itself again — a second `omp:ready`, a panel brought to
	 * the front — is re-sent the *same* secret rather than a rotated one, so a
	 * delivery that was lost in transit is recoverable without breaking the page's
	 * existing bridge connection.
	 */
	async delivery(): Promise<BridgeBootstrapDelivery | null> {
		const documentId = this.#current;
		const port = this.#listener?.port ?? null;
		if (this.#closed || documentId === null || port === null) return null;
		const committed = this.#committed.get(documentId);
		if (committed === undefined) return null;
		try {
			const record = await this.#records.readDocument(this.#scope, documentId);
			const secret = await this.#records.readSecret(this.#scope, documentId);
			if (record === null || secret === null || record.port !== port) return null;
			return {
				documentId,
				bootstrapId: record.bootstrapId,
				port,
				origin: record.origin,
				bindingHash: record.bindingHash,
				secret,
			};
		} catch {
			return null;
		}
	}

	/** The binding the current document was committed against, or `null`. */
	committedBinding(): BridgeNativeBinding | null {
		const documentId = this.#current;
		return documentId === null ? null : this.#committed.get(documentId)?.binding ?? null;
	}

	/** The binding hash the current document authenticates with, or `null`. */
	committedBindingHash(): string | null {
		const documentId = this.#current;
		return documentId === null ? null : this.#committed.get(documentId)?.bindingHash ?? null;
	}

	/** Every exact native check for the current document passed, or stopped passing. */
	nativeReady(ready: boolean): void {
		this.document?.route.nativeReady(ready);
	}

	/** The exact `WebviewPanel` handle for the current document exists again. */
	panelBound(): void {
		this.document?.route.panelBound();
	}

	/**
	 * Select the bridge as the current document's route and offer it to the page.
	 *
	 * A surviving page may not have reconnected yet — after a host restart it is
	 * precisely the page that has to dial in — so the offer is remembered and
	 * re-sent the moment a session for this document authenticates.
	 */
	offerBridge(): string | null {
		const document = this.document;
		if (document === null || this.#closed) return null;
		const routeGeneration = document.route.offer("bridge");
		this.#sendOffer(document, routeGeneration);
		return routeGeneration;
	}

	/** Select the panel as the current document's route. The caller posts the offer. */
	offerPanel(): string | null {
		const document = this.document;
		if (document === null || this.#closed) return null;
		document.route.panelBound();
		this.#clearGuestVersion(document.documentId);
		return document.route.offer("panel");
	}

	#sendOffer(document: BridgeEditorDocument, routeGeneration: string): void {
		const wasAccepted = this.guestVersionAccepted(document.documentId);
		this.#clearGuestVersion(document.documentId);
		if (wasAccepted) this.#hooks.onStateChanged?.(document.documentId, document.route.state);
		const session = this.#sessions.get(document.documentId);
		if (session === undefined) return;
		session.send("route-offer", { routeGeneration, status: document.route.status() });
	}

	/** A page authenticated for one document of this editor. */
	noteSession(session: BridgeSession): void {
		const documentId = encodeHex(session.documentId);
		const document = this.#documents.get(documentId);
		if (document === undefined || !this.#hooks.eligible(documentId)) return;
		this.#clearGuestVersion(documentId);
		this.#sessions.set(documentId, session);
		document.route.bridgeAuthenticated();
		// The page needs the current route offer to acknowledge, whether this is its
		// first connection after a restart or a reconnect of its own.
		const routeGeneration = document.route.routeGeneration;
		if (routeGeneration !== null && document.route.offeredKind === "bridge") this.#sendOffer(document, routeGeneration);
	}

	/**
	 * Tell one document's page that the facts it read for a route are stale.
	 *
	 * Only the route the invalidation names may be cleared: an invalidation for a
	 * fenced generation must not make a page drop the correlation of the one it is
	 * actually using.
	 */
	invalidateRoute(documentId: string, routeGeneration: string | null): void {
		if (routeGeneration === null) return;
		const document = this.#documents.get(documentId);
		const session = this.#sessions.get(documentId);
		if (document === undefined || session === undefined || !document.route.isCurrentRoute(routeGeneration)) return;
		try {
			session.send("invalidate", { routeGeneration });
		} catch {
			/* the session may have gone away between the check and this send */
		}
	}

	/**
	 * Push one terminal message to one document's authenticated page, when it has one.
	 *
	 * The terminal renderer is only reachable over an authenticated session whose
	 * route the page has acknowledged: a push to a document with no such session is
	 * dropped rather than buffered, because the renderer that will consume it
	 * re-attaches and re-asks for the state it needs.
	 */
	pushTerminal(documentId: string, payload: unknown): boolean {
		if (!this.guestVersionAccepted(documentId)) return false;
		const document = this.#documents.get(documentId);
		const session = this.#sessions.get(documentId);
		if (document === undefined || session === undefined) return false;
		const routeGeneration = document.route.routeGeneration;
		if (routeGeneration === null) return false;
		session.send("terminal", { routeGeneration, payload });
		return true;
	}

	/** Stream one replaceable snapshot through the current acknowledged bridge. */
	pushSnapshot(documentId: string, messages: Iterable<unknown>): boolean {
		if (!this.guestVersionAccepted(documentId)) return false;
		const document = this.#documents.get(documentId);
		const session = this.#sessions.get(documentId);
		const route = document?.route.routeGeneration;
		if (session === undefined || route === null || route === undefined) return false;
		return session.sendSnapshot(route, messages);
	}

	/** Retire one document: its credential stops authenticating immediately. */
	async retireDocument(documentId: string): Promise<void> {
		this.#clearGuestVersion(documentId);
		this.#documents.get(documentId)?.route.retire();
		this.#documents.delete(documentId);
		this.#committed.delete(documentId);
		this.#sessions.delete(documentId);
		if (this.#current === documentId) this.#current = null;
		try {
			await this.#records.retire(this.#scope, documentId);
		} catch {
			/* an unreadable record tree is not repaired by a retry here */
		}
	}

	/**
	 * Forget this editor entirely: called only for a close this window observed.
	 *
	 * Another window's editor — even one carrying a copied `E` — is never touched:
	 * the caller can only name an editor whose close it saw.
	 */
	async forget(): Promise<void> {
		this.close();
		try {
			await this.#records.forget(this.#scope);
		} catch {
			/* the records are gone with the editor's own directory, or not at all */
		}
	}
}

/** The fields a binding must carry before it can be hashed and persisted. */
function bindingCheck(binding: BridgeNativeBinding): void {
	if (!Number.isInteger(binding.pid) || binding.pid <= 0) throw new TypeError("a native binding must name a process");
	if (binding.slot.length === 0 || binding.brokerGeneration.length === 0) throw new TypeError("a native binding must name a broker slot and generation");
}

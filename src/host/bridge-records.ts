/**
 * Durable, individually immutable records behind the host bridge (ADR-0023).
 *
 * One editor `E` owns one exact loopback listener, and everything that listener
 * needs to come back after an extension-host restart lives here, under the
 * extension's private storage:
 *
 * - `bridge/v1/<W>/<T token>/<E>/endpoint` — `{v,W,T,E,port}`. Written once,
 *   before the editor renders; the port named here is the *only* port that
 *   editor's listener may bind again.
 * - `bridge/v1/<W>/<T token>/<E>/<D>.json` — the complete document descriptor
 *   `{v,W,T,E,D,port,path,origin,bootstrapId,nativeBinding,bindingHash}`, written
 *   only after the pinned Origin and the chat-host binding `B0` have been
 *   verified, so its presence is exactly "this document may authenticate".
 * - `bridge/v1/<W>/<T token>/<E>/manifest.json` — the one current document and
 *   its `prepared | committed | retired` state. A `prepared` manifest may name a
 *   `D` whose descriptor does not exist yet; `committed` requires it.
 * - `SecretStorage` key `omp.bridge.v1/<W>/<T>/<E>/<D>` — the independent 32-byte
 *   browser reconnect secret `K`, base64url. Only the listener owner of that `E`
 *   writes it, and only that `D` can authenticate with it.
 *
 * The rules this module enforces, because everything above is a *credential
 * authority* rather than a registry:
 *
 * - records are immutable: writing a different value over an existing file is a
 *   refusal, not an update;
 * - a descriptor is only readable when its manifest says `committed` and every
 *   field matches the path and the endpoint it is filed under;
 * - only the caller's own `E` is ever touched. Nothing here enumerates another
 *   editor's records to "clean up" them: a cross-window sweep is exactly how one
 *   window would delete a credential another window is using.
 *
 * `W` and `T` are hashed/tokenized for the filesystem (a tab id contains a colon,
 * which no file name may carry) exactly as {@link bridgeViewType} tokenizes them,
 * so the record tree and the viewType agree about which editor is which.
 */

import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { retryWindowsFileOperation } from "./file-operation-retry.ts";
import { BRIDGE_PATH, BRIDGE_SECRET_BYTES, asciiJsonText, decodeBase64Url, encodeBase64Url, encodeHex, sha256 } from "../bridge-protocol.ts";
import { isBridgeTabId, tabIdToken } from "../bridge-identity.ts";

/** Record schema version; a mismatch is refused rather than migrated. */
export const BRIDGE_RECORD_VERSION = 1;

/** State of the one document a manifest names. */
export type BridgeManifestState = "prepared" | "committed" | "retired";

/** Refusal from the record layer, with a bounded code. */
export type BridgeRecordErrorCode = "invalid" | "immutable" | "missing" | "unreadable" | "not-committed";

/** The records module's only failure type. */
export class BridgeRecordError extends Error {
	readonly code: BridgeRecordErrorCode;

	constructor(code: BridgeRecordErrorCode, message: string) {
		super(message);
		this.name = "BridgeRecordError";
		this.code = code;
	}
}

/** The secret store the records use; `SecretStorage` satisfies it structurally. */
export interface BridgeSecretStore {
	/** `PromiseLike`, so a VS Code `SecretStorage` (which returns `Thenable`) fits. */
	get(key: string): PromiseLike<string | undefined>;
	store(key: string, value: string): PromiseLike<void>;
	delete(key: string): PromiseLike<void>;
}

/** Everything the record layer needs to know about its own namespace. */
export interface BridgeRecordScope {
	/** Canonical workspace hash (`W`), 64 lowercase hex. */
	readonly workspace: string;
	/** Indexed tab id (`T`), `tab:<uuid>`. */
	readonly tabId: string;
	/** Actual editor id (`E`), 32 lowercase hex. */
	readonly editorId: string;
}

/** One editor's exact endpoint. */
export interface BridgeEndpointRecord {
	readonly v: 1;
	readonly W: string;
	readonly T: string;
	readonly E: string;
	/** The exact loopback port this editor's listener must rebind. */
	readonly port: number;
}

/** The state of one document. */
export interface BridgeManifestRecord {
	readonly v: 1;
	readonly W: string;
	readonly T: string;
	readonly E: string;
	/** Current document incarnation, 32 lowercase hex. */
	readonly D: string;
	readonly state: BridgeManifestState;
}

/** The chat-host binding the guest acknowledged, fixed so its hash is stable. */
export interface BridgeNativeBinding {
	readonly ownerGeneration: string;
	/** The chat child's pid. */
	readonly pid: number;
	/** The chat child's kernel creation time. */
	readonly processCreation: string;
	/** The durable broker slot the child runs under. */
	readonly slot: string;
	readonly brokerId: string;
	readonly brokerGeneration: string;
	readonly sessionId: string | null;
	readonly sessionFile: string | null;
}

/** The complete descriptor one committed document authenticates against. */
export interface BridgeDocumentRecord {
	readonly v: 1;
	readonly W: string;
	readonly T: string;
	readonly E: string;
	readonly D: string;
	readonly port: number;
	readonly path: string;
	/** The canonical Webview Origin this document reported over the panel route. */
	readonly origin: string;
	/** Correlation id of the bootstrap message that carried this document's secret. */
	readonly bootstrapId: string;
	readonly nativeBinding: BridgeNativeBinding;
	/** Lowercase SHA-256 hex over the canonical encoding of `nativeBinding`. */
	readonly bindingHash: string;
}

/** One document's secret, with its scope, as read back. */
export interface BridgeSecretRecord {
	readonly scope: BridgeRecordScope;
	readonly documentId: string;
	readonly secret: Uint8Array;
}

const HEX64_RE = /^[0-9a-f]{64}$/;
const HEX32_RE = /^[0-9a-f]{32}$/;
const INTEGER_RE = /^[0-9]{1,15}$/;

function refuse(code: BridgeRecordErrorCode, message: string): never {
	throw new BridgeRecordError(code, message);
}

/** One field of a persisted record, or `undefined`; no shape is claimed. */
function field(source: object, name: string): unknown {
	if (!(name in source)) return undefined;
	const value: unknown = Reflect.get(source, name);
	return value;
}

function requireHex(value: unknown, pattern: RegExp, what: string): string {
	if (typeof value !== "string" || !pattern.test(value)) refuse("invalid", `${what} is not canonical lowercase hex.`);
	return value;
}

function requirePort(value: unknown): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0 || value > 65535) {
		refuse("invalid", "A bridge record names a port that is not a legal TCP port.");
	}
	return value;
}

function requireText(value: unknown, what: string, maxLength: number): string {
	if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
		refuse("invalid", `${what} is not a bounded non-empty string.`);
	}
	return value;
}

/** Narrow a persisted record to an object; every field is still read one by one. */
function requireObject(value: unknown): object {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		refuse("invalid", "A bridge record is not an object.");
	}
	return value;
}

/** Every record must name the workspace, tab and editor it is filed under. */
function requireScope(record: object, expected: BridgeRecordScope, what: string): void {
	if (field(record, "v") !== BRIDGE_RECORD_VERSION) refuse("invalid", `${what} does not carry this record version.`);
	if (field(record, "W") !== expected.workspace || field(record, "E") !== expected.editorId) {
		refuse("invalid", `${what} names a different workspace or editor than the path it was filed under.`);
	}
	const tabId = field(record, "T");
	if (typeof tabId !== "string" || tabId.toLowerCase() !== expected.tabId.toLowerCase()) {
		refuse("invalid", `${what} names a different tab than the path it was filed under.`);
	}
}

function parseEndpoint(value: unknown, scope: BridgeRecordScope): BridgeEndpointRecord {
	const record = requireObject(value);
	requireScope(record, scope, "the endpoint record");
	return {
		v: BRIDGE_RECORD_VERSION,
		W: scope.workspace,
		T: scope.tabId,
		E: scope.editorId,
		port: requirePort(field(record, "port")),
	};
}

function parseManifest(value: unknown, scope: BridgeRecordScope): BridgeManifestRecord {
	const record = requireObject(value);
	requireScope(record, scope, "the manifest");
	const state = field(record, "state");
	if (state !== "prepared" && state !== "committed" && state !== "retired") {
		refuse("invalid", "A bridge manifest names a state this version does not define.");
	}
	return {
		v: BRIDGE_RECORD_VERSION,
		W: scope.workspace,
		T: scope.tabId,
		E: scope.editorId,
		D: requireHex(field(record, "D"), HEX32_RE, "the manifest document id"),
		state,
	};
}

function parseNativeBinding(value: unknown): BridgeNativeBinding {
	const binding = requireObject(value);
	const pid = field(binding, "pid");
	if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) refuse("invalid", "The recorded native binding names no process.");
	const ownerGeneration = field(binding, "ownerGeneration");
	if (typeof ownerGeneration !== "string" || ownerGeneration.length === 0) {
		refuse("invalid", "The recorded native binding names no owner generation.");
	}
	const sessionId = field(binding, "sessionId");
	const sessionFile = field(binding, "sessionFile");
	if (sessionId !== null && typeof sessionId !== "string") refuse("invalid", "The recorded native binding has no usable session id.");
	if (sessionFile !== null && typeof sessionFile !== "string") refuse("invalid", "The recorded native binding has no usable session file.");
	return {
		ownerGeneration,
		pid,
		processCreation: requireText(field(binding, "processCreation"), "the recorded process creation time", 64),
		slot: requireText(field(binding, "slot"), "the recorded broker slot", 200),
		brokerId: requireText(field(binding, "brokerId"), "the recorded broker id", 200),
		brokerGeneration: requireText(field(binding, "brokerGeneration"), "the recorded broker generation", 200),
		sessionId,
		sessionFile,
	};
}

function parseDocument(value: unknown, scope: BridgeRecordScope): BridgeDocumentRecord {
	const record = requireObject(value);
	requireScope(record, scope, "the document descriptor");
	return {
		v: BRIDGE_RECORD_VERSION,
		W: scope.workspace,
		T: scope.tabId,
		E: scope.editorId,
		D: requireHex(field(record, "D"), HEX32_RE, "the document descriptor id"),
		port: requirePort(field(record, "port")),
		path: requireText(field(record, "path"), "the document descriptor path", 200),
		origin: requireText(field(record, "origin"), "the document descriptor origin", 300),
		bootstrapId: requireHex(field(record, "bootstrapId"), HEX32_RE, "the document descriptor bootstrap id"),
		nativeBinding: parseNativeBinding(field(record, "nativeBinding")),
		bindingHash: requireHex(field(record, "bindingHash"), HEX64_RE, "the document binding hash"),
	};
}

/**
 * The canonical text of one chat-host binding.
 *
 * Fixed field order, one tagged array, and every text field escaped to printable
 * ASCII (the same escape the wire uses for a payload field), so the hash is stable
 * across platforms and cannot be confused by a field that happens to contain the
 * separators another encoding would use. `null` (an absent session id or file) is
 * JSON `null`, which no string value can produce.
 */
export function nativeBindingText(binding: BridgeNativeBinding): string {
	return asciiJsonText([
		"omp-webview-bridge-native",
		BRIDGE_RECORD_VERSION,
		binding.ownerGeneration,
		binding.pid,
		binding.processCreation,
		binding.slot,
		binding.brokerId,
		binding.brokerGeneration,
		binding.sessionId,
		binding.sessionFile,
	]);
}

/** Lowercase SHA-256 hex over {@link nativeBindingText}. */
export async function bindingHashFor(binding: BridgeNativeBinding): Promise<string> {
	return encodeHex(await sha256(new TextEncoder().encode(nativeBindingText(binding))));
}

/**
 * Whether a binding recorded earlier still describes the live chat host.
 *
 * Every field is compared: a recovered orphan is only given current authority when the same
 * owner generation, chat process generation (pid *and* kernel creation time), broker slot,
 * broker id and generation, and exact session identity are all still the current ones. A
 * re-launched process or a restarted broker is a *different* identity, not a stale reading of
 * the same one.
 */
export function bindingMatches(recorded: BridgeNativeBinding, live: BridgeNativeBinding): boolean {
	return (
		recorded.ownerGeneration === live.ownerGeneration &&
		recorded.pid === live.pid &&
		recorded.processCreation === live.processCreation &&
		recorded.slot === live.slot &&
		recorded.brokerId === live.brokerId &&
		recorded.brokerGeneration === live.brokerGeneration &&
		recorded.sessionId === live.sessionId &&
		recorded.sessionFile === live.sessionFile
	);
}

/**
 * The records of one workspace, keyed by editor.
 *
 * `root` is the `bridge/v1` directory under the extension's private storage;
 * `secrets` is the extension's `SecretStorage`.
 */
export class BridgeRecords {
	readonly #root: string;
	readonly #secrets: BridgeSecretStore;

	constructor(options: { readonly root: string; readonly secrets: BridgeSecretStore }) {
		this.#root = path.resolve(options.root);
		this.#secrets = options.secrets;
	}

	/** Absolute directory holding one editor's records. */
	directoryFor(scope: BridgeRecordScope): string {
		this.#assertScope(scope);
		return path.join(this.#root, scope.workspace, tabIdToken(scope.tabId), scope.editorId);
	}

	/** The secret key of one document. A key, not a path: the tab id may keep its colon. */
	secretKeyFor(scope: BridgeRecordScope, documentId: string): string {
		this.#assertScope(scope);
		if (!HEX32_RE.test(documentId)) refuse("invalid", "A bridge document id is not 32 lowercase hex characters.");
		return `omp.bridge.v1/${scope.workspace}/${scope.tabId.toLowerCase()}/${scope.editorId}/${documentId}`;
	}

	/**
	 * The workspace hash this editor's own records are filed under.
	 *
	 * An editor's endpoint, documents and secrets are filed under the workspace hash `W`
	 * that existed when they were minted, and a surviving page keeps presenting exactly
	 * that `W` and port. A window's workspace hash is *not* stable, though: it names the
	 * folders open now, so opening or closing a folder (an empty window becoming a
	 * workspace, a folder added to or removed from a multi-root workspace) restarts the
	 * extension host under a new hash while every already-loaded page lives on. Looking
	 * the editor's records up only under the current hash would find nothing, leave those
	 * pages with no document to authenticate against and give them a second, unrelated
	 * port.
	 *
	 * So the editor's own `(T, E)` directory is looked up under every workspace hash and
	 * the one written most recently wins; `preferred` (the current hash) wins a tie and
	 * is the answer for an editor that has no records anywhere. Only this editor's
	 * directory is ever inspected — `E` is a random 128-bit token that exists in exactly
	 * one window — and nothing is moved, rewritten or deleted.
	 */
	async homeWorkspace(tabId: string, editorId: string, preferred: string): Promise<string> {
		this.#assertScope({ workspace: preferred, tabId, editorId });
		let names: string[];
		try {
			names = await fsp.readdir(this.#root);
		} catch {
			return preferred;
		}
		let best = preferred;
		let bestTime = -1;
		for (const name of [preferred, ...names.filter(entry => entry !== preferred)]) {
			if (!HEX64_RE.test(name)) continue;
			const directory = path.join(this.#root, name, tabIdToken(tabId), editorId);
			let newest = -1;
			for (const file of ["manifest.json", "endpoint"]) {
				try {
					newest = Math.max(newest, (await fsp.stat(path.join(directory, file))).mtimeMs);
				} catch {
					/* this workspace holds no such record for the editor */
				}
			}
			if (newest > bestTime) {
				best = name;
				bestTime = newest;
			}
		}
		return best;
	}

	#assertScope(scope: BridgeRecordScope): void {
		if (!HEX64_RE.test(scope.workspace)) refuse("invalid", "A bridge workspace hash is not 64 lowercase hex characters.");
		if (!isBridgeTabId(scope.tabId)) refuse("invalid", "A bridge tab id must be tab:<uuid>.");
		if (!HEX32_RE.test(scope.editorId)) refuse("invalid", "A bridge editor id is not 32 lowercase hex characters.");
	}

	async readEndpoint(scope: BridgeRecordScope): Promise<BridgeEndpointRecord | null> {
		const value = await this.#readJson(path.join(this.directoryFor(scope), "endpoint"));
		return value === null ? null : parseEndpoint(value, scope);
	}

	/**
	 * Record this editor's exact port. Immutable: a different port over an
	 * existing endpoint is a refusal, because that port is the resource lease the
	 * surviving page knows about.
	 */
	async writeEndpoint(scope: BridgeRecordScope, port: number): Promise<BridgeEndpointRecord> {
		const record: BridgeEndpointRecord = {
			v: BRIDGE_RECORD_VERSION,
			W: scope.workspace,
			T: scope.tabId,
			E: scope.editorId,
			port: requirePort(port),
		};
		await this.#writeImmutable(path.join(this.directoryFor(scope), "endpoint"), record);
		return record;
	}

	async readManifest(scope: BridgeRecordScope): Promise<BridgeManifestRecord | null> {
		const value = await this.#readJson(path.join(this.directoryFor(scope), "manifest.json"));
		return value === null ? null : parseManifest(value, scope);
	}

	/** Name a document as prepared. A prepared manifest may precede its descriptor. */
	async writePrepared(scope: BridgeRecordScope, documentId: string): Promise<BridgeManifestRecord> {
		const manifest: BridgeManifestRecord = {
			v: BRIDGE_RECORD_VERSION,
			W: scope.workspace,
			T: scope.tabId,
			E: scope.editorId,
			D: requireHex(documentId, HEX32_RE, "the manifest document id"),
			state: "prepared",
		};
		await this.#writeAtomically(path.join(this.directoryFor(scope), "manifest.json"), manifest);
		return manifest;
	}

	/**
	 * Write one document's complete descriptor and commit its manifest.
	 *
	 * The caller MUST have verified the pinned Origin and the chat-host
	 * binding first: this is the moment a document becomes able to authenticate.
	 */
	async commitDocument(scope: BridgeRecordScope, descriptor: BridgeDocumentRecord): Promise<void> {
		const manifest = await this.readManifest(scope);
		if (manifest === null || manifest.D !== descriptor.D) {
			refuse("not-committed", "A document descriptor may only be committed for the document its manifest names.");
		}
		const existing = await this.#readJson(path.join(this.directoryFor(scope), `${descriptor.D}.json`));
		if (existing !== null && JSON.stringify(existing) !== JSON.stringify(descriptor)) {
			refuse("immutable", "A committed document descriptor is immutable.");
		}
		await this.#writeAtomically(path.join(this.directoryFor(scope), `${descriptor.D}.json`), descriptor);
		await this.#writeAtomically(path.join(this.directoryFor(scope), "manifest.json"), {
			v: BRIDGE_RECORD_VERSION,
			W: scope.workspace,
			T: scope.tabId,
			E: scope.editorId,
			D: descriptor.D,
			state: "committed",
		} satisfies BridgeManifestRecord);
	}

	/** Store one document's independent reconnect secret. */
	async writeSecret(scope: BridgeRecordScope, documentId: string, secret: Uint8Array): Promise<void> {
		if (secret.length !== BRIDGE_SECRET_BYTES) refuse("invalid", "A bridge document secret must be 32 bytes.");
		await this.#secrets.store(this.secretKeyFor(scope, documentId), encodeBase64Url(secret));
	}

	/**
	 * The secret one document may authenticate with, or `null`.
	 *
	 * A secret is only returned for a *committed* document whose manifest names
	 * exactly this id, so a crashed or half-written bootstrap cannot authenticate.
	 */
	async readSecret(scope: BridgeRecordScope, documentId: string): Promise<Uint8Array | null> {
		const manifest = await this.readManifest(scope);
		if (manifest === null || manifest.state !== "committed" || manifest.D !== documentId) return null;
		const stored = await this.#secrets.get(this.secretKeyFor(scope, documentId));
		if (stored === undefined) return null;
		try {
			return decodeBase64Url(stored, BRIDGE_SECRET_BYTES);
		} catch {
			return null;
		}
	}

	/**
	 * The descriptor one document authenticates against, or `null`.
	 *
	 * Every field is cross-checked against the path it was filed under and against
	 * the manifest's committed document id.
	 */
	async readDocument(scope: BridgeRecordScope, documentId: string): Promise<BridgeDocumentRecord | null> {
		if (!HEX32_RE.test(documentId)) return null;
		const manifest = await this.readManifest(scope);
		if (manifest === null || manifest.state !== "committed" || manifest.D !== documentId) return null;
		const endpoint = await this.readEndpoint(scope);
		if (endpoint === null) return null;
		const value = await this.#readJson(path.join(this.directoryFor(scope), `${documentId}.json`));
		if (value === null) return null;
		const descriptor = parseDocument(value, scope);
		if (descriptor.D !== documentId || descriptor.port !== endpoint.port) return null;
		if (descriptor.path !== BRIDGE_PATH) return null;
		return descriptor;
	}

	/**
	 * Retire one document: tombstone the manifest and delete only its secret.
	 *
	 * The descriptor is deliberately left in place — it is inert without its
	 * secret, and leaving it makes a post-mortem possible. Nothing here touches
	 * another document's or another editor's records.
	 */
	async retire(scope: BridgeRecordScope, documentId: string): Promise<void> {
		const manifest = await this.readManifest(scope);
		if (manifest !== null && manifest.D === documentId) {
			await this.#writeAtomically(path.join(this.directoryFor(scope), "manifest.json"), {
				v: BRIDGE_RECORD_VERSION,
				W: scope.workspace,
				T: scope.tabId,
				E: scope.editorId,
				D: documentId,
				state: "retired",
			} satisfies BridgeManifestRecord);
		}
		await this.#secrets.delete(this.secretKeyFor(scope, documentId));
	}

	/**
	 * Remove the records of one editor this window closed.
	 *
	 * Only ever called for an `E` whose close this window observed; the records of
	 * a different editor — including a copied one — are left exactly as they are.
	 */
	async forget(scope: BridgeRecordScope): Promise<void> {
		const directory = this.directoryFor(scope);
		const manifest = await this.readManifest(scope);
		if (manifest !== null) await this.#secrets.delete(this.secretKeyFor(scope, manifest.D));
		await fsp.rm(directory, { recursive: true, force: true });
	}

	/** The endpoint's exact port, or `null` when nothing is recorded yet. */
	async recordedPort(scope: BridgeRecordScope): Promise<number | null> {
		const endpoint = await this.readEndpoint(scope);
		return endpoint === null ? null : endpoint.port;
	}

	async #readJson(file: string): Promise<unknown | null> {
		let text: string;
		try {
			text = await fsp.readFile(file, "utf8");
		} catch (error) {
			if ((error as { code?: unknown }).code === "ENOENT") return null;
			refuse("unreadable", "A bridge record could not be read.");
		}
		try {
			return JSON.parse(text) as unknown;
		} catch {
			refuse("unreadable", "A bridge record is not valid JSON.");
		}
	}

	/** Write once: an existing different value is refused, identical bytes are a no-op. */
	async #writeImmutable(file: string, value: unknown): Promise<void> {
		const existing = await this.#readJson(file);
		if (existing !== null) {
			if (JSON.stringify(existing) === JSON.stringify(value)) return;
			refuse("immutable", "A bridge record already exists with a different value.");
		}
		await this.#writeAtomically(file, value);
	}

	/** Write a record through a private temporary file and one rename. */
	async #writeAtomically(file: string, value: unknown): Promise<void> {
		await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
		const temporary = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
		await fsp.writeFile(temporary, `${JSON.stringify(value, null, "\t")}\n`, { encoding: "utf8", mode: 0o600 });
		try {
			await retryWindowsFileOperation(() => fsp.rename(temporary, file));
		} finally {
			await fsp.rm(temporary, { force: true }).catch(() => undefined);
		}
	}
}

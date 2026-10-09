/**
 * The whole bridge, end to end: the real listener, the real records and the real
 * guest client, in one process.
 *
 * This is the transport-level end-to-end test, with no mock in the path: the
 * guest client is the same module the Webview bundle runs (it is environment
 * neutral — `WebSocket` and `crypto.subtle` are the same on both sides), the
 * listener binds a real exclusive loopback port, and the durable records are real
 * files with a real secret store. It defends the acceptance path itself:
 *
 * - a page authenticates with its document's own secret and is offered a route;
 * - a request is admitted only after the route generation is acknowledged, and is
 *   answered exactly once;
 * - a replay, a foreign secret, an uncommitted document and a retired credential
 *   all fail closed without evicting the live session;
 * - a host-only restart — a new listener on exactly the recorded port, a fresh host
 *   generation — is what the surviving page reconnects into.
 *
 * The waits are event-driven: each observation resolves the promise a test is
 * waiting on, and the bounded guard exists only so a stuck test fails instead of
 * hanging the suite.
 *
 * Runner: `node --test src/host/bridge-e2e.test.ts`
 */

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { BridgeEditorEndpoint, BRIDGE_GUEST_RELOAD_REASON } from "./bridge-endpoint.ts";
import { BridgeRecords, bindingHashFor } from "./bridge-records.ts";
import type { BridgeEndpointState } from "./bridge-route.ts";
import type { BridgeNativeBinding, BridgeRecordScope } from "./bridge-records.ts";
import { BridgeClient } from "../webview/lib/bridge-client.ts";
import type { BridgeClientEndpoint, BridgeClientHooks } from "../webview/lib/bridge-client.ts";
import { GUEST_PROTOCOL_VERSION, parseGuestHostMessage } from "../webview/messages.ts";
import { applyChatState, createChatModel } from "../chat/model.ts";
import { BRIDGE_DIRECTION_SERVER_TO_CLIENT, encodeBase64Url, frameKeys, openFrame, parseAndVerifyChallenge, parseHello, parseTerminalPush, parseTextFrame } from "../bridge-protocol.ts";
import { BRIDGE_ROUTE_ACK_TIMEOUT_MS } from "./bridge-route.ts";
import type { BridgeChallenge, BridgeHello } from "../bridge-protocol.ts";

/** Independently decrypt wire pushes, before the guest hides fragment envelopes. */
function wireTap(socket: WebSocket, secret: Uint8Array): { payloads: unknown[]; drain(): Promise<void> } {
	const payloads: unknown[] = [];
	let hello: BridgeHello;
	let challenge: BridgeChallenge;
	let key: Uint8Array;
	let chain = Promise.resolve();
	const send = socket.send.bind(socket);
	socket.send = data => {
		if (typeof data === "string" && JSON.parse(data)[0] === "hello") hello = parseHello(data);
		send(data);
	};
	socket.addEventListener("message", event => {
		chain = chain.then(async () => {
			if (typeof event.data === "string") {
				const verified = await parseAndVerifyChallenge(event.data, secret, {
					workspace: hello.workspace, tabId: hello.tabId, editorId: encodeBase64Url(hello.editorId),
					documentId: encodeBase64Url(hello.documentId), bindingHash: hello.bindingHash, clientNonce: encodeBase64Url(hello.clientNonce),
					port: Number(new URL(socket.url).port), origin: ORIGIN, serverNonce: "", hostGeneration: "", connectionId: "",
				});
				challenge = verified.challenge;
				key = (await frameKeys(secret, verified.transcriptText)).serverToClient;
				return;
			}
			const opened = await openFrame({ key, frame: new Uint8Array(event.data as ArrayBuffer), expectedDirection: BRIDGE_DIRECTION_SERVER_TO_CLIENT,
				hostGeneration: challenge.hostGeneration, connectionId: challenge.connectionId, documentId: hello.documentId });
			const frame = parseTextFrame(opened.plaintext);
			assert.ok(Array.isArray(frame));
			if (frame[0] === "terminal") payloads.push(parseTerminalPush(frame)!.payload);
		});
	});
	return { payloads, drain: () => chain };
}

const WORKSPACE = "a".repeat(64);
const TAB = "tab:11111111-2222-3333-4444-555555555555";
const EDITOR = "b".repeat(32);
const DOCUMENT = "c".repeat(32);
const BOOTSTRAP = "d".repeat(32);
const ORIGIN = "vscode-webview://0r42vg5knjjkub1td6sq2sg4ggjt4ovjpvcnij5lj62f9k001mi3";
const SCOPE: BridgeRecordScope = { workspace: WORKSPACE, tabId: TAB, editorId: EDITOR };
/** A guard, not a duration: it fires only when an expected observation never comes. */
const GUARD_MS = 8_000;

/** Node's `WebSocket` accepts an options object the DOM constructor type omits. */
const NodeWebSocket = WebSocket as unknown as new (url: string, options: { readonly headers: Record<string, string> }) => WebSocket;

const hosts: BridgeEditorEndpoint[] = [];
const clients: BridgeClient[] = [];
const scratch: string[] = [];

after(async () => {
	for (const client of clients) client.stop();
	for (const host of hosts) host.close();
	for (const directory of scratch) await fs.rm(directory, { recursive: true, force: true });
});

/** The chat-host binding one document is committed against. */
function binding(overrides: Partial<BridgeNativeBinding> = {}): BridgeNativeBinding {
	return {
		ownerGeneration: "owner-1",
		pid: 4242,
		processCreation: "133700000000000000",
		slot: "slot-1",
		brokerId: "broker-1",
		brokerGeneration: "generation-7",
		sessionId: "session-1",
		sessionFile: "C:\\sessions\\session-1.jsonl",
		...overrides,
	};
}

/** A FIFO of observations: waiting for one costs no timer. */
class Queue<T> {
	readonly #items: T[] = [];
	readonly #waiters: ((item: T) => void)[] = [];

	push(item: T): void {
		const waiter = this.#waiters.shift();
		if (waiter === undefined) this.#items.push(item);
		else waiter(item);
	}

	next(): Promise<T> {
		const item = this.#items.shift();
		if (item !== undefined) return Promise.resolve(item);
		const { promise, resolve } = Promise.withResolvers<T>();
		this.#waiters.push(resolve);
		return promise;
	}
}

/** The next observation equal to `expected`, or a failure naming what never arrived. */
async function observedState(queue: Queue<BridgeEndpointState>, expected: BridgeEndpointState): Promise<void> {
	for (;;) {
		const state = await observed(queue, `the host to reach ${expected}`);
		if (state === expected) return;
	}
}

/** The next observation, or a failure naming what never arrived. */
async function observed<T>(queue: Queue<T>, what: string): Promise<T> {
	return await Promise.race([
		queue.next(),
		(async () => {
			await new Promise(resolve => setTimeout(resolve, GUARD_MS));
			throw new Error(`timed out waiting for ${what}`);
		})(),
	]);
}

/**
 * Durable records over one scratch directory.
 *
 * The secret store belongs to the store, not to the record tree: a `SecretStorage`
 * survives an extension-host restart exactly as the files do, so a "restart" in
 * these tests reopens the same records *and* the same secrets — otherwise the new
 * host would have no credential to authorize and every page would (correctly) be
 * refused.
 */
interface Store {
	readonly records: BridgeRecords;
	readonly root: string;
	readonly secrets: Map<string, string>;
}

async function store(): Promise<Store> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-bridge-"));
	scratch.push(root);
	const secrets = new Map<string, string>();
	return { records: openStore(root, secrets), root, secrets };
}

function openStore(root: string, secrets: Map<string, string>): BridgeRecords {
	return new BridgeRecords({
		root,
		secrets: {
			async get(key) {
				return secrets.get(key);
			},
			async store(key, value) {
				secrets.set(key, value);
			},
			async delete(key) {
				secrets.delete(key);
			},
		},
	});
}

/** One host endpoint serving one document, its route offered over the bridge. */
function startHost(records: BridgeRecords, hostGeneration: number, events: HostEvents, heartbeatMs?: number): BridgeEditorEndpoint {
	const host = new BridgeEditorEndpoint({
		records,
		scope: SCOPE,
		hostGeneration: new Uint8Array(16).fill(hostGeneration),
		...(heartbeatMs === undefined ? {} : { heartbeatMs }),
		eligible: documentId => documentId === DOCUMENT,
		onRequest: (session, documentId, request) => {
			assert.equal(documentId, DOCUMENT, "the listener admits only the document it authorized");
			events.admitted.push({ requestId: request.requestId, operation: request.operation });
			session.reply(request.requestId, { ok: true, operation: request.operation });
		},
		onStateChanged: (_documentId, state) => events.states.push(state),
	});
	hosts.push(host);
	return host;
}

/** One page: the guest client for one host document. */
async function page(
	port: number,
	secret: Uint8Array,
	overrides: Partial<BridgeClientEndpoint> = {},
	onMessage?: (payload: unknown) => void,
	captureWire = false,
): Promise<{
	readonly client: BridgeClient;
	readonly ready: Queue<string>;
	readonly offers: Queue<{ routeGeneration: string; status: string }>;
	readonly invalidations: Queue<string>;
	readonly replies: Queue<{ requestId: string; payload: unknown }>;
	readonly connection: Queue<boolean>;
	readonly connections: boolean[];
	readonly diagnostics: Queue<string>;
	readonly messages: Queue<unknown>;
	readonly wire: { payloads: unknown[]; drain(): Promise<void> }[];
}> {
	const ready = new Queue<string>();
	const offers = new Queue<{ routeGeneration: string; status: string }>();
	const invalidations = new Queue<string>();
	const replies = new Queue<{ requestId: string; payload: unknown }>();
	const connection = new Queue<boolean>();
	const diagnostics = new Queue<string>();
	const connections: boolean[] = [];
	const messages = new Queue<unknown>();
	const wire: { payloads: unknown[]; drain(): Promise<void> }[] = [];
	const hooks: BridgeClientHooks = {
		onReady: status => ready.push(status),
		onRouteOffer: (routeGeneration, status) => offers.push({ routeGeneration, status }),
		onInvalidate: routeGeneration => invalidations.push(routeGeneration),
		onReply: (requestId, payload) => replies.push({ requestId, payload }),
		onConnection: connected => { connections.push(connected); connection.push(connected); },
		onDiagnostic: code => diagnostics.push(code),
		onMessage: payload => { messages.push(payload); onMessage?.(payload); },
	};
	const endpoint: BridgeClientEndpoint = {
		workspace: WORKSPACE,
		tabId: TAB,
		editorId: EDITOR,
		documentId: DOCUMENT,
		port,
		origin: ORIGIN,
		bindingHash: await bindingHashFor(binding()),
		secret,
		// Node's WebSocket sends no Origin header of its own (the DOM type does not
		// declare the options object that carries one), and this listener pins exactly
		// the document's Origin, so the test supplies it.
		connect: url => {
			const socket = new NodeWebSocket(url, { headers: { origin: ORIGIN } });
			if (captureWire) wire.push(wireTap(socket, secret));
			return socket;
		},
		...overrides,
	};
	const client = new BridgeClient(endpoint, hooks);
	clients.push(client);
	return { client, ready, offers, invalidations, replies, connection, connections, diagnostics, messages, wire };
}

/** What a test can observe about one host's own route decisions. */
interface HostEvents {
	readonly states: Queue<BridgeEndpointState>;
	readonly admitted: Queue<{ requestId: string; operation: string }>;
}

/** A provisioned host: bound port, committed document, bridge route offered. */
async function provision(
	generation: number,
	existing?: Store,
	heartbeatMs?: number,
): Promise<{ readonly host: BridgeEditorEndpoint; readonly store: Store; readonly secret: Uint8Array; readonly events: HostEvents }> {
	const backing = existing ?? (await store());
	const events: HostEvents = { states: new Queue<BridgeEndpointState>(), admitted: new Queue<{ requestId: string; operation: string }>() };
	const host = startHost(backing.records, generation, events, heartbeatMs);
	const port = await host.bind();
	assert.ok(port !== null, "the editor's exact port must bind");
	const document = await host.beginDocument(DOCUMENT, BOOTSTRAP);
	assert.ok(document !== null, "a fresh document is prepared");
	assert.equal(host.pinOrigin(DOCUMENT, ORIGIN), true, "the document's canonical origin is pinned");
	const delivery = await host.commit(binding());
	assert.ok(delivery !== null, "a document with a pinned origin and a verified binding commits");
	host.nativeReady(true);
	assert.ok(host.offerBridge() !== null, "the bridge route is offered");
	return { host, store: backing, secret: delivery.secret, events };
}

async function announceVersion(guest: Awaited<ReturnType<typeof page>>, routeGeneration: string, payload: unknown): Promise<unknown> {
	const requestId = crypto.randomUUID().replaceAll("-", "");
	assert.equal(guest.client.request({ requestId, routeGeneration, actionSeq: "0", operation: "guest-version", payload }), true);
	const reply = await observed(guest.replies, "the read-only version reply");
	assert.equal(reply.requestId, requestId);
	return reply.payload;
}

function unsentSnapshot(): Iterable<unknown> {
	return { *[Symbol.iterator]() { throw new Error("an unproven guest must not enumerate a snapshot"); } };
}

describe("bridge transport end to end", () => {
	it("gives an old surviving page a bounded unfragmented Reload Window reason without attaching a snapshot", async context => {
		const { host, secret, events } = await provision(0x5a);
		const guest = await page(host.port ?? 0, secret, {}, undefined, true);
		guest.client.start();
		await observed(guest.ready, "the old page to authenticate");
		const route = await observed(guest.offers, "the route offer");
		context.mock.timers.enable({ apis: ["setTimeout"] });
		try {
			assert.equal(guest.client.acknowledgeRoute(route.routeGeneration), true);
			await observedState(events.states, "BRIDGE_READY");
			assert.equal(host.guestVersionAccepted(DOCUMENT), false);
			assert.equal(host.pushSnapshot(DOCUMENT, unsentSnapshot()), false);
			assert.equal(host.pushTerminal(DOCUMENT, { type: "omp:bridge-fragment" }), false);
			context.mock.timers.tick(BRIDGE_ROUTE_ACK_TIMEOUT_MS);
			const message = await observed(guest.messages, "the old page's actionable reason") as { type: string; phase: string; readOnlyReason: string };
			assert.equal(message.type, "omp:chat-state");
			assert.equal(message.phase, "blocked");
			assert.equal(message.readOnlyReason, BRIDGE_GUEST_RELOAD_REASON);
			assert.match(message.readOnlyReason, /Reload Window/);
			await guest.wire[0]!.drain();
			const parsed = parseGuestHostMessage(message);
			assert.ok(parsed?.type === "omp:chat-state", "the existing v8 payload parser accepts the recovery reason");
			const previous = createChatModel();
			previous.epoch = { nonce: "previous-host", counter: 7 };
			previous.phase = "live";
			previous.pendingEditorText = { text: "retained composer prefill", seq: 1 };
			const blocked = applyChatState(previous, parsed);
			assert.equal(blocked.readOnlyReason, BRIDGE_GUEST_RELOAD_REASON);
			assert.equal(blocked.pendingEditorText, previous.pendingEditorText);
			assert.equal(blocked.entries, previous.entries, "an old page keeps its existing transcript");
			assert.deepEqual(guest.wire[0]!.payloads, [message], "no fragment or transcript can reach an unproven page on the wire");
			assert.equal(guest.client.connected, true, "an old page does not enter an automatic reconnect loop");
			assert.deepEqual(await announceVersion(guest, route.routeGeneration, { protocolVersion: GUEST_PROTOCOL_VERSION, fragments: true }), { accepted: false });
			assert.equal(host.guestVersionAccepted(DOCUMENT), false, "a late announcement cannot undo the reload fence");
			assert.equal(host.pushSnapshot(DOCUMENT, unsentSnapshot()), false);
		} finally { context.mock.timers.reset(); guest.client.stop(); host.close(); }
	});

	for (const payload of [
		{ protocolVersion: GUEST_PROTOCOL_VERSION - 1, fragments: true },
		{ protocolVersion: GUEST_PROTOCOL_VERSION + 1, fragments: true },
		{ protocolVersion: GUEST_PROTOCOL_VERSION, fragments: false },
		{ protocolVersion: String(GUEST_PROTOCOL_VERSION), fragments: true },
		null,
	]) {
		it(`refuses an incompatible or malformed guest capability ${JSON.stringify(payload)}`, async () => {
			const { host, secret, events } = await provision(0x5a);
			const guest = await page(host.port ?? 0, secret, {}, undefined, true);
			try {
				guest.client.start();
				await observed(guest.ready, "authentication");
				const route = await observed(guest.offers, "a route offer");
				guest.client.acknowledgeRoute(route.routeGeneration);
				await observedState(events.states, "BRIDGE_READY");
				assert.deepEqual(await announceVersion(guest, route.routeGeneration, payload), { accepted: false });
				assert.equal(host.guestVersionAccepted(DOCUMENT), false);
				assert.equal(host.pushSnapshot(DOCUMENT, unsentSnapshot()), false);
				const message = await observed(guest.messages, "the reload reason");
				await guest.wire[0]!.drain();
				assert.deepEqual(guest.wire[0]!.payloads, [message]);
				assert.equal(guest.client.connected, true);
			} finally { guest.client.stop(); host.close(); }
		});
	}

	it("delivers complete large DTOs only after current-connection v9 proof and requires proof again on reconnect", async () => {
		const { host, secret, events } = await provision(0x5a);
		const payload = { type: "test-snapshot", tool: "t".repeat(950 * 1024), image: "a".repeat(900 * 1024) };
		let guest = await page(host.port ?? 0, secret, {}, undefined, true);
		try {
			for (let connection = 0; connection < 2; connection++) {
				guest.client.start();
				await observed(guest.ready, "authentication");
				const route = await observed(guest.offers, "a current connection's route offer");
				guest.client.acknowledgeRoute(route.routeGeneration);
				await observedState(events.states, "BRIDGE_READY");
				assert.equal(host.guestVersionAccepted(DOCUMENT), false, "a previous socket's proof cannot authorize this socket");
				assert.equal(host.pushSnapshot(DOCUMENT, unsentSnapshot()), false);
				assert.deepEqual(await announceVersion(guest, route.routeGeneration, { protocolVersion: GUEST_PROTOCOL_VERSION, fragments: true }), { accepted: true });
				assert.equal(host.guestVersionAccepted(DOCUMENT), true);
				assert.equal(host.pushSnapshot(DOCUMENT, [payload]), true);
				assert.deepEqual(await observed(guest.messages, "a complete large DTO"), payload);
				await guest.wire[0]!.drain();
				assert.ok(guest.wire[0]!.payloads.length > 1);
				assert.ok(guest.wire[0]!.payloads.every(message => (message as { type: string }).type === "omp:bridge-fragment"));
				guest.client.stop();
				await observedState(events.states, "DISCONNECTED");
				if (connection === 0) guest = await page(host.port ?? 0, secret, {}, undefined, true);
			}
		} finally { guest.client.stop(); host.close(); }
	});

	it("fences version proof on a new route and ignores a fully sealed stale-route announcement", async () => {
		const { host, secret, events } = await provision(0x5a);
		const guest = await page(host.port ?? 0, secret);
		try {
			guest.client.start();
			await observed(guest.ready, "authentication");
			const previous = await observed(guest.offers, "the original offer");
			guest.client.acknowledgeRoute(previous.routeGeneration);
			await observedState(events.states, "BRIDGE_READY");
			assert.deepEqual(await announceVersion(guest, previous.routeGeneration, { protocolVersion: GUEST_PROTOCOL_VERSION, fragments: true }), { accepted: true });
			const current = host.offerBridge();
			assert.ok(current);
			assert.notEqual(current, previous.routeGeneration);
			assert.equal(host.guestVersionAccepted(DOCUMENT), false);
			const offered = await observed(guest.offers, "the fresh route offer");
			assert.equal(offered.routeGeneration, current);
			guest.client.acknowledgeRoute(current);
			await observedState(events.states, "BRIDGE_READY");
			assert.equal(guest.client.request({ requestId: "8".repeat(32), routeGeneration: previous.routeGeneration, actionSeq: "0",
				operation: "guest-version", payload: { protocolVersion: GUEST_PROTOCOL_VERSION, fragments: true } }), true);
			assert.deepEqual(await announceVersion(guest, current, { protocolVersion: GUEST_PROTOCOL_VERSION, fragments: true }), { accepted: true },
				"the stale announcement has neither a reply nor an application/native effect");
			assert.equal(host.guestVersionAccepted(DOCUMENT), true);
			assert.equal(guest.client.connected, true);
		} finally { guest.client.stop(); host.close(); }
	});

	it("authenticates a document, offers a route and answers one acknowledged request", async () => {
		const { host, secret, events } = await provision(0x5a);
		const { client, ready, offers, replies, connection } = await page(host.port ?? 0, secret);
		client.start();
		assert.equal(await observed(ready, "the page to be authenticated"), "ready");
		const route = await observed(offers, "the host to offer the bridge route");
		assert.equal(route.status, "waiting", "the route is offered before the page acknowledges it");
		assert.equal(client.acknowledgeRoute(route.routeGeneration), true);
		assert.equal(client.connected, true);
		await observedState(events.states, "BRIDGE_READY");
		const requestId = "1".repeat(32);
		assert.equal(
			client.request({
				routeGeneration: route.routeGeneration,
				requestId,
				actionSeq: "1",
				operation: "control-snapshot",
				payload: { scope: "scope-1", requestId },
			}),
			true,
		);
		assert.deepEqual(await observed(events.admitted, "the host to admit the request"), { requestId, operation: "control-snapshot" });
		assert.deepEqual(await observed(replies, "the host's reply"), { requestId, payload: { ok: true, operation: "control-snapshot" } });
		assert.equal(await observed(connection, "the page to be told the connection is up"), true);
		assert.equal(host.routeFor(DOCUMENT)?.state, "BRIDGE_READY", "an acknowledged route with verified native checks is ready");
		assert.equal(host.routeFor(DOCUMENT)?.dispatchable, true);
	});

	it("keeps the authenticated route alive across encrypted heartbeat replies", async () => {
		const { host, secret } = await provision(0x5a, undefined, 20);
		const page0 = await page(host.port ?? 0, secret);
		page0.client.start();
		await observed(page0.ready, "the page to authenticate before its first heartbeat");
		const offer = await observed(page0.offers, "the route before its first heartbeat");
		assert.equal(page0.client.acknowledgeRoute(offer.routeGeneration), true);
		// This deliberately exercises the real loopback listener's independent
		// heartbeat timer; fake timers cannot drive the separate socket event loop.
		await delay(180);
		assert.deepEqual(page0.connections, [true], "several authenticated pings did not disconnect the page");
		assert.equal(host.routeFor(DOCUMENT)?.dispatchable, true);
		const requestId = "5".repeat(32);
		assert.equal(page0.client.request({ routeGeneration: offer.routeGeneration, requestId, actionSeq: "1", operation: "control-snapshot", payload: null }), true);
		assert.equal((await observed(page0.replies, "a reply after several heartbeats")).requestId, requestId);
	});

	it("fences an admitted mutation before the native send when its editor closes", async () => {
		const { host, secret, events } = await provision(0x5a);
		const page0 = await page(host.port ?? 0, secret);
		page0.client.start();
		await observed(page0.ready, "the page before editor close");
		const offer = await observed(page0.offers, "the route before editor close");
		assert.equal(page0.client.acknowledgeRoute(offer.routeGeneration), true);
		await observedState(events.states, "BRIDGE_READY");
		const route = host.routeFor(DOCUMENT);
		assert.ok(route !== null);
		// The queued native send holds this reservation while the editor closes.
		const pending = route.admit({ routeGeneration: offer.routeGeneration, actionSeq: "1", operation: "set-model", payload: { model: "a" } });
		host.close();
		assert.equal(route.state, "RETIRED");
		assert.throws(() => pending.verify(), { name: "BridgeAdmissionError", code: "retired" });
	});

	it("refuses a foreign secret, an uncommitted document and a foreign origin", async () => {
		const { host, secret } = await provision(0x5a);
		const foreign = await page(host.port ?? 0, new Uint8Array(32).fill(0x99));
		foreign.client.start();
		await observed(foreign.diagnostics, "the foreign secret to be refused");
		assert.equal(foreign.client.connected, false);

		const unknown = await page(host.port ?? 0, secret, { documentId: "e".repeat(32) });
		unknown.client.start();
		await observed(unknown.diagnostics, "the uncommitted document to be refused");
		assert.equal(unknown.client.connected, false);

		const foreignOrigin = await page(host.port ?? 0, secret, { origin: "vscode-webview://someone-else" });
		foreignOrigin.client.start();
		await observed(foreignOrigin.diagnostics, "the foreign origin to be refused");
		assert.equal(foreignOrigin.client.connected, false);
	});

	it("rejects an old credential once the document incarnation is replaced", async () => {
		const { host, secret } = await provision(0x5a);
		const survivor = await page(host.port ?? 0, secret);
		survivor.client.start();
		await observed(survivor.ready, "the first document to authenticate");

		const next = await host.beginDocument("f".repeat(32), "0".repeat(32));
		assert.ok(next !== null, "a replacement document is prepared");
		assert.equal(host.document?.documentId, "f".repeat(32), "the editor now serves the replacement");
		const retired = await page(host.port ?? 0, secret);
		retired.client.start();
		await observed(retired.diagnostics, "the retired credential to be refused");
		assert.equal(retired.client.connected, false, "a retired document's secret no longer authenticates");
	});

	it("reconnects a surviving page into a new host generation on exactly the recorded port", async () => {
		const first = await provision(0x5a);
		const port = first.host.port ?? 0;
		const page0 = await page(port, first.secret);
		page0.client.start();
		await observed(page0.ready, "the first connection");
		const firstOffer = await observed(page0.offers, "the first route offer");

		// A host-only restart: the extension host died and took its listener with it.
		// The page never stopped, so nothing is re-minted — the new host binds the
		// recorded port, adopts the surviving document and offers a fresh generation.
		first.host.close();
		const reopened = openStore(first.store.root, first.store.secrets);
		const restartedEvents: HostEvents = { states: new Queue<BridgeEndpointState>(), admitted: new Queue<{ requestId: string; operation: string }>() };
		const restarted = startHost(reopened, 0x7b, restartedEvents);
		const rebound = await restarted.bind();
		assert.equal(rebound, port, "the recorded port is rebound, never a different one");
		const adopted = await restarted.adoptDocument(DOCUMENT);
		assert.ok(adopted !== null, "the surviving document is adopted as it is");
		assert.equal(restarted.origin, ORIGIN, "the committed origin is used, not learned from the socket");
		assert.equal(restarted.nativeReady(true), undefined);
		assert.ok(restarted.offerBridge() !== null);

		assert.equal(await observed(page0.ready, "the page to reconnect to the new host generation"), "ready");
		const second = await observed(page0.offers, "the new host's route offer");
		assert.notEqual(second.routeGeneration, firstOffer.routeGeneration, "a new activation mints a fresh route generation");
		assert.equal(second.status, "waiting");
		assert.equal(page0.client.acknowledgeRoute(second.routeGeneration), true);
		await observedState(restartedEvents.states, "BRIDGE_READY");
		assert.equal(restarted.routeFor(DOCUMENT)?.dispatchable, true);
	});

	it("refuses a request whose route generation the page never acknowledged", async () => {
		const { host, secret } = await provision(0x5a);
		const page0 = await page(host.port ?? 0, secret);
		page0.client.start();
		await observed(page0.ready, "authentication");
		const route = await observed(page0.offers, "the route offer");
		page0.client.request({ routeGeneration: route.routeGeneration, requestId: "2".repeat(32), actionSeq: "1", operation: "control-snapshot", payload: null });
		assert.equal(await observed(page0.connection, "the page to report its connection"), true);
		assert.equal(await observed(page0.connection, "the host to close an unacknowledged request"), false);
		assert.equal(host.routeFor(DOCUMENT)?.acknowledged, false, "nothing was admitted under an unacknowledged route");
		assert.equal(host.routeFor(DOCUMENT)?.dispatchable, false);
	});

	it("re-offers the current generation when a page acknowledges a fenced one", async () => {
		const { host, secret, events } = await provision(0x5a);
		const page0 = await page(host.port ?? 0, secret);
		page0.client.start();
		await observed(page0.ready, "authentication");
		await observed(page0.offers, "the first offer");
		const current = host.routeFor(DOCUMENT)?.routeGeneration;
		const fenced = "9".repeat(32);
		assert.notEqual(current, fenced);
		page0.client.acknowledgeRoute(fenced);
		const reoffered = await observed(page0.offers, "the host to re-offer the current generation");
		assert.equal(reoffered.routeGeneration, current, "a fenced generation is refused and the current one offered instead");
		assert.equal(page0.client.acknowledgeRoute(reoffered.routeGeneration), true);
		await observedState(events.states, "BRIDGE_READY");
	});

	it("keeps the incumbent session when a newcomer fails to authenticate", async () => {
		const { host, secret } = await provision(0x5a);
		const good = await page(host.port ?? 0, secret);
		good.client.start();
		await observed(good.ready, "the incumbent to authenticate");
		const route = await observed(good.offers, "the incumbent's route offer");
		good.client.acknowledgeRoute(route.routeGeneration);
		const liar = await page(host.port ?? 0, new Uint8Array(32).fill(0x11));
		liar.client.start();
		await observed(liar.diagnostics, "the liar to be refused");
		assert.equal(host.routeFor(DOCUMENT)?.state, "BRIDGE_READY", "a refused hello cannot reset the incumbent route");
		assert.equal(host.routeFor(DOCUMENT)?.dispatchable, true, "the authenticated incumbent remains dispatchable");
		assert.equal(good.client.connected, true, "a failed newcomer does not evict the incumbent");
		const requestId = "3".repeat(32);
		assert.equal(good.client.request({ routeGeneration: route.routeGeneration, requestId, actionSeq: "1", operation: "control-snapshot", payload: null }), true);
		assert.equal((await observed(good.replies, "the incumbent's reply")).requestId, requestId);
	});
});

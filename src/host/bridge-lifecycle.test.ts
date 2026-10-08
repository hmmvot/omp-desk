/**
 * The observed-close contract of one editor's bridge.
 *
 * This drives the real modules: a real `BridgeEditorEndpoint` with a real exclusive
 * loopback listener, real durable record files, a real secret store and the real
 * one-winner reservation table. What it defends is what the design requires of a
 * close and nothing more:
 *
 * - the closed editor's reservation is released, so the next explicit Open of that
 *   row can win its tab again;
 * - its endpoint record, its document secret and its descriptor are gone, so the
 *   closed editor's credential cannot authenticate anything afterwards;
 * - its exact port is released, so the OS refuses a connection that used to work;
 * - a *losing* candidate's close retires nothing, because the winner is still the
 *   editor serving that tab.
 *
 * Runner: `node --test src/host/bridge-lifecycle.test.ts`
 */

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { BridgeEditorEndpoint } from "./bridge-endpoint.ts";
import { BridgeRecords } from "./bridge-records.ts";
import type { BridgeNativeBinding, BridgeRecordScope } from "./bridge-records.ts";
import { EditorCoordinator } from "./editor-coordinator.ts";
import { retireClosedEditorBridge } from "./bridge-lifecycle.ts";

const WORKSPACE = "a".repeat(64);
const TAB = "tab:11111111-2222-3333-4444-555555555555";
const EDITOR = "b".repeat(32);
const OTHER_EDITOR = "e".repeat(32);
const DOCUMENT = "c".repeat(32);
const BOOTSTRAP = "d".repeat(32);
const ORIGIN = "vscode-webview://0r42vg5knjjkub1td6sq2sg4ggjt4ovjpvcnij5lj62f9k001mi3";
const SCOPE: BridgeRecordScope = { workspace: WORKSPACE, tabId: TAB, editorId: EDITOR };

const scratch: string[] = [];
const endpoints: BridgeEditorEndpoint[] = [];

after(async () => {
	for (const endpoint of endpoints) endpoint.close();
	for (const directory of scratch) await fs.rm(directory, { recursive: true, force: true });
});

function binding(): BridgeNativeBinding {
	return {
		ownerGeneration: "owner-1",
		pid: 4242,
		processCreation: "133700000000000000",
		slot: "slot-1",
		brokerId: "broker-1",
		brokerGeneration: "generation-7",
		sessionId: "session-1",
		sessionFile: "C:\\sessions\\session-1.jsonl",
	};
}

/** Real records over a scratch directory and an in-memory secret store. */
async function store(): Promise<{ readonly records: BridgeRecords; readonly secrets: Map<string, string> }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-bridge-life-"));
	scratch.push(root);
	const secrets = new Map<string, string>();
	return {
		secrets,
		records: new BridgeRecords({
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
		}),
	};
}

/** A live endpoint with one committed document, as an open editor would have. */
async function liveEditor(records: BridgeRecords): Promise<BridgeEditorEndpoint> {
	const endpoint = new BridgeEditorEndpoint({
		records,
		scope: SCOPE,
		hostGeneration: new Uint8Array(16).fill(0x5a),
		eligible: documentId => documentId === DOCUMENT,
		onRequest: () => undefined,
	});
	endpoints.push(endpoint);
	assert.notEqual(await endpoint.bind(), null, "the editor's exact port must bind");
	assert.notEqual(await endpoint.beginDocument(DOCUMENT, BOOTSTRAP), null);
	assert.equal(endpoint.pinOrigin(DOCUMENT, ORIGIN), true);
	assert.notEqual(await endpoint.commit(binding()), null, "the document must commit");
	return endpoint;
}

/** Whether a TCP connection to `port` is accepted right now. */
async function portAnswers(port: number): Promise<boolean> {
	const attempt = Promise.withResolvers<boolean>();
	const socket = net.connect({ host: "127.0.0.1", port });
	const settle = (accepted: boolean): void => {
		socket.destroy();
		attempt.resolve(accepted);
	};
	socket.once("connect", () => settle(true));
	socket.once("error", () => settle(false));
	socket.setTimeout(2_000, () => settle(false));
	return await attempt.promise;
}

describe("an observed editor close", () => {
	it("releases the tab, forgets the endpoint and frees the exact port", async () => {
		const { records } = await store();
		const editors = new EditorCoordinator();
		assert.equal(editors.reserve({ tabId: TAB, editorId: EDITOR, provenance: "saved", sequence: 1 }).outcome, "won");
		const endpoint = await liveEditor(records);
		const port = endpoint.port ?? 0;
		assert.equal(await portAnswers(port), true, "the listener accepts a connection while the editor is open");
		assert.notEqual(await records.readDocument(SCOPE, DOCUMENT), null);
		assert.notEqual(await records.readSecret(SCOPE, DOCUMENT), null);
		assert.equal(await records.recordedPort(SCOPE), port);

		const retired = await retireClosedEditorBridge({ tabId: TAB, editorId: EDITOR, endpoint, editors });
		assert.equal(retired.retired, true);
		assert.equal(editors.winner(TAB), null, "the closed editor no longer holds its tab");
		assert.equal(endpoint.port, null, "the exact port is released");
		assert.equal(await portAnswers(port), false, "nothing answers on the port the closed editor held");
		assert.equal(await records.readDocument(SCOPE, DOCUMENT), null, "the descriptor is gone");
		assert.equal(await records.readSecret(SCOPE, DOCUMENT), null, "the document secret is gone");
		assert.equal(await records.recordedPort(SCOPE), null, "the endpoint record is gone");

		// And the row can be opened again: a fresh editor wins the tab.
		const reopened = editors.reserve({ tabId: TAB, editorId: OTHER_EDITOR, provenance: "transient", sequence: 2 });
		assert.equal(reopened.outcome, "won");
		assert.equal(editors.holds(TAB, OTHER_EDITOR), true);
	});

	it("releases a closed editor before a pending endpoint binds, then forgets its late records", async () => {
		const { records } = await store();
		const editors = new EditorCoordinator();
		assert.equal(editors.reserve({ tabId: TAB, editorId: EDITOR, provenance: "transient", sequence: 1 }).outcome, "won");
		const gate = Promise.withResolvers<void>();
		const lateEndpoint = gate.promise.then(() => liveEditor(records));
		const retired = retireClosedEditorBridge({ tabId: TAB, editorId: EDITOR, endpoint: lateEndpoint, editors });
		assert.equal(editors.winner(TAB), null, "the close releases its reservation synchronously");
		assert.equal(editors.reserve({ tabId: TAB, editorId: OTHER_EDITOR, provenance: "transient", sequence: 2 }).outcome, "won");
		gate.resolve();
		assert.equal((await retired).retired, true);
		assert.equal(await records.recordedPort(SCOPE), null, "the late endpoint's lease is forgotten");
		assert.equal(await records.readSecret(SCOPE, DOCUMENT), null, "the late document's credential is forgotten");
		assert.equal(editors.holds(TAB, OTHER_EDITOR), true, "the replacement keeps its reservation");
	});

	it("retires nothing when the editor that closed was not the winner", async () => {
		const { records } = await store();
		const editors = new EditorCoordinator();
		assert.equal(editors.reserve({ tabId: TAB, editorId: EDITOR, provenance: "saved", sequence: 1 }).outcome, "won");
		// A second editor of the same tab loses, so its close must not free the tab.
		assert.equal(editors.reserve({ tabId: TAB, editorId: OTHER_EDITOR, provenance: "saved", sequence: 2 }).outcome, "lost");
		const endpoint = await liveEditor(records);
		const loser = new BridgeEditorEndpoint({
			records,
			scope: { workspace: WORKSPACE, tabId: TAB, editorId: OTHER_EDITOR },
			hostGeneration: new Uint8Array(16).fill(0x7b),
			eligible: () => false,
			onRequest: () => undefined,
		});
		endpoints.push(loser);
		await loser.bind();

		const retired = await retireClosedEditorBridge({ tabId: TAB, editorId: OTHER_EDITOR, endpoint: loser, editors });
		assert.equal(retired.retired, false, "a losing candidate's close retires nothing");
		assert.equal(editors.holds(TAB, EDITOR), true, "the winner still holds the tab");
		assert.notEqual(await records.readDocument(SCOPE, DOCUMENT), null, "the winner's descriptor survives");
		assert.notEqual(await records.readSecret(SCOPE, DOCUMENT), null, "the winner's secret survives");
		assert.notEqual(endpoint.port, null, "the winner's listener is still bound");
	});

	it("leaves a surviving editor's records alone until a close is observed", async () => {
		const { records } = await store();
		const endpoint = await liveEditor(records);
		const port = endpoint.port ?? 0;
		// This is the host-only-restart case: the activation pass reconciles editors but
		// observes no close, so nothing may forget the credential a live page still uses.
		const editors = new EditorCoordinator();
		assert.equal(editors.reserve({ tabId: TAB, editorId: EDITOR, provenance: "saved", sequence: 1 }).outcome, "won");
		assert.notEqual(await endpoint.adoptRecordedDocument(), null, "a new activation adopts the surviving document");
		assert.equal(endpoint.port, port, "the recorded port is the one it rebinds");
		assert.notEqual(await records.readSecret(SCOPE, DOCUMENT), null, "the secret a surviving page holds is untouched");
	});
});

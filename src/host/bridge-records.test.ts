/**
 * Durable bridge records: immutability, the prepared→committed→retired manifest,
 * the secret that only a committed document may use, and the rule that nothing
 * here ever touches another editor's records.
 *
 * These are filesystem-backed tests over real temporary directories, with an
 * in-memory stand-in for `SecretStorage`.
 *
 * Runner: `node --test src/host/bridge-records.test.ts`
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { BRIDGE_PATH, encodeBase64Url } from "../bridge-protocol.ts";
import { tabIdToken } from "../bridge-identity.ts";
import { BridgeRecordError, BridgeRecords } from "./bridge-records.ts";
import type { BridgeDocumentRecord, BridgeNativeBinding, BridgeRecordScope, BridgeSecretStore } from "./bridge-records.ts";

const roots: string[] = [];

after(async () => {
	await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
	const root = await mkdtemp(path.join(tmpdir(), "omp-bridge-records-"));
	roots.push(root);
	return root;
}

class FakeSecrets implements BridgeSecretStore {
	readonly values: Record<string, string> = {};

	get(key: string): Promise<string | undefined> {
		return Promise.resolve(this.values[key]);
	}

	store(key: string, value: string): Promise<void> {
		this.values[key] = value;
		return Promise.resolve();
	}

	delete(key: string): Promise<void> {
		delete this.values[key];
		return Promise.resolve();
	}
}

const WORKSPACE = "a".repeat(64);
const TAB = "tab:11111111-2222-3333-4444-555555555555";
const EDITOR = "0b4d36ccc94648ed07827fcf238c42dc";
const OTHER_EDITOR = "7c9a67255f727ecb87e5351a63a07499";
const DOCUMENT = "51e34cdd025b07e621b22d8471147388";
const OTHER_DOCUMENT = "31e5762045f438cdecd8631b1b4bcf1b";

const scope: BridgeRecordScope = { workspace: WORKSPACE, tabId: TAB, editorId: EDITOR };
const otherScope: BridgeRecordScope = { workspace: WORKSPACE, tabId: TAB, editorId: OTHER_EDITOR };

const binding: BridgeNativeBinding = {
	ownerGeneration: "generation-1",
	pid: 4242,
	processCreation: "2026-09-25T22:00:00.000Z",
	slot: "slot-1",
	brokerId: "broker-1",
	brokerGeneration: "generation-1",
	sessionId: "S-DRAFT",
	sessionFile: null,
};

function descriptor(overrides: Partial<BridgeDocumentRecord> = {}): BridgeDocumentRecord {
	return {
		v: 1,
		W: WORKSPACE,
		T: TAB,
		E: EDITOR,
		D: DOCUMENT,
		port: 63410,
		path: BRIDGE_PATH,
		origin: "vscode-webview://0r42vg5knjjkub1td6sq2sg4ggjt4ovjpvcnij5lj62f9k001mi3",
		bootstrapId: "9c35bc2114180b4d36ccc94648ed0782",
		nativeBinding: binding,
		bindingHash: "b".repeat(64),
		...overrides,
	};
}

async function recordsWithSecrets(): Promise<{ records: BridgeRecords; secrets: FakeSecrets; root: string }> {
	const root = await tempRoot();
	const secrets = new FakeSecrets();
	return { records: new BridgeRecords({ root, secrets }), secrets, root };
}

async function refuse(code: string, run: () => Promise<unknown>): Promise<void> {
	try {
		await run();
	} catch (error) {
		assert.ok(error instanceof BridgeRecordError, `expected BridgeRecordError, received ${String(error)}`);
		assert.equal(error.code, code);
		return;
	}
	assert.fail(`expected a ${code} refusal`);
}

describe("endpoint records", () => {
	it("records one exact port and refuses to change it", async () => {
		const { records } = await recordsWithSecrets();
		assert.equal(await records.readEndpoint(scope), null);
		assert.equal(await records.recordedPort(scope), null);

		const written = await records.writeEndpoint(scope, 63410);
		assert.equal(written.port, 63410);
		assert.equal(await records.recordedPort(scope), 63410);
		assert.deepEqual(await records.readEndpoint(scope), { v: 1, W: WORKSPACE, T: TAB, E: EDITOR, port: 63410 });

		// The port is a resource lease the surviving page knows: rewriting it is refused.
		await refuse("immutable", () => records.writeEndpoint(scope, 63411));
		assert.equal(await records.recordedPort(scope), 63410);
		// Writing the same value again is a no-op, not a failure.
		await records.writeEndpoint(scope, 63410);
	});

	it("keeps one editor's records invisible to another", async () => {
		const { records } = await recordsWithSecrets();
		await records.writeEndpoint(scope, 63410);
		assert.equal(await records.readEndpoint(otherScope), null);
		assert.notEqual(records.directoryFor(scope), records.directoryFor(otherScope));
		assert.equal(records.directoryFor(scope).endsWith(path.join(WORKSPACE, tabIdToken(TAB), EDITOR)), true);
	});

	it("refuses a malformed or mis-filed record instead of reading it as absent", async () => {
		const { records, root } = await recordsWithSecrets();
		const file = path.join(records.directoryFor(scope), "endpoint");
		await mkdir(path.dirname(file), { recursive: true });
		await writeFile(file, "{ not json", "utf8");
		await refuse("unreadable", () => records.readEndpoint(scope));

		await writeFile(file, JSON.stringify({ v: 1, W: WORKSPACE, T: TAB, E: OTHER_EDITOR, port: 63410 }), "utf8");
		await refuse("invalid", () => records.readEndpoint(scope));

		await writeFile(file, JSON.stringify({ v: 1, W: WORKSPACE, T: TAB, E: EDITOR, port: 0 }), "utf8");
		await refuse("invalid", () => records.readEndpoint(scope));
		assert.equal(root.length > 0, true);
	});
});

describe("document lifecycle", () => {
	it("keeps a prepared document unauthenticable until its descriptor is committed", async () => {
		const { records, secrets } = await recordsWithSecrets();
		await records.writeEndpoint(scope, 63410);
		const manifest = await records.writePrepared(scope, DOCUMENT);
		assert.equal(manifest.state, "prepared");
		assert.equal(await records.readDocument(scope, DOCUMENT), null, "a prepared manifest authorizes nothing");
		assert.equal(await records.readSecret(scope, DOCUMENT), null);

		await records.writeSecret(scope, DOCUMENT, new Uint8Array(32).fill(0x5a));
		assert.equal(await records.readSecret(scope, DOCUMENT), null, "a secret without a committed descriptor is inert");

		await records.commitDocument(scope, descriptor());
		assert.equal((await records.readManifest(scope))?.state, "committed");
		assert.deepEqual(await records.readDocument(scope, DOCUMENT), descriptor());
		assert.deepEqual(Array.from((await records.readSecret(scope, DOCUMENT)) ?? []), Array.from(new Uint8Array(32).fill(0x5a)));
	});

	it("refuses a descriptor whose document or port is not the recorded one", async () => {
		const { records } = await recordsWithSecrets();
		await records.writeEndpoint(scope, 63410);
		await records.writePrepared(scope, DOCUMENT);
		await refuse("not-committed", () => records.commitDocument(scope, descriptor({ D: OTHER_DOCUMENT })));

		await records.commitDocument(scope, descriptor());
		// A descriptor that was tampered with after commit is refused on read.
		await writeFile(
			path.join(records.directoryFor(scope), `${DOCUMENT}.json`),
			JSON.stringify(descriptor({ port: 63411 })),
			"utf8",
		);
		assert.equal(await records.readDocument(scope, DOCUMENT), null, "a port that is not the endpoint's is not this document");
	});

	it("retires one document without deleting its descriptor or another editor's records", async () => {
		const { records, secrets } = await recordsWithSecrets();
		await records.writeEndpoint(scope, 63410);
		await records.writeEndpoint(otherScope, 63411);
		await records.writePrepared(scope, DOCUMENT);
		await records.commitDocument(scope, descriptor());
		await records.writeSecret(scope, DOCUMENT, new Uint8Array(32).fill(1));

		await records.retire(scope, DOCUMENT);

		assert.equal((await records.readManifest(scope))?.state, "retired");
		assert.equal(await records.readSecret(scope, DOCUMENT), null, "the retired document keeps no secret");
		assert.equal(await records.readDocument(scope, DOCUMENT), null);
		assert.equal(await records.readEndpoint(scope) === null, false, "the endpoint itself is kept");
		const kept = JSON.parse(await readFile(path.join(records.directoryFor(scope), `${DOCUMENT}.json`), "utf8")) as { D: string };
		assert.equal(kept.D, DOCUMENT);
		assert.equal(await records.readEndpoint(otherScope) === null, false, "another editor is untouched");
	});

	it("forgets only this editor's tree", async () => {
		const { records, secrets } = await recordsWithSecrets();
		await records.writeEndpoint(scope, 63410);
		await records.writeEndpoint(otherScope, 63411);
		await records.writePrepared(scope, DOCUMENT);
		await records.commitDocument(scope, descriptor());
		await records.writeSecret(scope, DOCUMENT, new Uint8Array(32).fill(1));

		await records.forget(scope);

		assert.equal(await records.readEndpoint(scope), null);
		assert.equal(Object.keys(secrets.values).length, 0, "only this editor's secret is deleted");
		assert.equal(await records.readEndpoint(otherScope) === null, false);
	});

	it("keys the secret by workspace, tab, editor and document", async () => {
		const { records } = await recordsWithSecrets();
		assert.equal(records.secretKeyFor(scope, DOCUMENT), `omp.bridge.v1/${WORKSPACE}/${TAB}/${EDITOR}/${DOCUMENT}`);
		assert.throws(() => records.secretKeyFor(scope, "short"), BridgeRecordError);
		assert.throws(() => records.secretKeyFor({ ...scope, workspace: "nope" }, DOCUMENT), BridgeRecordError);
	});

	it("writes one 32-byte secret in the protocol's canonical form", async () => {
		const { records, secrets } = await recordsWithSecrets();
		await refuse("invalid", () => records.writeSecret(scope, DOCUMENT, new Uint8Array(16)));
		await records.writeSecret(scope, DOCUMENT, new Uint8Array(32).fill(0xab));
		assert.equal(secrets.values[records.secretKeyFor(scope, DOCUMENT)], encodeBase64Url(new Uint8Array(32).fill(0xab)));
	});
});

describe("an editor's home workspace", () => {
	const CURRENT = "c".repeat(64);

	async function commitUnder(records: BridgeRecords, workspace: string, editorId = EDITOR): Promise<BridgeRecordScope> {
		const filed: BridgeRecordScope = { workspace, tabId: TAB, editorId };
		await records.writeEndpoint(filed, 63410);
		await records.writePrepared(filed, DOCUMENT);
		await records.commitDocument(filed, descriptor({ W: workspace, E: editorId }));
		return filed;
	}

	async function age(records: BridgeRecords, filed: BridgeRecordScope, secondsAgo: number): Promise<void> {
		const when = new Date(Date.now() - secondsAgo * 1000);
		for (const name of ["manifest.json", "endpoint"]) await utimes(path.join(records.directoryFor(filed), name), when, when);
	}

	it("keeps the workspace an editor's records were minted under after the window's own hash changed", async () => {
		const { records } = await recordsWithSecrets();
		await commitUnder(records, WORKSPACE);
		// A folder was opened: the window now hashes to CURRENT, but the surviving page still
		// presents WORKSPACE and its port, so that is where its document must be looked up.
		assert.equal(await records.homeWorkspace(TAB, EDITOR, CURRENT), WORKSPACE);
		const home: BridgeRecordScope = { workspace: await records.homeWorkspace(TAB, EDITOR, CURRENT), tabId: TAB, editorId: EDITOR };
		assert.equal((await records.readManifest(home))?.state, "committed");
		assert.equal(await records.recordedPort(home), 63410);
	});

	it("prefers the most recently written workspace when the editor was re-rendered after the hash changed", async () => {
		const { records } = await recordsWithSecrets();
		const old = await commitUnder(records, WORKSPACE);
		await age(records, old, 3600);
		await commitUnder(records, CURRENT);
		assert.equal(await records.homeWorkspace(TAB, EDITOR, WORKSPACE), CURRENT, "the fresher records win even when the other hash is the current one");
		assert.equal(await records.homeWorkspace(TAB, EDITOR, CURRENT), CURRENT);
	});

	it("answers the current hash for an editor that has no records, and never counts another editor's", async () => {
		const { records } = await recordsWithSecrets();
		await commitUnder(records, WORKSPACE, OTHER_EDITOR);
		assert.equal(await records.homeWorkspace(TAB, EDITOR, CURRENT), CURRENT);
		const empty = await recordsWithSecrets();
		assert.equal(await empty.records.homeWorkspace(TAB, EDITOR, CURRENT), CURRENT, "a tree that does not exist yet is not an error");
	});
});

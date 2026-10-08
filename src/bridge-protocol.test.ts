/**
 * Wire protocol v1: the transcript, the proofs, the frame codec and the limits.
 *
 * The pinned crypto values are not self-generated: the SHA-256, HKDF and
 * AES-256-GCM vectors were produced by the real WebCrypto implementation of
 * VS Code 1.139.1's Webview, and the HMAC vector is additionally reproduced here
 * with Node's independent `createHmac`, so a change to how `A(x)` is encoded
 * cannot pass unnoticed. The frame test is the byte-for-byte interop check
 * between the browser's WebCrypto and the host's: same key, same IV, same AAD,
 * same ciphertext and tag.
 *
 * Runner: `node --test src/bridge-protocol.test.ts`
 */

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import {
	BRIDGE_DIRECTION_CLIENT_TO_SERVER,
	BRIDGE_DIRECTION_SERVER_TO_CLIENT,
	BRIDGE_KEY_INFO_CLIENT_TO_SERVER,
	BRIDGE_KEY_INFO_SERVER_TO_CLIENT,
	BRIDGE_MAX_HANDSHAKE_BYTES,
	BRIDGE_PROTOCOL_VERSION,
	BridgeActionSequence,
	BridgeProtocolError,
	BridgeSequence,
	challengeFrame,
	createToken,
	isCanonicalToken,
	isRouteStatus,
	decodeBase64Url,
	decodeHex,
	deriveFrameKey,
	encodeBase64Url,
	encodeHex,
	frameAdditionalData,
	frameIv,
	frameKeys,
	handshakeTranscript,
	helloFields,
	hmac,
	invalidateFrame,
	openFrame,
	parseAndVerifyChallenge,
	parseAsciiJsonText,
	parseHello,
	parseTextFrame,
	proofFrame,
	readyFrame,
	requestFrame,
	replyFrame,
	routeAckFrame,
	routeOfferFrame,
	sealFrame,
	sha256,
	textFrame,
	transcript,
	verifyProof,
} from "./bridge-protocol.ts";

function filled(byte: number, length: number): Uint8Array {
	const bytes = new Uint8Array(length);
	bytes.fill(byte);
	return bytes;
}

const WORKSPACE = "a".repeat(64);
const BINDING_HASH = "b".repeat(64);
const TAB_ID = "tab:11111111-2222-3333-4444-555555555555";
const EDITOR = filled(0x21, 16);
const DOCUMENT = filled(0x22, 16);
const SECRET = filled(0x33, 32);
const ORIGIN = "vscode-webview://0r42vg5knjjkub1td6sq2sg4ggjt4ovjpvcnij5lj62f9k001mi3";

const material = {
	clientNonce: filled(0x44, 32),
	serverNonce: filled(0x55, 32),
	hostGeneration: filled(0x66, 16),
	connectionId: filled(0x77, 16),
};

const handshake = {
	workspace: WORKSPACE,
	tabId: TAB_ID,
	editorId: encodeBase64Url(EDITOR),
	documentId: encodeBase64Url(DOCUMENT),
	bindingHash: BINDING_HASH,
	port: 63410,
	origin: ORIGIN,
	clientNonce: encodeBase64Url(material.clientNonce),
	serverNonce: encodeBase64Url(material.serverNonce),
	hostGeneration: encodeBase64Url(material.hostGeneration),
	connectionId: encodeBase64Url(material.connectionId),
};

async function protocolError(code: string, run: () => Promise<unknown> | unknown): Promise<void> {
	try {
		await run();
	} catch (error) {
		assert.ok(error instanceof BridgeProtocolError, `expected BridgeProtocolError, received ${String(error)}`);
		assert.equal(error.code, code);
		return;
	}
	assert.fail(`expected a ${code} refusal`);
}

describe("A(x) transcript", () => {
	it("encodes fixed ASCII fields as their canonical JSON array", () => {
		assert.equal(transcript(["omp-probe-transcript"]), '["omp-probe-transcript"]');
		assert.equal(transcript(["hello", 1, WORKSPACE]), `["hello",1,"${WORKSPACE}"]`);
	});

	it("refuses anything that is not canonical printable ASCII", () => {
		for (const bad of ["", "with space\n", "\u0443\u043dicode", "tab\t"]) {
			assert.throws(() => transcript([bad]), BridgeProtocolError);
		}
		assert.throws(() => transcript([1.5]), BridgeProtocolError);
		assert.throws(() => transcript([-1]), BridgeProtocolError);
		assert.throws(() => transcript([Number.MAX_SAFE_INTEGER + 2]), BridgeProtocolError);
	});
});

describe("canonical field encodings", () => {
	it("round-trips base64url for the protocol's byte widths", () => {
		for (const size of [16, 32]) {
			const bytes = filled(0x5a, size);
			assert.equal(decodeBase64Url(encodeBase64Url(bytes), size).length, size);
			assert.deepEqual(Array.from(decodeBase64Url(encodeBase64Url(bytes), size)), Array.from(bytes));
		}
	});

	it("refuses padded, wrong-length and non-canonical base64url", () => {
		const canonical = encodeBase64Url(filled(0x5a, 32));
		assert.throws(() => decodeBase64Url(`${canonical}=`, 32), BridgeProtocolError);
		assert.throws(() => decodeBase64Url(canonical, 16), BridgeProtocolError);
		assert.throws(() => decodeBase64Url(canonical.slice(0, -1), 32), BridgeProtocolError);
		assert.throws(() => decodeBase64Url(`${canonical.slice(0, -1)}+`, 32), BridgeProtocolError);
		// Same decoded bytes, non-zero trailing bits: still a different text.
		assert.throws(() => decodeBase64Url(`${canonical.slice(0, -1)}B`, 32), BridgeProtocolError);
	});

	it("keeps hex lowercase and exact", () => {
		assert.equal(encodeHex(filled(0xab, 2)), "abab");
		assert.equal(decodeHex("abab", 2)[0], 0xab);
		assert.throws(() => decodeHex("ABAB", 2), BridgeProtocolError);
		assert.throws(() => decodeHex("aba", 2), BridgeProtocolError);
	});
});

describe("pinned crypto vectors (browser-verified in the isolated probe)", () => {
	it("matches the standard SHA-256 of 'abc'", async () => {
		assert.equal(encodeHex(await sha256(new TextEncoder().encode("abc"))), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
	});

	it("MACs A(['server', X]) exactly, verified against an independent implementation", async () => {
		const message = transcript(["omp-probe-transcript"]);
		const observed = encodeHex(await hmac(filled(7, 32), ["omp-probe-transcript"]));
		const independent = createHmac("sha256", filled(7, 32)).update(message, "utf8").digest("hex");
		assert.equal(observed, independent, "the module must MAC the validated A(x) text, nothing else");
		assert.equal(observed, "dfd93340592787a43dbf3775e5bac526a99acf793d6239813d130552d1090732");
	});

	it("derives the same frame key the installed Webview's HKDF produced", async () => {
		const salt = await sha256(new TextEncoder().encode("salt"));
		assert.equal(
			encodeBase64Url(await deriveFrameKey(filled(2, 32), salt, BRIDGE_KEY_INFO_CLIENT_TO_SERVER)),
			"JgsEkX3qWF4nWGAYjJgMDyDDfokULU8CvzdU_iGQ1u4",
		);
	});
});

describe("encrypted frames", () => {
	it("seals the browser-verified ciphertext and header for a fixed key, iv and AAD", async () => {
		const sealed = await sealFrame({
			key: filled(3, 32),
			direction: BRIDGE_DIRECTION_CLIENT_TO_SERVER,
			sequence: 0,
			plaintext: new TextEncoder().encode("frame"),
			additionalData: "omp-webview-bridge",
		});
		assert.deepEqual(Array.from(sealed.subarray(0, 6)), [1, 0, 0, 0, 0, 0], "version, direction, big-endian sequence");
		assert.equal(encodeBase64Url(sealed.subarray(6)), "B1bns8wm003ks7eAN4axZ6z74PWo");
	});

	it("opens its own frame and refuses every altered field", async () => {
		const key = filled(3, 32);
		const hostGeneration = filled(4, 16);
		const connectionId = filled(5, 16);
		const documentId = filled(6, 16);
		const sealed = await sealFrame({
			key,
			direction: 0,
			sequence: 7,
			plaintext: textFrame(["request", "x"]),
			additionalData: frameAdditionalData(hostGeneration, connectionId, documentId, 0, 7),
		});
		const opened = await openFrame({ key, frame: sealed, expectedDirection: 0, hostGeneration, connectionId, documentId });
		assert.equal(opened.sequence, 7);
		assert.deepEqual(parseTextFrame(opened.plaintext), ["request", "x"]);

		await protocolError("wrong-direction", () => openFrame({ key, frame: sealed, expectedDirection: 1, hostGeneration, connectionId, documentId }));
		// The AAD comes from the frame's own header sequence, so a frame sealed
		// under another sequence cannot be opened under this session's identity.
		await protocolError("authentication", () => openFrame({ key, frame: sealed, expectedDirection: 0, hostGeneration, connectionId, documentId: filled(7, 16) }));
		await protocolError("authentication", () => openFrame({ key: filled(9, 32), frame: sealed, expectedDirection: 0, hostGeneration, connectionId, documentId }));
		const tampered = sealed.slice();
		tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0x01;
		await protocolError("authentication", () => openFrame({ key, frame: tampered, expectedDirection: 0, hostGeneration, connectionId, documentId }));
		const wrongVersion = sealed.slice();
		wrongVersion[0] = 2;
		await protocolError("wrong-version", () => openFrame({ key, frame: wrongVersion, expectedDirection: 0, hostGeneration, connectionId, documentId }));
		await protocolError("malformed", () => openFrame({ key, frame: sealed.subarray(0, 8), expectedDirection: 0, hostGeneration, connectionId, documentId }));
	});

	it("builds the initialisation vector from the sequence", () => {
		assert.deepEqual(Array.from(frameIv(0)), [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
		assert.deepEqual(Array.from(frameIv(0x01020304)).slice(8), [1, 2, 3, 4]);
		assert.throws(() => frameIv(-1), BridgeProtocolError);
		assert.throws(() => frameIv(2 ** 32), BridgeProtocolError);
	});

	it("accepts exactly the next sequence per direction", () => {
		const guard = new BridgeSequence();
		assert.equal(guard.next, 0);
		guard.accept(0);
		guard.accept(1);
		assert.throws(() => guard.accept(1), BridgeProtocolError);
		assert.throws(() => guard.accept(3), BridgeProtocolError);
		guard.accept(2);
		assert.equal(guard.shouldReconnect, false);
	});
});

describe("handshake", () => {
	it("challenges, verifies and proves with one transcript", async () => {
		const challenge = await challengeFrame(SECRET, handshake, material);
		const verified = await parseAndVerifyChallenge(challenge, SECRET, handshake);
		assert.deepEqual(Array.from(verified.challenge.hostGeneration), Array.from(material.hostGeneration));
		const proof = await proofFrame(SECRET, verified.transcriptText);
		await verifyProof(proof, SECRET, verified.transcriptText);
	});

	it("refuses a challenge or proof that does not name this document", async () => {
		const challenge = await challengeFrame(SECRET, handshake, material);
		await protocolError("authentication", () => parseAndVerifyChallenge(challenge, filled(0x99, 32), handshake));
		const other = { ...handshake, documentId: encodeBase64Url(filled(0x99, 16)) };
		await protocolError("authentication", () => parseAndVerifyChallenge(challenge, SECRET, other));
		const verified = await parseAndVerifyChallenge(challenge, SECRET, handshake);
		const proof = await proofFrame(filled(0x99, 32), verified.transcriptText);
		await protocolError("authentication", () => verifyProof(proof, SECRET, verified.transcriptText));
	});

	it("binds the transcript to every identity field", () => {
		const base = handshakeTranscript(handshake);
		for (const changed of [
			{ ...handshake, workspace: "c".repeat(64) },
			{ ...handshake, bindingHash: "d".repeat(64) },
			{ ...handshake, port: 63411 },
			{ ...handshake, origin: "vscode-webview://other" },
			{ ...handshake, editorId: encodeBase64Url(filled(0x98, 16)) },
		]) {
			assert.notEqual(handshakeTranscript(changed), base);
		}
	});

	it("parses a canonical hello and refuses every deviation", () => {
		const hello = helloFields({ workspace: WORKSPACE, tabId: TAB_ID, editorId: EDITOR, documentId: DOCUMENT, bindingHash: BINDING_HASH, clientNonce: material.clientNonce });
		const parsed = parseHello(hello);
		assert.equal(parsed.tabId, TAB_ID);
		assert.equal(parsed.bindingHash, BINDING_HASH);
		assert.deepEqual(Array.from(parsed.editorId), Array.from(EDITOR));

		const variants = [
			hello.replace('"hello",1', '"hello",2'),
			`${hello.slice(0, -2)},"extra"]`,
			hello.replace(WORKSPACE, WORKSPACE.toUpperCase()),
			hello.replace(TAB_ID, "tab:not-a-uuid"),
			hello.replace(encodeBase64Url(material.clientNonce), `${encodeBase64Url(material.clientNonce)}=`),
		];
		for (const variant of variants) {
			assert.notEqual(variant, hello, "the fixture must actually differ");
			assert.throws(() => parseHello(variant), BridgeProtocolError);
		}
		assert.throws(() => parseHello("not json"), BridgeProtocolError);
		assert.throws(() => parseHello(`["hello",1,"${"a".repeat(BRIDGE_MAX_HANDSHAKE_BYTES)}"]`), BridgeProtocolError);
	});
});

describe("frame keys and message shapes", () => {
	it("derives two different direction keys", async () => {
		const { clientToServer, serverToClient } = await frameKeys(SECRET, handshakeTranscript(handshake));
		assert.equal(clientToServer.length, 32);
		assert.equal(serverToClient.length, 32);
		assert.notDeepEqual(Array.from(clientToServer), Array.from(serverToClient));
		const again = await frameKeys(SECRET, handshakeTranscript(handshake));
		assert.deepEqual(Array.from(again.clientToServer), Array.from(clientToServer));
		assert.equal(BRIDGE_KEY_INFO_SERVER_TO_CLIENT.endsWith("s2c"), true);
	});

	it("keeps the fixed message shapes", () => {
		const host = filled(0x66, 16);
		const document = filled(0x22, 16);
		assert.equal(readyFrame(host, document, "ready"), `["ready","${encodeBase64Url(host)}","${encodeBase64Url(document)}","ready"]`);
		assert.equal(routeAckFrame(host, document, "r1"), `["route-ack","${encodeBase64Url(host)}","${encodeBase64Url(document)}","r1"]`);
		assert.equal(invalidateFrame(host, document, "r1").startsWith('["invalidate",'), true);
		assert.equal(routeOfferFrame(host, document, "r1", "waiting").endsWith('"waiting"]'), true);
		const request = requestFrame(host, document, "r1", "req-1", "7", "snapshot", { a: 1 });
		assert.equal(request, `["request","${encodeBase64Url(host)}","${encodeBase64Url(document)}","r1","req-1","7","snapshot","{\\"a\\":1}"]`);
		// A payload with characters outside printable ASCII still encodes canonically and round-trips.
		// The Cyrillic letters (written as escapes to keep this source ASCII) stand for a non-ASCII path segment.
		const cyrillicProject = "\u043f\u0440\u043e\u0435\u043a\u0442";
		const unicode = requestFrame(host, document, "r1", "req-2", "8", "snapshot", { cwd: `C:\\${cyrillicProject}\\\u{1F600}` });
		assert.equal(unicode.includes(cyrillicProject), false, "the field itself stays printable ASCII");
		const unicodeFields = JSON.parse(unicode) as unknown[];
		assert.deepEqual(parseAsciiJsonText(unicodeFields[7]), { cwd: `C:\\${cyrillicProject}\\\u{1F600}` });
		assert.equal(replyFrame(host, document, "r1", "req-1", null), `["reply","${encodeBase64Url(host)}","${encodeBase64Url(document)}","r1","req-1","null"]`);
	});

	it("round-trips text frames and refuses oversized or non-UTF-8 bodies", () => {
		const frame = textFrame(["status", "waiting"]);
		assert.deepEqual(parseTextFrame(frame), ["status", "waiting"]);
		assert.throws(() => parseTextFrame(new Uint8Array([0xff, 0xfe])), BridgeProtocolError);
		assert.throws(() => textFrame(["x".repeat(300)], 100), BridgeProtocolError);
		assert.throws(() => parseTextFrame(frame, 2), BridgeProtocolError);
	});

	it("mints correlation ids and a strictly increasing action sequence", () => {
		const first = createToken();
		const second = createToken();
		assert.equal(isCanonicalToken(first), true);
		assert.equal(isCanonicalToken(first.toUpperCase()), false);
		assert.equal(isCanonicalToken("r-1"), false);
		assert.notEqual(first, second);
		assert.equal(isRouteStatus("waiting"), true);
		assert.equal(isRouteStatus("anything-else"), false);
		const sequence = new BridgeActionSequence();
		assert.deepEqual([sequence.next(), sequence.next(), sequence.next()], ["1", "2", "3"]);
		assert.equal(BRIDGE_PROTOCOL_VERSION, 1);
	});
});

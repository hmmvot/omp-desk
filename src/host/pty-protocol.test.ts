/**
 * Tests for the PTY broker's wire and record contract.
 *
 * Runner: `node --test src/host/pty-protocol.test.ts`
 *
 * What matters here: a record is accepted only when every field is usable, a
 * handshake can only be produced by the side that holds the token, every frame is
 * bound to its connection and its position in that connection, and output is chunked
 * without ever cutting a character in half.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	PTY_MAX_OWNER_DETAIL_CHARS,
	PTY_MAX_SNAPSHOT_CHARS,
	PTY_MAX_FRAME_BYTES,
	PTY_RPC_FRAGMENT_RAW_BYTES,
	PTY_RUNTIME_VERSION,
	PtyRpcFragmentAssembler,
	PtyRpcLineTooLongError,
	isPtyKind,
	isPtyRpcBase64,
	isPtyRpcOnlyRequest,
	isPtyTerminalOnlyRequest,
	ptyRpcFragment,
	ptyRpcFragmentCount,
	PTY_PROTOCOL_VERSION,
	PTY_RECORD_VERSION,
	PTY_SERVICE,
	PtyProtocolError,
	chunkPtyOutput,
	clampPtySize,
	createPtyNonce,
	createPtyToken,
	derivePtySessionId,
	derivePtySessionKey,
	encodePtyFrame,
	filetimeToEpochMs,
	isPtyCreationTime,
	isPtyFrontendId,
	isPtyOwnerHint,
	isPtyOwnerStopStatus,
	isPtySlot,
	isPtySnapshotMeta,
	isPtyStatusPayload,
	parsePtyBrokerRecord,
	parsePtyFrame,
	parsePtyTitle,
	ptyHelloMac,
	ptyHelloOkMac,
	verifyPtyHelloMac,
	verifyPtyHelloOkMac,
	type PtyBrokerRecord,
	type PtyOwnerStopStatus,
} from "./pty-protocol.ts";

/** A status payload that satisfies the protocol's own validator. */
function statusFixture(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
	return {
		state: "running",
		exitCode: null,
		signal: null,
		cols: 80,
		rows: 24,
		alt: false,
		title: null,
		nativePid: 4243,
		nativeCreationTime: null,
		brokerPid: 4242,
		brokerCreationTime: null,
		clients: 1,
		inputOwner: null,
		uptimeMs: 1,
		noClientForMs: null,
		childExitedAtMs: null,
		outputPosition: 0,
		oldestPosition: 0,
		notices: [],
		ownerStop: {
			state: "not-applicable",
			detail: "a managed OMP host is never stopped by an owner watch",
			owners: [],
			graceRemainingMs: null,
		},
		...overrides,
	};
}

/** An owner-stop status that satisfies the protocol's own validator. */
function ownerStopFixture(overrides: Partial<PtyOwnerStopStatus> = {}): PtyOwnerStopStatus {
	return {
		state: "armed",
		detail: "watching owning VS Code main process 4244",
		owners: [{ pid: 4244, creationTime: "134349421014308869", signaled: false, admittedAtMs: 12 }],
		graceRemainingMs: null,
		...overrides,
	};
}

/** A snapshot's metadata that satisfies the protocol's own validator. */
function snapshotFixture(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
	return {
		position: 0,
		cols: 80,
		rows: 24,
		alt: false,
		title: null,
		cursorX: 0,
		cursorY: 0,
		cursorVisible: true,
		chunks: 0,
		chars: 0,
		truncated: false,
		encoding: "ansi",
		...overrides,
	};
}

function record(overrides: Partial<PtyBrokerRecord> = {}): PtyBrokerRecord {
	return {
		version: PTY_RECORD_VERSION,
		service: PTY_SERVICE,
		protocolVersion: PTY_PROTOCOL_VERSION,
		runtimeVersion: 1,
		treeDigest: "a".repeat(64),
		brokerId: "pty-11111111-2222-3333-4444-555555555555",
		generation: "gen-11111111-2222-3333-4444-555555555555",
		slot: "tab:1",
		kind: "managed-omp",
		port: 51234,
		token: createPtyToken(),
		brokerPid: 4242,
		brokerCreationTime: "134349421014308869",
		startedAt: new Date(0).toISOString(),
		cols: 100,
		rows: 30,
		title: "omp — C:\\work",
		...overrides,
	};
}

describe("broker record", () => {
	it("round-trips through JSON", () => {
		const parsed = parsePtyBrokerRecord(JSON.parse(JSON.stringify(record())));
		assert.equal(parsed.slot, "tab:1");
		assert.equal(parsed.kind, "managed-omp");
		assert.equal(parsed.port, 51234);
		assert.equal(parsed.brokerPid, 4242);
	});

	it("accepts a record whose creation time could not be read, and rejects a malformed one", () => {
		assert.equal(parsePtyBrokerRecord(JSON.parse(JSON.stringify(record({ brokerCreationTime: null })))).brokerCreationTime, null);
		assert.throws(() => parsePtyBrokerRecord({ ...record(), brokerCreationTime: "later" }), PtyProtocolError);
	});

	it("refuses a record that is not this service, version or shape", () => {
		const cases: unknown[] = [
			{ ...record(), version: 2 },
			{ ...record(), service: "omp-vscode-other" },
			{ ...record(), protocolVersion: "1" },
			{ ...record(), treeDigest: "not-a-digest" },
			{ ...record(), brokerId: "other" },
			{ ...record(), generation: "gen-not-a-uuid" },
			{ ...record(), slot: "" },
			{ ...record(), kind: "omp" },
			{ ...record(), port: 0 },
			{ ...record(), port: 70000 },
			{ ...record(), token: "short" },
			{ ...record(), brokerPid: 0 },
			{ ...record(), startedAt: "" },
			{ ...record(), cols: 1 },
			{ ...record(), rows: 0 },
			{ ...record(), title: "" },
			null,
			17,
		];
		for (const value of cases) {
			assert.throws(() => parsePtyBrokerRecord(value), PtyProtocolError, `accepted ${JSON.stringify(value)}`);
		}
	});

	it("treats a slot as a key, not as a path", () => {
		for (const slot of ["tab:1", "shell:5f0b", "a/b\\c", "tab.with.dots", "x".repeat(256)]) {
			assert.equal(isPtySlot(slot), true, slot);
		}
		for (const slot of ["", "with space", "new\nline", "x".repeat(257), 12]) {
			assert.equal(isPtySlot(slot), false, String(slot));
		}
	});
});

describe("handshake proofs", () => {
	it("is produced only by a holder of the token, and pins the broker's own identity", () => {
		const token = createPtyToken();
		const other = createPtyToken();
		const clientNonce = createPtyNonce();
		const serverNonce = createPtyNonce();
		const hello = { brokerId: "pty-11111111-2222-3333-4444-555555555555", generation: "gen-11111111-2222-3333-4444-555555555555", clientNonce };
		assert.equal(verifyPtyHelloMac(token, hello, ptyHelloMac(token, hello)), true);
		assert.equal(verifyPtyHelloMac(token, hello, ptyHelloMac(other, hello)), false);
		assert.equal(verifyPtyHelloMac(token, { ...hello, generation: "gen-99999999-2222-3333-4444-555555555555" }, ptyHelloMac(token, hello)), false);

		const answer = {
			brokerId: hello.brokerId,
			generation: hello.generation,
			slot: "tab:1",
			clientNonce,
			serverNonce,
			brokerPid: 4242,
			brokerCreationTime: "134349421014308869",
		};
		assert.equal(verifyPtyHelloOkMac(token, answer, ptyHelloOkMac(token, answer)), true);
		assert.equal(verifyPtyHelloOkMac(token, { ...answer, brokerPid: 4243 }, ptyHelloOkMac(token, answer)), false);
		assert.equal(
			verifyPtyHelloOkMac(token, { ...answer, brokerCreationTime: "134349421014308870" }, ptyHelloOkMac(token, answer)),
			false,
		);
	});

	it("derives a connection key from both nonces, so one connection's frames are useless on another", () => {
		const token = createPtyToken();
		const first = derivePtySessionKey(token, createPtyNonce(), createPtyNonce());
		const second = derivePtySessionKey(token, createPtyNonce(), createPtyNonce());
		const replay = derivePtySessionKey(token, createPtyNonce(), createPtyNonce());
		assert.notDeepEqual(first, second);
		assert.notDeepEqual(first, replay);
		assert.equal(derivePtySessionId(first), derivePtySessionId(first));
		assert.notEqual(derivePtySessionId(first), derivePtySessionId(second));
	});
});

describe("frames", () => {
	it("refuses a frame whose proof, sequence or version is not this connection's", () => {
		const key = derivePtySessionKey(createPtyToken(), createPtyNonce(), createPtyNonce());
		const sessionId = derivePtySessionId(key);
		const line = encodePtyFrame(key, sessionId, 1, { v: PTY_PROTOCOL_VERSION, t: "ack", id: 1, ok: true });
		const frame = parsePtyFrame(key, sessionId, 1, line, "broker-to-client");
		assert.equal(frame.t, "ack");
		assert.equal(frame.seq, 1);

		// Reordered, repeated and edited frames are refused, and so is another key.
		assert.throws(() => parsePtyFrame(key, sessionId, 2, line, "broker-to-client"), PtyProtocolError);
		assert.throws(
			() => parsePtyFrame(key, sessionId, 1, line.replace('"ok":true', '"ok":false'), "broker-to-client"),
			PtyProtocolError,
		);
		// Another connection's label: the same bytes are not this connection's frames.
		const otherKey = derivePtySessionKey(createPtyToken(), createPtyNonce(), createPtyNonce());
		assert.throws(() => parsePtyFrame(key, derivePtySessionId(otherKey), 1, line, "broker-to-client"), PtyProtocolError);
		assert.throws(
			() =>
				parsePtyFrame(
					key,
					sessionId,
					1,
					JSON.stringify({ v: 2, t: "ack", id: 1, ok: true, seq: 1, mac: "x".repeat(43) }),
					"broker-to-client",
				),
			PtyProtocolError,
		);
		assert.throws(() => parsePtyFrame(key, sessionId, 1, "not json", "broker-to-client"), PtyProtocolError);
		assert.throws(() => parsePtyFrame(key, sessionId, 1, "", "broker-to-client"), PtyProtocolError);
	});

	it("refuses a frame whose type belongs to the other direction, or whose fields are missing", () => {
		const key = derivePtySessionKey(createPtyToken(), createPtyNonce(), createPtyNonce());
		const sessionId = derivePtySessionId(key);
		// A request type sent to a client: the broker never asks, so this is not a frame
		// it may have sent.
		const request = encodePtyFrame(key, sessionId, 1, {
			v: PTY_PROTOCOL_VERSION,
			t: "input",
			id: 1,
			frontendId: "frontend-a",
			data: "x",
		});
		assert.equal(parsePtyFrame(key, sessionId, 1, request, "client-to-broker").t, "input");
		assert.throws(() => parsePtyFrame(key, sessionId, 1, request, "broker-to-client"), PtyProtocolError);
		// An event type sent to the broker is refused the same way.
		const event = encodePtyFrame(key, sessionId, 1, { v: PTY_PROTOCOL_VERSION, t: "output", fromPosition: 0, data: "x" });
		assert.equal(parsePtyFrame(key, sessionId, 1, event, "broker-to-client").t, "output");
		assert.throws(() => parsePtyFrame(key, sessionId, 1, event, "client-to-broker"), PtyProtocolError);
		// A right-typed frame with the wrong fields is refused, not partially trusted.
		const hollow = encodePtyFrame(key, sessionId, 1, { v: PTY_PROTOCOL_VERSION, t: "status", id: 1 } as never);
		assert.throws(() => parsePtyFrame(key, sessionId, 1, hollow, "broker-to-client"), PtyProtocolError);
		assert.equal(parsePtyFrame(key, sessionId, 1, hollow, "client-to-broker").t, "status");
		// A request carrying a response payload is not a request.
		const confused = encodePtyFrame(key, sessionId, 1, {
			v: PTY_PROTOCOL_VERSION,
			t: "snapshot",
			id: 1,
			meta: null as never,
		});
		assert.throws(() => parsePtyFrame(key, sessionId, 1, confused, "client-to-broker"), PtyProtocolError);
	});

	it("accepts every frame each direction sends, and refuses it in the other", () => {
		// The tables that decide what a direction may send are hand-written, so this is
		// the check that keeps a type from being forgotten: every request and every event
		// is built once here, parsed in its own direction, and refused in the other.
		const key = derivePtySessionKey(createPtyToken(), createPtyNonce(), createPtyNonce());
		const sessionId = derivePtySessionId(key);
		const status = statusFixture();
		const ownerStop = ownerStopFixture();
		const snapshots = {
			position: 0,
			cols: 80,
			rows: 24,
			alt: false,
			title: null,
			cursorX: 0,
			cursorY: 0,
			cursorVisible: true,
			chunks: 0,
			chars: 0,
			truncated: false,
			encoding: "ansi" as const,
		};
		const stopped = {
			verified: false,
			mode: "graceful" as const,
			nativePid: 4243,
			pidGone: true,
			tree: "unknown" as const,
			treeEvidence: "parent-links-only" as const,
			remainingPids: [],
			checkedPids: [],
			exitCode: 0,
			detail: "root gone; the tree is not proven",
		};
		const requests = [
			{ v: PTY_PROTOCOL_VERSION, t: "attach", id: 1, sincePosition: 0 },
			{ v: PTY_PROTOCOL_VERSION, t: "snapshot", id: 1 },
			{ v: PTY_PROTOCOL_VERSION, t: "status", id: 1 },
			{ v: PTY_PROTOCOL_VERSION, t: "input", id: 1, frontendId: "f", data: "x" },
			{ v: PTY_PROTOCOL_VERSION, t: "resize", id: 1, frontendId: "f", cols: 80, rows: 24 },
			{ v: PTY_PROTOCOL_VERSION, t: "claim-input", id: 1, frontendId: "f", takeover: false },
			{ v: PTY_PROTOCOL_VERSION, t: "release-input", id: 1, frontendId: "f" },
			{ v: PTY_PROTOCOL_VERSION, t: "stop", id: 1, mode: "graceful", timeoutMs: 1000 },
			{ v: PTY_PROTOCOL_VERSION, t: "shutdown", id: 1, requireStopped: true },
			{ v: PTY_PROTOCOL_VERSION, t: "admit-owner", id: 1, owner: { extensionHostPid: 11, parentPid: 22, mainPid: 22 } },
		];
		const events = [
			{ v: PTY_PROTOCOL_VERSION, t: "error", code: "malformed", detail: "no" },
			{ v: PTY_PROTOCOL_VERSION, t: "ack", id: 1, ok: true },
			{ v: PTY_PROTOCOL_VERSION, t: "attached", id: 1, fromPosition: 0, oldestPosition: 0, truncated: false, status },
			{ v: PTY_PROTOCOL_VERSION, t: "output", fromPosition: 0, data: "x" },
			{ v: PTY_PROTOCOL_VERSION, t: "snapshot", id: 1, meta: snapshots },
			{ v: PTY_PROTOCOL_VERSION, t: "snapshot-data", id: 1, index: 0, data: "x" },
			{ v: PTY_PROTOCOL_VERSION, t: "status", id: 1, status },
			{ v: PTY_PROTOCOL_VERSION, t: "state", status },
			{ v: PTY_PROTOCOL_VERSION, t: "stopped", id: 1, result: stopped },
			{ v: PTY_PROTOCOL_VERSION, t: "input-owner", id: 1, frontendId: "f", previous: null },
			{ v: PTY_PROTOCOL_VERSION, t: "shutdown-ok", id: 1, stopped: true },
			{ v: PTY_PROTOCOL_VERSION, t: "owner-stop", id: 1, status: ownerStop },
		];
		for (const body of requests) {
			const line = encodePtyFrame(key, sessionId, 1, body as never);
			assert.equal(parsePtyFrame(key, sessionId, 1, line, "client-to-broker").t, body.t, `request ${body.t}`);
			assert.throws(() => parsePtyFrame(key, sessionId, 1, line, "broker-to-client"), PtyProtocolError, `request ${body.t}`);
		}
		for (const body of events) {
			const line = encodePtyFrame(key, sessionId, 1, body as never);
			assert.equal(parsePtyFrame(key, sessionId, 1, line, "broker-to-client").t, body.t, `event ${body.t}`);
			assert.throws(() => parsePtyFrame(key, sessionId, 1, line, "client-to-broker"), PtyProtocolError, `event ${body.t}`);
		}
	});

	it("bounds a terminal title and a snapshot's serialized size", () => {
		// The title comes from the child's OSC output: it must fit one frame, and the
		// snapshot must not exceed the size it advertises.
		assert.equal(isPtyStatusPayload(statusFixture({ title: "t".repeat(256) })), true);
		assert.equal(isPtyStatusPayload(statusFixture({ title: "t".repeat(257) })), false);
		assert.equal(isPtySnapshotMeta(snapshotFixture({ chars: PTY_MAX_SNAPSHOT_CHARS })), true);
		assert.equal(isPtySnapshotMeta(snapshotFixture({ chars: PTY_MAX_SNAPSHOT_CHARS + 1 })), false);
	});

	it("accepts a push that names no request, and refuses a request that names none", () => {
		// The broker pushes output, state changes and its own refusal before any request
		// exists, so those frames carry no id at all; a push that *does* answer a request
		// (input ownership, owner-stop) carries that request's id or `0` for a broadcast.
		const key = derivePtySessionKey(createPtyToken(), createPtyNonce(), createPtyNonce());
		const sessionId = derivePtySessionId(key);
		const status = statusFixture();
		const pushed = encodePtyFrame(key, sessionId, 1, { v: PTY_PROTOCOL_VERSION, t: "state", status } as never);
		assert.equal(parsePtyFrame(key, sessionId, 1, pushed, "broker-to-client").t, "state");
		const broadcast = encodePtyFrame(key, sessionId, 1, {
			v: PTY_PROTOCOL_VERSION,
			t: "input-owner",
			id: 0,
			frontendId: null,
			previous: "frontend-a",
		});
		assert.equal(parsePtyFrame(key, sessionId, 1, broadcast, "broker-to-client").t, "input-owner");
		const ownerPush = encodePtyFrame(key, sessionId, 1, { v: PTY_PROTOCOL_VERSION, t: "owner-stop", id: 0, status: ownerStopFixture() });
		assert.equal(parsePtyFrame(key, sessionId, 1, ownerPush, "broker-to-client").t, "owner-stop");
		// A request with no id is not a request, and an id-less push that is not one of
		// the pushes is refused rather than accepted.
		const requestWithoutId = encodePtyFrame(key, sessionId, 1, { v: PTY_PROTOCOL_VERSION, t: "status" } as never);
		assert.throws(() => parsePtyFrame(key, sessionId, 1, requestWithoutId, "client-to-broker"), PtyProtocolError);
		const pushedWithId = encodePtyFrame(key, sessionId, 1, { v: PTY_PROTOCOL_VERSION, t: "output", id: 1, fromPosition: 0, data: "x" } as never);
		assert.throws(() => parsePtyFrame(key, sessionId, 1, pushedWithId, "broker-to-client"), PtyProtocolError);
	});

	it("carries an owner admission that names no candidate, and refuses one that names nothing at all", () => {
		// An authenticated frontend that exists but cannot attest an owning main says so
		// with `null`; the field is always present, so "no opinion" is the absence of the
		// request rather than an empty value inside it (ADR-0030).
		const key = derivePtySessionKey(createPtyToken(), createPtyNonce(), createPtyNonce());
		const sessionId = derivePtySessionId(key);
		const unattestable = encodePtyFrame(key, sessionId, 1, { v: PTY_PROTOCOL_VERSION, t: "admit-owner", id: 1, owner: null });
		const parsed = parsePtyFrame(key, sessionId, 1, unattestable, "client-to-broker");
		assert.equal(parsed.t, "admit-owner");
		assert.equal(parsed.t === "admit-owner" ? parsed.owner : "unset", null);
		const hint = encodePtyFrame(key, sessionId, 1, {
			v: PTY_PROTOCOL_VERSION,
			t: "admit-owner",
			id: 1,
			owner: { extensionHostPid: 11, parentPid: 22, mainPid: 22 },
		});
		const withHint = parsePtyFrame(key, sessionId, 1, hint, "client-to-broker");
		assert.deepEqual(withHint.t === "admit-owner" ? withHint.owner : null, { extensionHostPid: 11, parentPid: 22, mainPid: 22 });
		const withoutField = encodePtyFrame(key, sessionId, 1, { v: PTY_PROTOCOL_VERSION, t: "admit-owner", id: 1 } as never);
		assert.throws(() => parsePtyFrame(key, sessionId, 1, withoutField, "client-to-broker"), PtyProtocolError);
	});

	it("refuses a frame above the bound instead of buffering it", () => {
		const key = derivePtySessionKey(createPtyToken(), createPtyNonce(), createPtyNonce());
		const sessionId = derivePtySessionId(key);
		const huge = `${"x".repeat(300 * 1024)}`;
		assert.throws(() => parsePtyFrame(key, sessionId, 1, huge, "broker-to-client"), PtyProtocolError);
	});
});

describe("output chunking", () => {
	it("splits long output at the limit, never inside a surrogate pair", () => {
		assert.deepEqual(chunkPtyOutput(""), []);
		assert.deepEqual(chunkPtyOutput("abc"), ["abc"]);
		const long = "a".repeat(10);
		assert.deepEqual(chunkPtyOutput(long, 4), ["aaaa", "aaaa", "aa"]);
		// A pair straddling the boundary moves whole into the next chunk.
		const pair = `${"a".repeat(3)}\u{1f600}b`;
		const chunks = chunkPtyOutput(pair, 4);
		assert.equal(chunks.join(""), pair);
		for (const chunk of chunks) {
			const last = chunk.charCodeAt(chunk.length - 1);
			assert.equal(last >= 0xd800 && last <= 0xdbff, false, "a chunk ended on a high surrogate");
		}
	});
});

describe("field guards", () => {
	it("accepts only the forms the protocol carries", () => {
		assert.equal(isPtyCreationTime("134349421014308869"), true);
		assert.equal(isPtyCreationTime("0"), false);
		assert.equal(isPtyCreationTime(134349421014308869), false);
		assert.equal(isPtyFrontendId("panel:1"), true);
		assert.equal(isPtyFrontendId("has space"), false);
		assert.equal(isPtyFrontendId(""), false);
		assert.equal(parsePtyTitle("  omp  "), "omp");
		assert.equal(parsePtyTitle("   "), null);
		assert.deepEqual(clampPtySize(200, 50, { cols: 80, rows: 24 }), { cols: 200, rows: 50 });
		assert.deepEqual(clampPtySize(1, 9000, { cols: 80, rows: 24 }), { cols: 2, rows: 500 });
		assert.deepEqual(clampPtySize("wide", null, { cols: 80, rows: 24 }), { cols: 80, rows: 24 });
		assert.equal(isPtyStatusPayload({}), false);
		// The owner hint is three live ids, and a process cannot be its own owner.
		assert.equal(isPtyOwnerHint({ extensionHostPid: 11, parentPid: 22, mainPid: 22 }), true);
		assert.equal(isPtyOwnerHint({ extensionHostPid: 11, parentPid: 11, mainPid: 11 }), false);
		assert.equal(isPtyOwnerHint({ extensionHostPid: 11, parentPid: 0, mainPid: 22 }), false);
		assert.equal(isPtyOwnerHint({ extensionHostPid: 11.5, parentPid: 22, mainPid: 22 }), false);
		assert.equal(isPtyOwnerHint({ extensionHostPid: "11", parentPid: 22, mainPid: 22 }), false);
		// The owner-stop status is a closed vocabulary with bounded detail.
		const owner = { pid: 22, creationTime: "134349421014308869", signaled: false, admittedAtMs: 3 };
		assert.equal(isPtyOwnerStopStatus({ state: "armed", detail: "watching main 22", owners: [owner], graceRemainingMs: 10 }), true);
		assert.equal(isPtyOwnerStopStatus({ state: "armed", detail: "watching main 22", owners: [owner], graceRemainingMs: null }), true);
		assert.equal(isPtyOwnerStopStatus({ state: "armed", detail: "x", owners: [{ ...owner, creationTime: "later" }], graceRemainingMs: null }), false);
		assert.equal(isPtyOwnerStopStatus({ state: "watching", detail: "x", owners: [], graceRemainingMs: null }), false);
		assert.equal(isPtyOwnerStopStatus({ state: "armed", detail: "x".repeat(PTY_MAX_OWNER_DETAIL_CHARS + 1), owners: [], graceRemainingMs: null }), false);
		assert.equal(isPtyOwnerStopStatus({ state: "armed", detail: "x", owners: [], graceRemainingMs: -1 }), false);
	});
});

/**
 * FILETIME ticks are the only place a kernel creation time becomes a comparable
 * instant, so everything they cannot represent answers `null` instead of being
 * rounded into a plausible time.
 */
describe("creation time conversion", () => {
	it("converts the dialect's ticks to whole epoch milliseconds", () => {
		assert.equal(filetimeToEpochMs("134349768000000000"), Date.parse("2026-09-27T10:00:00.000Z"));
		// The 100 ns resolution is truncated toward the earlier millisecond, never
		// rounded up into a later one.
		assert.equal(filetimeToEpochMs("134349768000009999"), Date.parse("2026-09-27T10:00:00.000Z"));
		assert.equal(filetimeToEpochMs("116444736000000000"), 0);
	});

	it("answers nothing for a reading it cannot compare", () => {
		for (const value of ["0", "", "not-a-time", "134349421014308869n", 134349421014308869, null, undefined]) {
			assert.equal(filetimeToEpochMs(value), null, `${String(value)} was converted`);
		}
		// Before the Unix epoch, and past what Number holds exactly.
		assert.equal(filetimeToEpochMs("116444735999990000"), null);
		assert.equal(filetimeToEpochMs("99999999999999999999"), null);
	});
});

/**
 * The managed-rpc additions (ADR-0038): a new kind and additive `rpc-*` frames, with the
 * protocol and runtime versions deliberately unchanged so a surviving previous-build broker
 * of either older kind stays reachable.
 */
describe("managed-rpc kind and frames", () => {
	it("adds a kind without stranding the previous build's kinds or its versions", () => {
		for (const kind of ["managed-rpc", "managed-omp", "folder-shell"] as const) {
			assert.equal(isPtyKind(kind), true);
			assert.equal(parsePtyBrokerRecord(JSON.parse(JSON.stringify(record({ kind })))).kind, kind);
		}
		assert.equal(isPtyKind("managed-tui"), false);
		// A record's protocolVersion is bound into the handshake MAC and compared on attach; a
		// bump would make every previous-build broker unreachable.
		assert.equal(PTY_PROTOCOL_VERSION, 2);
		assert.equal(PTY_RUNTIME_VERSION, 2);
	});

	it("keeps terminal-only and rpc-only requests apart, so each kind can refuse the other's", () => {
		for (const type of ["attach", "snapshot", "input", "resize"]) {
			assert.equal(isPtyTerminalOnlyRequest(type), true, type);
			assert.equal(isPtyRpcOnlyRequest(type), false, type);
		}
		for (const type of ["rpc-attach", "rpc-write"]) {
			assert.equal(isPtyRpcOnlyRequest(type), true, type);
			assert.equal(isPtyTerminalOnlyRequest(type), false, type);
		}
		// Kind-independent requests belong to neither family: every broker answers them.
		for (const type of ["status", "claim-input", "release-input", "stop", "shutdown", "admit-owner"]) {
			assert.equal(isPtyRpcOnlyRequest(type) || isPtyTerminalOnlyRequest(type), false, type);
		}
	});

	it("carries each rpc frame only in the direction it belongs to", () => {
		const key = derivePtySessionKey(createPtyToken(), createPtyNonce(), createPtyNonce());
		const sessionId = derivePtySessionId(key);
		const v = PTY_PROTOCOL_VERSION;
		const data = Buffer.from('{"type":"ready"}').toString("base64");
		const requests = [
			{ v, t: "rpc-attach", id: 1, sinceSeq: 0 },
			{ v, t: "rpc-write", id: 2, frontendId: "rpc:abc", writeId: "w1", index: 0, count: 1, data },
		] as const;
		const events = [
			{
				v,
				t: "rpc-attached",
				id: 1,
				fromSeq: 0,
				oldestSeq: 3,
				latestSeq: 9,
				truncated: false,
				pinnedOverflow: false,
				rpcProtocol: 2,
				ready: '{"type":"ready"}',
				child: statusFixture(),
			},
			{ v, t: "rpc-line", lineSeq: 4, index: 0, count: 1, data },
			{ v, t: "rpc-ready", rpcProtocol: 2, ready: '{"type":"ready"}' },
			{ v, t: "rpc-stderr", data: "warn" },
		] as const;
		for (const request of requests) {
			const line = encodePtyFrame(key, sessionId, 1, request as never);
			assert.equal(parsePtyFrame(key, sessionId, 1, line, "client-to-broker").t, request.t);
			assert.throws(() => parsePtyFrame(key, sessionId, 1, line, "broker-to-client"), PtyProtocolError, request.t);
		}
		for (const event of events) {
			const line = encodePtyFrame(key, sessionId, 1, event as never);
			assert.equal(parsePtyFrame(key, sessionId, 1, line, "broker-to-client").t, event.t);
			assert.throws(() => parsePtyFrame(key, sessionId, 1, line, "client-to-broker"), PtyProtocolError, event.t);
		}
	});

	it("refuses an rpc frame whose fragment position, encoding or ids are wrong", () => {
		const key = derivePtySessionKey(createPtyToken(), createPtyNonce(), createPtyNonce());
		const sessionId = derivePtySessionId(key);
		const v = PTY_PROTOCOL_VERSION;
		const good = Buffer.from("x").toString("base64");
		const refused = (body: Record<string, unknown>, direction: "client-to-broker" | "broker-to-client"): void => {
			const line = encodePtyFrame(key, sessionId, 1, body as never);
			assert.throws(() => parsePtyFrame(key, sessionId, 1, line, direction), PtyProtocolError, JSON.stringify(body).slice(0, 60));
		};
		refused({ v, t: "rpc-line", lineSeq: 1, index: 1, count: 1, data: good }, "broker-to-client");
		refused({ v, t: "rpc-line", lineSeq: 1, index: 0, count: 0, data: good }, "broker-to-client");
		refused({ v, t: "rpc-line", lineSeq: 1, index: 0, count: 1, data: "not base64!" }, "broker-to-client");
		refused({ v, t: "rpc-line", lineSeq: 1, index: 0, count: 1, data: "QQ" }, "broker-to-client");
		// A pushed line names no request: an id on it is not a frame the broker sends.
		refused({ v, t: "rpc-line", id: 3, lineSeq: 1, index: 0, count: 1, data: good }, "broker-to-client");
		refused({ v, t: "rpc-write", id: 1, frontendId: "bad id", writeId: "w1", index: 0, count: 1, data: good }, "client-to-broker");
		refused({ v, t: "rpc-write", id: 1, frontendId: "rpc:a", writeId: "w1", index: 0, count: 1 }, "client-to-broker");
		refused({ v, t: "rpc-attach", id: 1, sinceSeq: -1 }, "client-to-broker");
		refused({ v, t: "rpc-ready", rpcProtocol: 3, ready: "{}" }, "broker-to-client");
	});
});

describe("rpc line fragments", () => {
	it("round-trips a quote-dense 1 MiB line, each fragment far below the frame bound", () => {
		// Escaping a line as JSON text would double every quote and backslash; base64 makes the size independent of content.
		const line = JSON.stringify({ type: "message_update", text: '"\\\\"'.repeat(131_072) });
		const bytes = Buffer.from(line, "utf8");
		assert.ok(bytes.length > 1024 * 1024, "fixture must exceed 1 MiB");
		const count = ptyRpcFragmentCount(bytes.length);
		assert.equal(count, Math.ceil(bytes.length / PTY_RPC_FRAGMENT_RAW_BYTES));
		const key = derivePtySessionKey(createPtyToken(), createPtyNonce(), createPtyNonce());
		const sessionId = derivePtySessionId(key);
		const assembler = new PtyRpcFragmentAssembler(16 * 1024 * 1024);
		let assembled: Buffer | null = null;
		for (let index = 0; index < count; index += 1) {
			const encoded = encodePtyFrame(key, sessionId, index + 1, {
				v: PTY_PROTOCOL_VERSION,
				t: "rpc-line",
				lineSeq: 7,
				index,
				count,
				data: ptyRpcFragment(bytes, index),
			});
			assert.ok(Buffer.byteLength(encoded, "utf8") < PTY_MAX_FRAME_BYTES / 1.5, "a fragment frame must sit well under the bound");
			const frame = parsePtyFrame(key, sessionId, index + 1, encoded, "broker-to-client");
			assert.equal(frame.t, "rpc-line");
			if (frame.t !== "rpc-line") continue;
			assembled = assembler.push(frame.lineSeq, frame.index, frame.count, frame.data);
			assert.equal(assembled === null, index < count - 1);
		}
		assert.equal(assembled?.toString("utf8"), line);
	});

	it("joins bytes before decoding, so a fragment may end inside a UTF-8 sequence", () => {
		// A 3-byte character straddles the boundary when the prefix is not a multiple of 3.
		const line = `a${"€".repeat(PTY_RPC_FRAGMENT_RAW_BYTES)}`;
		const bytes = Buffer.from(line, "utf8");
		const count = ptyRpcFragmentCount(bytes.length);
		assert.ok(count >= 3);
		const assembler = new PtyRpcFragmentAssembler(16 * 1024 * 1024);
		let out: Buffer | null = null;
		for (let index = 0; index < count; index += 1) out = assembler.push("k", index, count, ptyRpcFragment(bytes, index));
		assert.equal(out?.toString("utf8"), line);
	});

	it("gives an empty line one fragment and refuses fragments that are not contiguous or in order", () => {
		assert.equal(ptyRpcFragmentCount(0), 1);
		const bytes = Buffer.alloc(PTY_RPC_FRAGMENT_RAW_BYTES * 3, 0x61);
		const fragment = (index: number): string => ptyRpcFragment(bytes, index);
		const assembler = new PtyRpcFragmentAssembler(1024 * 1024);
		// A line must start at index 0: a reattach that began mid-line is a protocol error, never a guess.
		assert.throws(() => assembler.push(1, 1, 3, fragment(1)), PtyProtocolError);
		assert.equal(assembler.push(1, 0, 3, fragment(0)), null);
		assert.equal(assembler.open, true);
		assert.throws(() => assembler.push(1, 2, 3, fragment(2)), PtyProtocolError, "a skipped index");
		assert.equal(assembler.open, false, "a refusal forgets the partial line");
		assert.equal(assembler.push(1, 0, 3, fragment(0)), null);
		assert.throws(() => assembler.push(2, 1, 3, fragment(1)), PtyProtocolError, "another line's fragment");
		assert.equal(assembler.push(3, 0, 3, fragment(0)), null);
		assembler.reset();
		assert.equal(assembler.open, false);
	});

	it("refuses a line past its bound with a typed error, so a writer is refused rather than disconnected", () => {
		const bytes = Buffer.alloc(PTY_RPC_FRAGMENT_RAW_BYTES * 3, 0x61);
		const assembler = new PtyRpcFragmentAssembler(PTY_RPC_FRAGMENT_RAW_BYTES * 2);
		assert.equal(assembler.push("w", 0, 3, ptyRpcFragment(bytes, 0)), null);
		assert.equal(assembler.push("w", 1, 3, ptyRpcFragment(bytes, 1)), null);
		assert.throws(() => assembler.push("w", 2, 3, ptyRpcFragment(bytes, 2)), PtyRpcLineTooLongError);
	});

	it("accepts only strict base64 of at most one fragment", () => {
		assert.equal(isPtyRpcBase64(""), true);
		assert.equal(isPtyRpcBase64("QUJD"), true);
		assert.equal(isPtyRpcBase64("QUI="), true);
		assert.equal(isPtyRpcBase64("QU"), false);
		assert.equal(isPtyRpcBase64("QU\nJD"), false);
		assert.equal(isPtyRpcBase64("QUJD".repeat(PTY_RPC_FRAGMENT_RAW_BYTES)), false);
	});
});

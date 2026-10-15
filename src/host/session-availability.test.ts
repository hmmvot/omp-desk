/**
 * Tests for the ownership-verdict policy: which absence evidence a recorded row
 * accepts and how an ownership verdict becomes a row's availability.
 *
 * The policy is pure, so the rows here are literals: no index, claim directory or
 * launcher is needed to decide what a verdict means.
 *
 * Runner: `node:test`. Run with
 * `node --test --experimental-strip-types src/host/session-availability.test.ts`.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { acceptOwnerAbsenceEvidence, classifySessionAvailability } from "./session-availability.ts";
import type { AttachPin } from "./session-availability.ts";
import { createOwnerGeneration } from "./session-claim.ts";
import type { ObservedClaim } from "./session-claim.ts";
import type { OmpHostHandle, RecordedHost, SessionIndexEntry } from "./session-model.ts";

/** The broker slot the attachable fixtures prove. */
const PROVEN_BROKER_SLOT = "host:3f0f0f0f-0000-4000-8000-000000000001";

/** A reserved draft tab as the index holds it: a draft identity, no file, no recorded host. */
function draftEntry(): SessionIndexEntry {
	return {
		tabId: "tab:draft",
		kind: "draft",
		origin: "extension",
		sessionFile: null,
		sessionId: null,
		cwd: "c:\\projects\\one",
		scope: { profile: null, sessionDir: null },
		sessionDir: null,
		ownership: { ownerGeneration: "generation-of-record", draftIdentity: "draft:one", releasedAt: null },
		host: null,
		createdAt: "2026-09-24T10:00:00.000Z",
		lastActiveAt: "2026-09-24T10:00:00.000Z",
		ordinal: 1,
		availability: "draft",
		detail: null,
		runIntent: "stopped",
		title: null,
		lastCompletedReplyId: null,
		lastSeenReplyId: null,
	};
}

/** A host the rpc broker launched: the OMP child's pid plus the broker/child identity the row records. */
function runningHandle(sessionId = "S-ATTACH"): OmpHostHandle & { pid: number } {
	return {
		pid: 4242,
		sessionId,
		rpc: {
			slot: PROVEN_BROKER_SLOT,
			brokerId: "broker-id-of-record",
			brokerGeneration: "broker-generation-of-record",
			brokerPid: 4141,
			brokerCreationTime: "133700000000000000",
			childPid: 4242,
			childCreationTime: "133700000000000000",
		},
	};
}

/** A materialized row whose recorded host is `handle`: the shape a reload finds after a launch. */
function recordedEntry(handle: OmpHostHandle): SessionIndexEntry {
	return {
		...draftEntry(),
		kind: "session",
		sessionFile: "c:\\projects\\one\\2026-09-24T10-00-00_S-ATTACH.jsonl",
		sessionId: handle.sessionId,
		availability: "saved",
		runIntent: "running",
		host: {
			pid: handle.pid,
			instanceId: null,
			generation: null,
			sessionId: handle.sessionId,
			startedAt: "2026-09-24T10:01:00.000Z",
			transport: "rpc",
			rpc: handle.rpc,
		},
	};
}

/** The broker transport a reconciler proves for an attachable verdict about `host`. */
function provenPin(host: OmpHostHandle): AttachPin {
	return {
		kind: "broker",
		slot: PROVEN_BROKER_SLOT,
		brokerId: "broker-id-of-record",
		brokerGeneration: "broker-generation-of-record",
		brokerPid: 4242,
		brokerCreationTime: "133700000000000000",
		nativePid: host.pid ?? 900,
		nativeCreationTime: "133700000000000000",
	};
}

describe("availability policy", () => {
	it("never accepts absence evidence about a host this index never launched", () => {
		const entry = draftEntry();
		const rpc = {
			slot: PROVEN_BROKER_SLOT,
			brokerId: "broker-id",
			brokerGeneration: "broker-gen-9",
			brokerPid: 800,
			brokerCreationTime: "133700000000000001",
			childPid: 900,
			childCreationTime: "133700000000000002",
		};
		const gone = {
			kind: "recorded-broker-and-child-gone",
			slot: rpc.slot,
			brokerGeneration: rpc.brokerGeneration,
			childPid: 900,
			childCreationTime: rpc.childCreationTime,
		} as const;
		const exited = {
			kind: "broker-child-exited",
			slot: rpc.slot,
			childPid: 900,
			brokerGeneration: rpc.brokerGeneration,
		} as const;
		assert.equal(acceptOwnerAbsenceEvidence(entry, { kind: "no-recorded-host" }), true);
		assert.equal(acceptOwnerAbsenceEvidence(entry, { kind: "claim-released" }), false);
		assert.equal(acceptOwnerAbsenceEvidence(entry, gone), false);
		assert.equal(acceptOwnerAbsenceEvidence(entry, exited), false);

		const recordedHost: RecordedHost = {
			pid: 900,
			instanceId: null,
			generation: null,
			sessionId: "S",
			startedAt: "2026-09-24T11:00:00.000Z",
			transport: "rpc",
			rpc,
		};
		const withHost: SessionIndexEntry = { ...entry, host: recordedHost };
		assert.equal(acceptOwnerAbsenceEvidence(withHost, { kind: "no-recorded-host" }), false);
		assert.equal(acceptOwnerAbsenceEvidence(withHost, gone), true);
		assert.equal(acceptOwnerAbsenceEvidence(withHost, exited), true);
		// Every fact of the recorded identity must match: another slot, broker
		// generation, child pid or child creation time is a different process.
		assert.equal(acceptOwnerAbsenceEvidence(withHost, { ...gone, slot: "host:other" }), false);
		assert.equal(acceptOwnerAbsenceEvidence(withHost, { ...gone, brokerGeneration: "broker-gen-other" }), false);
		assert.equal(acceptOwnerAbsenceEvidence(withHost, { ...gone, childPid: 901 }), false);
		assert.equal(acceptOwnerAbsenceEvidence(withHost, { ...gone, childCreationTime: "133700000000000003" }), false);
		assert.equal(acceptOwnerAbsenceEvidence(withHost, { ...exited, childPid: 901 }), false);
		assert.equal(acceptOwnerAbsenceEvidence(withHost, { ...exited, brokerGeneration: "broker-gen-other" }), false);

		// A launch attempt whose outcome was never read names no child at all, so
		// nothing that is later observed gone can prove anything about it.
		const unread: SessionIndexEntry = {
			...withHost,
			host: { ...recordedHost, pid: null, rpc: { ...rpc, childPid: null, childCreationTime: null } },
		};
		assert.equal(acceptOwnerAbsenceEvidence(unread, gone), false);
		assert.equal(acceptOwnerAbsenceEvidence(unread, exited), false);
		assert.equal(acceptOwnerAbsenceEvidence(unread, { kind: "no-recorded-host" }), false);

		// A legacy record has no creation time to compare: only the reporting child's
		// pid can be matched, and the combined item is never accepted for it.
		const legacy: SessionIndexEntry = { ...withHost, host: { ...recordedHost, transport: undefined, rpc: undefined } };
		assert.equal(acceptOwnerAbsenceEvidence(legacy, gone), false);
		assert.equal(acceptOwnerAbsenceEvidence(legacy, { ...exited, brokerGeneration: null }), true);
		assert.equal(acceptOwnerAbsenceEvidence(legacy, { ...exited, childPid: 901, brokerGeneration: null }), false);

		// A release that predates the recorded host does not clear it.
		const staleRelease: SessionIndexEntry = {
			...withHost,
			ownership: {
				ownerGeneration: entry.ownership?.ownerGeneration ?? "g",
				draftIdentity: null,
				releasedAt: "2026-09-24T09:00:00.000Z",
			},
		};
		assert.equal(acceptOwnerAbsenceEvidence(staleRelease, { kind: "claim-released" }), false);
	});

	it("binds attach to the recorded broker child independently of stale or missing claims", () => {
		const handle = runningHandle();
		const entry = recordedEntry(handle);
		const generation = entry.ownership?.ownerGeneration;
		assert.ok(generation);

		const observed = (ownerGeneration: string): ObservedClaim => ({
			claimPath: "claims/session.claim",
			normalizedIdentity: "identity",
			verifiable: true,
			ownerGeneration,
			holderId: "holder-of-record",
			identity: null,
			pid: 1,
			createdAt: "2026-09-24T10:00:00.000Z",
		});
		const pin = provenPin(handle);
		const classify = (claim: ObservedClaim | null, host: OmpHostHandle = handle) =>
			classifySessionAvailability({
				entry,
				fileExists: true,
				claim,
				localLive: false,
				verdict: { kind: "attachable", host, pin, detail: "same pid, same broker child" },
			});

		const ours = classify(observed(generation));
		assert.equal(ours.availability, "live");
		assert.deepEqual(ours.attachableHost?.rpc, handle.rpc);
		assert.equal(ours.attachPin, pin, "the transport a verdict proved is published with its host");

		assert.deepEqual(classify(null).attachableHost, handle, "missing claims do not undo positive exact-broker identity");
		const foreign = classify(observed(createOwnerGeneration()));
		assert.deepEqual(foreign.attachableHost, handle, "claim acquisition separately excludes only verified-live rivals");

		// A host that does not match the recorded pid is only a live conflict.
		const mismatched = classify(observed(generation), { ...handle, pid: 999 });
		assert.equal(mismatched.availability, "live");
		assert.equal(mismatched.attachableHost, null);
		assert.match(mismatched.detail, /cannot prove it is the one it started/);
	});

	describe("a live host whose OMP session id was never recorded (a reload right after New Session)", () => {
		const idless = (handle: OmpHostHandle): OmpHostHandle => ({ ...handle, sessionId: null });
		const attachable = (entry: SessionIndexEntry, host: OmpHostHandle) => classifySessionAvailability({
			entry, fileExists: entry.sessionFile !== null, claim: null, localLive: false,
			verdict: { kind: "attachable", host, pin: provenPin(host), detail: "This session is running. Resume to reconnect to it." },
		});

		it("is attachable for a fileless row, so its session learns the id from the process", () => {
			const handle = idless(runningHandle());
			const entry: SessionIndexEntry = { ...recordedEntry(handle), kind: "draft", sessionFile: null, sessionId: null, availability: "draft" };
			const classified = attachable(entry, handle);
			assert.equal(classified.availability, "live");
			assert.deepEqual(classified.attachableHost, handle);
		});

		it("is attachable for a row with a file but no recorded id: the session checks the process against the file", () => {
			const handle = idless(runningHandle());
			const entry: SessionIndexEntry = { ...recordedEntry(handle), sessionId: null };
			assert.deepEqual(attachable(entry, handle).attachableHost, handle);
		});

		it("still refuses a reported id that differs from the recorded one, and says what to do", () => {
			const recorded = runningHandle("S-RECORDED");
			const entry = recordedEntry(recorded);
			const switched = attachable(entry, runningHandle("S-OTHER"));
			assert.equal(switched.attachableHost, null);
			assert.match(switched.detail, /does not match the recorded one/);
			assert.match(switched.detail, /Stop or Kill/);
			assert.doesNotMatch(switched.detail, /Resume to reconnect/, "no advice that cannot work");
		});
	});
});

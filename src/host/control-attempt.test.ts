/**
 * Tests for the control-attempt fence (policy predicates).
 *
 * These are synchronous predicate cases, not an asynchronous integration test: the
 * extension host's publication sites have no unit seam, so each predicate is checked
 * against the argument shapes those sites actually pass.
 *
 * The identity that matters is the **runtime object**, not the PID: an OS can reuse a
 * PID, so a stale attempt that verified a process which has since exited must not be
 * able to publish into the tab that replaced it. A runtime is a fresh object for every
 * launch or attach — including a restored one whose own `processCreation` is null — so
 * object identity is the generation check.
 *
 * Runner: `node --test src/host/control-attempt.test.ts`.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	isOpenControlClient,
	mayPublishControlChannel,
	mayRefreshControlSnapshot,
	mayReportControlFailure,
	type ControlAttemptPlan,
} from "./control-attempt.ts";

/** A client whose proof refuses, exactly as a closed host-control client behaves. */
function closedClient(): { readonly peerProof: unknown } {
	return {
		get peerProof(): unknown {
			throw new Error("client is closed");
		},
	};
}

/** The channels and runtimes are compared by identity, so plain markers are enough. */
const CHANNEL_A = { name: "channel-a" };
const CHANNEL_B = { name: "channel-b" };
/** Runtime A: a fresh launch. */
const RUNTIME_A = { pid: 4242, processCreation: "133400000000000001" };
/** The replacement: the OS reused A's PID for a later process. */
const RUNTIME_REUSED_PID = { pid: 4242, processCreation: "133400000000000009" };
/** A restored runtime: the same process, but a distinct object with no creation time. */
const RUNTIME_RESTORED = { pid: 4242, processCreation: null };
const PID_A = RUNTIME_A.pid;

describe("mayPublishControlChannel", () => {
	it("publishes the first channel for the tab's own runtime", () => {
		const target = { runtime: RUNTIME_A, runtimePid: PID_A, controlClient: null };
		assert.equal(mayPublishControlChannel(target, { runtime: RUNTIME_A, pid: PID_A, client: CHANNEL_A }), true);
	});

	it("refuses a stale attempt whose PID was reused by a replacement", () => {
		// The whole point of comparing runtime identity: the PID agrees, and a PID-only
		// check would publish an old attempt's channel into the new process's tab.
		assert.equal(
			mayPublishControlChannel(
				{ runtime: RUNTIME_REUSED_PID, runtimePid: PID_A, controlClient: null },
				{ runtime: RUNTIME_A, pid: PID_A, client: CHANNEL_A },
			),
			false,
			"the same PID is not the same runtime",
		);
		assert.equal(
			mayPublishControlChannel(
				{ runtime: RUNTIME_RESTORED, runtimePid: PID_A, controlClient: null },
				{ runtime: RUNTIME_A, pid: PID_A, client: CHANNEL_A },
			),
			false,
			"nor is a restored runtime the one a launch attempt started for",
		);
	});

	it("drops a late success after the runtime was replaced or closed", () => {
		assert.equal(
			mayPublishControlChannel({ runtime: null, runtimePid: null, controlClient: null }, { runtime: RUNTIME_A, pid: PID_A, client: CHANNEL_A }),
			false,
			"the tab runs nothing now",
		);
		assert.equal(mayPublishControlChannel(null, { runtime: RUNTIME_A, pid: PID_A, client: CHANNEL_A }), false);
	});

	it("never overwrites a channel a newer attempt already established", () => {
		assert.equal(
			mayPublishControlChannel(
				{ runtime: RUNTIME_A, runtimePid: PID_A, controlClient: CHANNEL_B },
				{ runtime: RUNTIME_A, pid: PID_A, client: CHANNEL_A },
			),
			false,
			"the tab already speaks through B",
		);
	});

	it("refuses an attempt that produced no channel, or that has no runtime or PID", () => {
		assert.equal(
			mayPublishControlChannel({ runtime: RUNTIME_A, runtimePid: PID_A, controlClient: null }, { runtime: RUNTIME_A, pid: PID_A, client: null }),
			false,
		);
		assert.equal(
			mayPublishControlChannel({ runtime: RUNTIME_A, runtimePid: PID_A, controlClient: null }, { runtime: null, pid: PID_A, client: CHANNEL_A }),
			false,
			"an attempt with no runtime identity cannot prove it owns the tab",
		);
		assert.equal(
			mayPublishControlChannel({ runtime: RUNTIME_A, runtimePid: PID_A, controlClient: null }, { runtime: RUNTIME_A, pid: null, client: CHANNEL_A }),
			false,
		);
	});
});

describe("mayReportControlFailure", () => {
	it("reports a failure for the attempt that still owns the tab", () => {
		assert.equal(
			mayReportControlFailure({ runtime: RUNTIME_A, runtimePid: PID_A, controlClient: null }, { runtime: RUNTIME_A, pid: PID_A, client: null }),
			true,
		);
		assert.equal(
			mayReportControlFailure(
				{ runtime: RUNTIME_A, runtimePid: PID_A, controlClient: CHANNEL_A },
				{ runtime: null, pid: null, client: CHANNEL_A },
			),
			true,
			"a failed read back speaks for the channel it read from",
		);
	});

	it("ignores a channel-less failure while the tab holds another attempt's channel", () => {
		// The shape `establishControl` actually uses for an establishment failure: no
		// client of its own. The same runtime is not ownership — a newer attempt already
		// published a channel on this tab, and this failure must not clear it.
		assert.equal(
			mayReportControlFailure(
				{ runtime: RUNTIME_A, runtimePid: PID_A, controlClient: CHANNEL_B },
				{ runtime: RUNTIME_A, pid: PID_A, client: null },
			),
			false,
			"a rendezvous timeout or handshake failure must not clear channel B",
		);
		assert.equal(
			mayReportControlFailure({ runtime: RUNTIME_A, runtimePid: PID_A, controlClient: null }, { runtime: RUNTIME_A, pid: PID_A, client: null }),
			true,
			"while a tab that holds no channel is the one this failure describes",
		);
	});

	it("ignores a late failure that would land on a replacement runtime", () => {
		assert.equal(
			mayReportControlFailure(
				{ runtime: RUNTIME_REUSED_PID, runtimePid: PID_A, controlClient: null },
				{ runtime: RUNTIME_A, pid: PID_A, client: null },
			),
			false,
			"the PID was reused, so this failure describes a runtime the tab no longer runs",
		);
		assert.equal(
			mayReportControlFailure(
				{ runtime: RUNTIME_A, runtimePid: PID_A, controlClient: CHANNEL_B },
				{ runtime: null, pid: null, client: CHANNEL_A },
			),
			false,
			"the tab holds B; A's failure is not B's",
		);
		assert.equal(mayReportControlFailure(null, { runtime: RUNTIME_A, pid: PID_A, client: null }), false);
	});
});

describe("mayRefreshControlSnapshot", () => {
	it("records a read back only for the channel the tab holds", () => {
		assert.equal(
			mayRefreshControlSnapshot({ runtime: RUNTIME_A, runtimePid: PID_A, controlClient: CHANNEL_A }, CHANNEL_A),
			true,
		);
		assert.equal(
			mayRefreshControlSnapshot({ runtime: RUNTIME_A, runtimePid: PID_A, controlClient: CHANNEL_B }, CHANNEL_A),
			false,
			"a read that finished after the channel was replaced is not recorded",
		);
		assert.equal(mayRefreshControlSnapshot({ runtime: RUNTIME_A, runtimePid: PID_A, controlClient: null }, CHANNEL_A), false);
		assert.equal(mayRefreshControlSnapshot(null, CHANNEL_A), false);
	});
});

describe("the attempt marker survives the caller's awaits", () => {
	/** A promise the test settles by hand, standing in for a caller's own await. */
	function held(): { readonly promise: Promise<void>; readonly release: () => void } {
		const { promise, resolve } = Promise.withResolvers<void>();
		return { promise, release: resolve };
	}

	it("refuses to publish an attempt whose tab moved on during the caller's await", async () => {
		// The production order: the caller captures the marker, then awaits its own work
		// (a persisted launch record, a stored recipient), and only then connects. A
		// replacement that the OS gave the same PID must not receive the old attempt.
		const attempt: ControlAttemptPlan = { runtime: RUNTIME_A, pid: PID_A };
		const callerAwait = held();

		// The tab is replaced while the caller is still awaiting.
		const tab = { runtime: RUNTIME_A as unknown | null, runtimePid: PID_A as number | null, controlClient: null as unknown | null };
		tab.runtime = RUNTIME_REUSED_PID;
		callerAwait.release();
		await callerAwait.promise;

		assert.equal(
			mayPublishControlChannel(tab, { runtime: attempt.runtime, pid: attempt.pid, client: CHANNEL_A }),
			false,
			"the marker was captured before the await, so the fence sees the replacement",
		);
		assert.equal(
			mayReportControlFailure(tab, { runtime: attempt.runtime, pid: attempt.pid, client: null }),
			false,
			"and a late failure must not land on the replacement either",
		);
	});

	it("still publishes when the tab still runs the attempt's own runtime", async () => {
		const attempt: ControlAttemptPlan = { runtime: RUNTIME_A, pid: PID_A };
		const callerAwait = held();
		callerAwait.release();
		await callerAwait.promise;

		const tab = { runtime: RUNTIME_A as unknown | null, runtimePid: PID_A as number | null, controlClient: null as unknown | null };
		assert.equal(mayPublishControlChannel(tab, { runtime: attempt.runtime, pid: attempt.pid, client: CHANNEL_A }), true);
	});
});

describe("isOpenControlClient", () => {
	it("treats a closed held channel as no channel", () => {
		// A closed client keeps its binding readable, so without this a tab would refuse
		// every later attempt because a dead channel still "occupies" it.
		assert.equal(isOpenControlClient(closedClient()), false);
		assert.equal(isOpenControlClient(CHANNEL_A), false, "a value that is not a client proves nothing");
		assert.equal(isOpenControlClient(null), false);

		const open = { peerProof: { serverPid: PID_A, serverCreationTime: "133400000000000001" } };
		assert.equal(isOpenControlClient(open), true);
	});
});

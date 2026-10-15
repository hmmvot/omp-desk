/**
 * A host that is busy is not a host that is gone: what the window says about each.
 *
 * Runner: `node --test src/runtime/local-control.test.ts`.
 */
import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { HostControlPeerError, HostControlRefusedError, HostControlUnavailableError } from "../host/control-client.ts";
import type { HostControlClient } from "../host/control-client.ts";
import { recordingLogger } from "../shared/logger.ts";
import type { LoggedLine } from "../shared/logger.ts";
import { controlProcessRecordKey, describeControlError, LocalHostControl } from "./local-control.ts";
import type { RecordedControlProcess } from "./local-control.ts";
import type { RuntimeRecord } from "./runtime-record.ts";

const TAB = "tab:one";

function fixture(): { readonly control: LocalHostControl; readonly record: RuntimeRecord; readonly logs: LoggedLine[]; readonly closed: () => number } {
	let closes = 0;
	const client = { close: () => { closes += 1; } } as unknown as HostControlClient;
	const record = {
		tabId: TAB, slotId: "slot-1", runtime: null, control: { client, snapshot: null, activity: true }, controlFailure: null as string | null,
		endedNotice: null, transitioning: false, nativeWatch: null, pipeline: null,
	} satisfies RuntimeRecord as RuntimeRecord;
	const logs: LoggedLine[] = [];
	const control = new LocalHostControl({
		records: { get: (tabId: string | null) => tabId === TAB ? record : undefined } as never,
		log: recordingLogger(logs),
	} as never);
	return { control, record, logs, closed: () => closes };
}

describe("host control failure reporting", () => {
	it("calls a host that did not answer in time busy, not unavailable, and shows no warning for it", () => {
		const { control, record, logs, closed } = fixture();
		const busy = new HostControlUnavailableError("host did not answer nativeState in time", { timedOut: true });
		control.reportFailure(TAB, busy);
		assert.equal(record.controlFailure, null, "the text that becomes a warning above the terminal stays empty");
		assert.equal(record.control, null, "the channel is dropped so the next attempt starts clean");
		assert.equal(closed(), 1);
		assert.match(logs.map(line => line.message).join("\n"), /host control paused — OMP did not answer in time \(it may be busy\)/);
		assert.doesNotMatch(logs.map(line => line.message).join("\n"), /it is retried/, "no launch's credentials are known for this record, so nothing is retried and nothing says so");
		assert.deepEqual(logs.map(line => line.level), ["warn"], "a busy host is a degraded state, not a failure");
		assert.doesNotMatch(logs.map(line => line.message).join("\n"), /unavailable/);
	});

	it("keeps recording a host that cannot be reached or refused the request", () => {
		for (const error of [new HostControlUnavailableError("channel is not open"), new HostControlRefusedError("unauthorized", "no", null)]) {
			const { control, record, logs } = fixture();
			control.reportFailure(TAB, error);
			assert.equal(record.controlFailure, describeControlError(error));
			assert.equal(record.control, null);
			assert.match(logs.map(line => line.message).join("\n"), /host control unavailable — /);
		}
		assert.equal(describeControlError(new HostControlUnavailableError("channel is not open")), "native host connection unavailable");
	});
});

describe("a host that did not answer in time is tried again, a bounded number of times", () => {
	const runtime = { kind: "chat", pid: 4242, identity: { slot: "slot-1" } } as never;
	const stored: RecordedControlProcess = { pid: 4242, processCreation: "2026-10-15T00:00:00Z", slotId: "slot-1", directory: "C:/control" };
	const busy = () => new HostControlUnavailableError("host did not answer snapshot in time", { timedOut: true });
	const flush = async () => { for (let turn = 0; turn < 8; turn += 1) await new Promise<void>(resolve => setImmediate(resolve)); };

	function rig(failures: number) {
		mock.timers.enable({ apis: ["setTimeout"] });
		const record = { tabId: TAB, runtime, control: null, controlFailure: null as string | null } as unknown as RuntimeRecord;
		const logs: LoggedLine[] = [];
		let calls = 0;
		const client = { peerProof: {}, close: () => {}, snapshot: async () => ({ host: { instanceId: "inst-1" } }) };
		const control = new LocalHostControl({
			records: { get: (tabId: string | null) => tabId === TAB ? record : undefined } as never,
			store: {
				record: (key: string) => key === controlProcessRecordKey("owner") ? stored : undefined,
				secret: async () => "secret",
				setSecret: async () => {},
			} as never,
			index: { lifecycle: { run: async (_tab: string, work: () => Promise<unknown>) => work() } } as never,
			window: { published: () => {} },
			diagnostics: () => ({ notObserved: () => {}, fail: () => {}, succeed: () => {} }) as never,
			attempts: new WeakMap(),
			stagedHelper: async () => {},
			connection: {
				connectWithProvenKey: async () => {
					calls += 1;
					if (calls <= failures) throw busy();
					return { client, key: "key", rotated: false };
				},
				connectVerified: async () => { throw new Error("not used"); },
			} as never,
			controlRetry: { firstMs: 1, maxMs: 1 },
			log: recordingLogger(logs),
		} as never);
		const messages = () => logs.map(line => line.message);
		return { control, record, logs, messages, calls: () => calls };
	}

	it("brings the channel back once the host answers, and clears the paused state", async () => {
		const f = rig(2);
		try {
			await f.control.reconnect(TAB, "owner", runtime);
			assert.equal(f.calls(), 1);
			assert.equal(f.record.control, null);
			assert.equal(f.record.controlFailure, null, "a busy host is not recorded as unavailable");
			assert.ok(f.messages().some(message => /host control paused — .*it is retried \(1 of 5\)/.test(message)));
			mock.timers.tick(1); await flush();
			assert.equal(f.calls(), 2);
			assert.ok(f.messages().some(message => /it is retried \(2 of 5\)/.test(message)));
			mock.timers.tick(1); await flush();
			assert.equal(f.calls(), 3);
			assert.notEqual(f.record.control, null, "the third attempt reached it");
			assert.ok(f.messages().some(message => /host control verified/.test(message)));
			assert.ok(!f.messages().some(message => /unavailable/.test(message)));
			mock.timers.tick(10); await flush();
			assert.equal(f.calls(), 3, "a success ends the retries");
		} finally { mock.timers.reset(); }
	});

	it("reports host control unavailable once when every try finds it busy", async () => {
		const f = rig(Number.POSITIVE_INFINITY);
		try {
			await f.control.reconnect(TAB, "owner", runtime);
			for (let turn = 0; turn < 10; turn += 1) { mock.timers.tick(1); await flush(); }
			assert.equal(f.calls(), 6, "the attempt and five retries, no more");
			assert.match(f.record.controlFailure ?? "", /did not answer in time.*5 later attempts did not reach it/);
			assert.equal(f.messages().filter(message => /host control unavailable/.test(message)).length, 1);
		} finally { mock.timers.reset(); }
	});

	it("does not retry for a runtime the tab no longer runs", async () => {
		const f = rig(Number.POSITIVE_INFINITY);
		try {
			await f.control.reconnect(TAB, "owner", runtime);
			(f.record as { runtime: unknown }).runtime = { kind: "chat", pid: 4242, identity: { slot: "slot-2" } };
			mock.timers.tick(1); await flush();
			mock.timers.tick(1); await flush();
			assert.equal(f.calls(), 1, "another launch's process is never reconnected with this launch's credentials");
			assert.equal(f.record.controlFailure, null);
		} finally { mock.timers.reset(); }
	});
});

describe("a process-generation probe that does not answer in time (busy machine)", () => {
	const runtime = { kind: "terminal", pid: 4242, identity: { slot: "slot-1" } } as never;
	const prepared = { bootstrap: { slotId: "slot-1", directory: "C:/control" }, privateKeyPkcs8Pem: "pem" } as never;
	const timeout = () => new HostControlPeerError("timeout", "generation probe did not answer in time");

	function probeFixture(answers: readonly (() => Error)[]) {
		const record = { tabId: TAB, runtime, control: null, controlFailure: null as string | null } as unknown as RuntimeRecord;
		const logs: LoggedLine[] = [];
		let calls = 0;
		const control = new LocalHostControl({
			records: { get: (tabId: string | null) => tabId === TAB ? record : undefined } as never,
			attempts: new WeakMap(),
			stagedHelper: async () => {},
			generationProbe: async () => { throw (answers[Math.min(calls++, answers.length - 1)] as () => Error)(); },
			generationProbeRetryDelayMs: 0,
			log: recordingLogger(logs),
		} as never);
		return { control, record, logs, calls: () => calls };
	}

	it("is retried while the tab still runs this process, and does not record a failure meanwhile", async () => {
		const f = probeFixture([timeout, timeout, () => new HostControlPeerError("helper-failed", "generation probe failed: gone")]);
		await f.control.connect(TAB, "owner", runtime, prepared);
		assert.equal(f.calls(), 3, "two timeouts are retried, the first other failure ends it");
		const messages = f.logs.map(line => line.message);
		assert.equal(messages.filter(message => /host control paused — the process generation probe did not answer in time .* it is retried/.test(message)).length, 2);
		assert.match(f.record.controlFailure ?? "", /generation probe failed: gone/);
	});

	it("still ends in a failure when every attempt times out", async () => {
		const f = probeFixture([timeout]);
		await f.control.connect(TAB, "owner", runtime, prepared);
		assert.equal(f.calls(), 4);
		assert.match(f.record.controlFailure ?? "", /the process generation could not be read \(generation probe did not answer in time\)/);
	});

	it("fails at once when the probe fails for any other reason", async () => {
		const f = probeFixture([() => new HostControlPeerError("helper-failed", "generation probe failed: gone")]);
		await f.control.connect(TAB, "owner", runtime, prepared);
		assert.equal(f.calls(), 1);
		assert.match(f.record.controlFailure ?? "", /generation probe failed: gone/);
		assert.doesNotMatch(f.logs.map(line => line.message).join("\n"), /paused/);
	});
});

describe("a host launched without a control channel (ADR-0075)", () => {
	const reason = "this OMP launcher does not accept the startup options host control needs";
	const runtime = { kind: "chat", pid: 4242, identity: { slot: "slot-1" } } as never;
	function withheldFixture(recordedPid: number) {
		const record = { tabId: TAB, runtime, control: null, controlFailure: null as string | null } as unknown as RuntimeRecord;
		const observations: string[] = [];
		const logs: LoggedLine[] = [];
		const stored: RecordedControlProcess = { pid: recordedPid, processCreation: "2026-10-14T00:00:00Z", slotId: "slot-1", directory: "C:/control", withheld: reason };
		const control = new LocalHostControl({
			records: { get: (tabId: string | null) => tabId === TAB ? record : undefined } as never,
			store: { record: (key: string) => key === controlProcessRecordKey("owner") ? stored : undefined, secret: async () => undefined } as never,
			diagnostics: () => ({ notObserved: (_tab: string, _stage: string, detail: string) => observations.push(detail) }) as never,
			attempts: new WeakMap(),
			log: recordingLogger(logs),
		} as never);
		return { control, record, observations, logs };
	}

	it("is not looked for again: a reconnect says why once, and records no failure for the session", async () => {
		const f = withheldFixture(4242);
		await f.control.reconnect(TAB, "owner", runtime);
		assert.equal(f.record.controlFailure, null, "no warning is raised for a launch that was never offered a channel");
		assert.deepEqual(f.observations, [reason]);
		assert.doesNotMatch(f.logs.map(line => line.message).join("\n"), /unavailable|never attempted|no control recipient/);
	});

	it("still reports a different process's missing record as before", async () => {
		const f = withheldFixture(1);
		await f.control.reconnect(TAB, "owner", runtime);
		assert.match(f.record.controlFailure ?? "", /no control recipient was recorded/);
	});
});

describe("a re-adopted host's control proof waits for the staged pipe helper, and only it does", () => {
	const runtime = { kind: "chat", pid: 4242, identity: { slot: "slot-1" } } as never;
	const stored: RecordedControlProcess = { pid: 4242, processCreation: "2026-10-14T00:00:00Z", slotId: "slot-1", directory: "C:/control" };

	function fixture() {
		let release!: () => void;
		const staged = new Promise<void>(resolve => { release = resolve; });
		const events: string[] = [];
		const logs: LoggedLine[] = [];
		const control = new LocalHostControl({
			// No record for the tab: the attempt that starts after the wait finds it no longer owns the tab and ends at once,
			// so the test never reaches the real pipe client.
			records: { get: () => undefined } as never,
			store: {
				record: (key: string) => key === controlProcessRecordKey("owner") ? stored : undefined,
				secret: async (name: string) => name.startsWith("omp.hostControl.recipient.") ? "pem" : undefined,
			} as never,
			diagnostics: () => { events.push("establish"); return {} as never; },
			attempts: new WeakMap(),
			stagedHelper: () => { events.push("staging awaited"); return staged; },
			log: recordingLogger(logs),
		} as never);
		return { control, events, logs, release };
	}

	it("does not start the proof before staging is done, and runs it once staging is", async () => {
		const f = fixture();
		const attempt = f.control.reconnect(TAB, "owner", runtime);
		for (let turn = 0; turn < 5; turn += 1) await new Promise<void>(resolve => setImmediate(resolve));
		assert.deepEqual(f.events, ["staging awaited"], "the proof is held back, not started without the helper");
		f.release();
		await attempt;
		assert.deepEqual(f.events, ["staging awaited", "establish"]);
		assert.match(f.logs.map(line => line.message).join("\n"), /no longer owns this tab/);
	});
});

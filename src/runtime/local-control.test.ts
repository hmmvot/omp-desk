/**
 * A host that is busy is not a host that is gone: what the window says about each.
 *
 * Runner: `node --test src/runtime/local-control.test.ts`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HostControlRefusedError, HostControlUnavailableError } from "../host/control-client.ts";
import type { HostControlClient } from "../host/control-client.ts";
import { controlProcessRecordKey, describeControlError, LocalHostControl } from "./local-control.ts";
import type { RecordedControlProcess } from "./local-control.ts";
import type { RuntimeRecord } from "./runtime-record.ts";

const TAB = "tab:one";

function fixture(): { readonly control: LocalHostControl; readonly record: RuntimeRecord; readonly logs: string[]; readonly closed: () => number } {
	let closes = 0;
	const client = { close: () => { closes += 1; } } as unknown as HostControlClient;
	const record = {
		tabId: TAB, slotId: "slot-1", runtime: null, control: { client, snapshot: null, activity: true }, controlFailure: null as string | null,
		endedNotice: null, transitioning: false, nativeWatch: null, pipeline: null,
	} satisfies RuntimeRecord as RuntimeRecord;
	const logs: string[] = [];
	const control = new LocalHostControl({
		records: { get: (tabId: string | null) => tabId === TAB ? record : undefined } as never,
		log: (message: string) => logs.push(message),
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
		assert.match(logs.join("\n"), /host control paused — OMP did not answer in time \(it may be busy\); it is retried/);
		assert.doesNotMatch(logs.join("\n"), /unavailable/);
	});

	it("keeps recording a host that cannot be reached or refused the request", () => {
		for (const error of [new HostControlUnavailableError("channel is not open"), new HostControlRefusedError("unauthorized", "no", null)]) {
			const { control, record, logs } = fixture();
			control.reportFailure(TAB, error);
			assert.equal(record.controlFailure, describeControlError(error));
			assert.equal(record.control, null);
			assert.match(logs.join("\n"), /host control unavailable — /);
		}
		assert.equal(describeControlError(new HostControlUnavailableError("channel is not open")), "native host connection unavailable");
	});
});

describe("a host launched without a control channel (ADR-0075)", () => {
	const reason = "this OMP launcher does not accept the startup options host control needs";
	const runtime = { kind: "chat", pid: 4242, identity: { slot: "slot-1" } } as never;
	function withheldFixture(recordedPid: number) {
		const record = { tabId: TAB, runtime, control: null, controlFailure: null as string | null } as unknown as RuntimeRecord;
		const observations: string[] = [];
		const logs: string[] = [];
		const stored: RecordedControlProcess = { pid: recordedPid, processCreation: "2026-10-14T00:00:00Z", slotId: "slot-1", directory: "C:/control", withheld: reason };
		const control = new LocalHostControl({
			records: { get: (tabId: string | null) => tabId === TAB ? record : undefined } as never,
			store: { record: (key: string) => key === controlProcessRecordKey("owner") ? stored : undefined, secret: async () => undefined } as never,
			diagnostics: () => ({ notObserved: (_tab: string, _stage: string, detail: string) => observations.push(detail) }) as never,
			attempts: new WeakMap(),
			log: (message: string) => logs.push(message),
		} as never);
		return { control, record, observations, logs };
	}

	it("is not looked for again: a reconnect says why once, and records no failure for the session", async () => {
		const f = withheldFixture(4242);
		await f.control.reconnect(TAB, "owner", runtime);
		assert.equal(f.record.controlFailure, null, "no warning is raised for a launch that was never offered a channel");
		assert.deepEqual(f.observations, [reason]);
		assert.doesNotMatch(f.logs.join("\n"), /unavailable|never attempted|no control recipient/);
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
		const logs: string[] = [];
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
			log: (message: string) => logs.push(message),
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
		assert.match(f.logs.join("\n"), /no longer owns this tab/);
	});
});

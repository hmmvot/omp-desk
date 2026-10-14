/**
 * A host that is busy is not a host that is gone: what the window says about each.
 *
 * Runner: `node --test src/runtime/local-control.test.ts`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HostControlRefusedError, HostControlUnavailableError } from "../host/control-client.ts";
import type { HostControlClient } from "../host/control-client.ts";
import { describeControlError, LocalHostControl } from "./local-control.ts";
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

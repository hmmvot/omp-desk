/**
 * Tests for the stop orchestration of the Sessions view's processes, against fake ports.
 *
 * A stop re-derives its row before anything is asked or done, names what ends in one
 * confirmation, and routes by what the fresh derivation says. The bulk stop never touches
 * a driven, shown or running in-use row, never forces, and reports what it left running. Kill
 * All stops by tier behind one choice, through the same row stop, and reads what is left from
 * the records.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	describeKillAll,
	describeProcess,
	killAll,
	stopOrphanedAndIdle,
	stopProcess,
	stopTargetOf,
} from "./broker-process-controller.ts";
import type { CapturedRowStop, ChoiceRequest, ConfirmRequest, ProcessControllerPorts } from "./broker-process-controller.ts";
import type { BrokerStopMode, BrokerStopOutcome, BrokerStopTarget } from "./broker-process-stop.ts";
import { planKillAll } from "./broker-processes.ts";
import type {
	BrokerProcessReadOptions,
	BrokerProcessRow,
	BrokerProcessSessionHost,
	BrokerProcessTerminalHost,
} from "./broker-processes.ts";

let serial = 0;

function sessionHost(overrides: Partial<BrokerProcessSessionHost> = {}): BrokerProcessSessionHost {
	return {
		kind: "session",
		tabId: "tab-1",
		title: "Fix the build",
		folder: "C:/work/app",
		window: "none",
		drivenHere: false,
		recorded: true,
		...overrides,
	};
}

function terminalHost(overrides: Partial<BrokerProcessTerminalHost> = {}): BrokerProcessTerminalHost {
	return { kind: "terminal", folder: "C:/work/app", label: "app", window: "none", ...overrides };
}

/** A session row of this build, running, in use and recorded by its row unless changed. */
function row(overrides: Partial<BrokerProcessRow> = {}): BrokerProcessRow {
	serial += 1;
	const slot = overrides.slot ?? `tab:${serial}`;
	const brokerId = overrides.brokerId ?? `pty-${serial}`;
	return {
		id: `current|${slot}|${brokerId}`,
		source: "current",
		kind: "session",
		ptyKind: "managed-rpc",
		slot,
		brokerId,
		generation: `gen-${serial}`,
		brokerPid: 4000 + serial,
		brokerCreationTime: `13434942101430${String(serial).padStart(4, "0")}`,
		startedAt: new Date(0).toISOString(),
		uptimeMs: 60_000,
		title: null,
		status: "in-use",
		host: sessionHost(),
		window: "none",
		drivenHere: false,
		child: "running",
		olderBuild: false,
		stop: { available: true },
		...overrides,
	};
}

const orphan = (overrides: Partial<BrokerProcessRow> = {}): BrokerProcessRow =>
	row({ status: "orphaned", host: null, title: "left over", ...overrides });

const terminal = (overrides: Partial<BrokerProcessRow> = {}): BrokerProcessRow =>
	row({
		kind: "terminal",
		ptyKind: "folder-shell",
		status: "in-use",
		host: terminalHost(),
		...overrides,
	});

interface HarnessOptions {
	/** Rows each successive read answers; the last repeats. */
	readonly reads: ReadonlyArray<readonly BrokerProcessRow[]>;
	readonly confirms?: readonly boolean[];
	/** The option id each successive choice answers (`null` is Cancel); `"all"` when omitted. */
	readonly choices?: ReadonlyArray<string | null>;
	readonly outcomes?: ReadonlyArray<BrokerStopOutcome | Error>;
	readonly driven?: CapturedRowStop | null;
	readonly recorded?: CapturedRowStop | null;
	readonly forgetFails?: boolean;
	/** Shared with a captured stop, so a test can assert the order of everything. */
	readonly events?: string[];
}

const STOPPED: BrokerStopOutcome = { kind: "stopped", childWasRunning: true, brokerGone: true, detail: "It is gone." };

function harness(options: HarnessOptions) {
	const events: string[] = options.events ?? [];
	const readOptions: Array<BrokerProcessReadOptions | undefined> = [];
	const confirms: ConfirmRequest[] = [];
	const infos: string[] = [];
	const warns: string[] = [];
	const stops: Array<{ target: BrokerStopTarget; mode: BrokerStopMode }> = [];
	const forgotten: string[] = [];
	const capturedFor: { driven: BrokerProcessRow[]; recorded: BrokerProcessRow[] } = { driven: [], recorded: [] };
	let reads = 0;
	let answers = 0;
	let outcomes = 0;
	let picks = 0;
	const choices: ChoiceRequest[] = [];
	const ports: ProcessControllerPorts = {
		read: async readOptionsArg => {
			readOptions.push(readOptionsArg);
			events.push("read");
			const rows = options.reads[Math.min(reads, options.reads.length - 1)] ?? [];
			reads++;
			return { rows, hidden: 0, unreadable: 0, takenAt: 0 };
		},
		confirm: async request => {
			events.push("confirm");
			confirms.push(request);
			const answer = options.confirms?.[answers] ?? true;
			answers++;
			return answer;
		},
		choose: async request => {
			events.push("choose");
			choices.push(request);
			const answer = options.choices === undefined ? "all" : (options.choices[picks] ?? null);
			picks++;
			return answer;
		},
		withProgress: async (_title, work) => {
			events.push("progress");
			await work();
		},
		info: message => {
			events.push("info");
			infos.push(message);
		},
		warn: message => {
			events.push("warn");
			warns.push(message);
		},
		captureDrivenStop: async target => {
			events.push("captureDriven");
			capturedFor.driven.push(target);
			return options.driven ?? null;
		},
		captureRecordedStop: async target => {
			events.push("captureRecorded");
			capturedFor.recorded.push(target);
			return options.recorded ?? null;
		},
		stopThroughBroker: async (target, mode) => {
			events.push(`stop:${mode}`);
			stops.push({ target, mode });
			const outcome = options.outcomes?.[outcomes] ?? STOPPED;
			outcomes++;
			if (outcome instanceof Error) throw outcome;
			return outcome;
		},
		forgetStoppedSlot: async slot => {
			events.push("forget");
			forgotten.push(slot);
			if (options.forgetFails === true) throw new Error("the mapping could not be saved");
		},
		refresh: async () => {
			events.push("refresh");
		},
	};
	return { ports, events, readOptions, confirms, choices, infos, warns, stops, forgotten, capturedFor };
}

/** A captured row stop that logs when it runs, through the harness's own event log. */
function captured(events: string[]): CapturedRowStop {
	return {
		run: async () => {
			events.push("run");
			return true;
		},
	};
}

describe("stopProcess: a fresh derivation first", () => {
	it("reads fresh, and stops nothing for a row that has vanished", async () => {
		const gone = orphan();
		const { ports, events, readOptions, confirms, stops, warns } = harness({ reads: [[orphan()]] });
		await stopProcess(gone.id, ports);
		assert.deepEqual(readOptions, [{ fresh: true }]);
		assert.equal(warns.length, 1);
		assert.deepEqual(confirms, []);
		assert.deepEqual(stops, []);
		assert.ok(events.includes("refresh"), "the view was not refreshed after finding the row gone");
	});

	it("treats a slot that now names another broker as a vanished row", async () => {
		const shown = orphan({ slot: "tab:shared" });
		const replacement = orphan({ slot: "tab:shared", brokerId: "pty-replacement" });
		const { ports, confirms, stops, warns } = harness({ reads: [[replacement]] });
		await stopProcess(shown.id, ports);
		assert.equal(warns.length, 1);
		assert.deepEqual(confirms, []);
		assert.deepEqual(stops, []);
	});

	it("warns with the row's own reason, and asks nothing, when this build cannot stop it", async () => {
		const blocked = row({ source: "predecessor", status: "unknown", host: null, stop: { available: false, reason: "Close it in the old build." } });
		const { ports, confirms, stops, warns, capturedFor } = harness({ reads: [[blocked]] });
		await stopProcess(blocked.id, ports);
		assert.deepEqual(warns, ["Close it in the old build."]);
		assert.deepEqual(confirms, []);
		assert.deepEqual(stops, []);
		assert.deepEqual(capturedFor, { driven: [], recorded: [] });
	});
});

describe("stopProcess: the row's own flows", () => {
	it("captures a driven row's stop, then runs it at once without asking", async () => {
		const driven = row({ drivenHere: true, host: sessionHost({ drivenHere: true }), window: "this-window" });
		const events: string[] = [];
		const h = harness({ reads: [[driven]], driven: captured(events), events });
		await stopProcess(driven.id, h.ports);
		assert.deepEqual(h.capturedFor.driven.map(target => target.id), [driven.id]);
		assert.deepEqual(h.capturedFor.recorded, []);
		assert.deepEqual(h.stops, []);
		assert.deepEqual(h.confirms, [], "a single stop asks nothing");
		assert.deepEqual(events.filter(event => ["captureDriven", "confirm", "run"].includes(event)), ["captureDriven", "run"]);
	});

	it("runs nothing, and warns, when a driven row's capture comes back empty", async () => {
		const driven = row({ drivenHere: true, host: sessionHost({ drivenHere: true }) });
		const { ports, confirms, stops, warns, events } = harness({ reads: [[driven]], driven: null });
		await stopProcess(driven.id, ports);
		assert.deepEqual(confirms, []);
		assert.deepEqual(stops, []);
		assert.equal(warns.length, 1);
		assert.equal(events.includes("run"), false);
		assert.ok(events.includes("refresh"));
	});

	it("routes a row that records this broker as its host through the recorded capture", async () => {
		const mapped = row();
		const events: string[] = [];
		const h = harness({ reads: [[mapped]], recorded: captured(events), events });
		await stopProcess(mapped.id, h.ports);
		assert.deepEqual(h.capturedFor.recorded.map(target => target.id), [mapped.id]);
		assert.deepEqual(h.capturedFor.driven, []);
		assert.deepEqual(h.stops, []);
		assert.deepEqual(h.confirms, [], "a single stop asks nothing");
		assert.deepEqual(events.filter(event => ["captureRecorded", "confirm", "run"].includes(event)), ["captureRecorded", "run"]);
	});

	it("runs nothing, and warns, when the recorded capture comes back empty", async () => {
		const mapped = row();
		const h = harness({ reads: [[mapped]], recorded: null });
		await stopProcess(mapped.id, h.ports);
		assert.deepEqual(h.confirms, []);
		assert.deepEqual(h.stops, []);
		assert.equal(h.warns.length, 1);
		assert.ok(h.events.includes("refresh"));
	});

	it("never uses a row's own flow for a row whose child has exited, or that has no row to record it", async () => {
		const idle = row({ child: "exited" });
		const editorOnly = row({ host: sessionHost({ tabId: null, recorded: false }) });
		const mappedOnly = row({ host: sessionHost({ recorded: false }) });
		for (const candidate of [idle, editorOnly, mappedOnly]) {
			const h = harness({ reads: [[candidate]], recorded: captured([]), driven: captured([]) });
			await stopProcess(candidate.id, h.ports);
			assert.deepEqual(h.capturedFor, { driven: [], recorded: [] });
			assert.equal(h.stops.length, 1);
		}
	});
});

describe("stopProcess: the broker route", () => {
	it("stops an orphan once, gracefully, with the row's exact target, then refreshes", async () => {
		const target = orphan();
		const h = harness({ reads: [[orphan(), target]] });
		await stopProcess(target.id, h.ports);
		assert.equal(h.stops.length, 1);
		assert.equal(h.stops[0]?.mode, "graceful");
		assert.deepEqual(h.stops[0]?.target, {
			slot: target.slot,
			kind: target.ptyKind,
			brokerId: target.brokerId,
			generation: target.generation,
			brokerPid: target.brokerPid,
			brokerCreationTime: target.brokerCreationTime,
		});
		assert.deepEqual(h.confirms, [], "a single stop asks nothing");
		assert.deepEqual(h.infos, [], "a visibly successful stop needs no toast");
		assert.deepEqual(h.warns, []);
		// The stop runs immediately; the refresh follows it.
		const order = h.events.filter(event => ["confirm", "stop:graceful", "refresh"].includes(event));
		assert.deepEqual(order, ["stop:graceful", "refresh"]);
	});

	it("retires stopped shell records and unowned session mappings, but retains recorded session rows", async () => {
		const stale = orphan();
		const mapped = row({ host: sessionHost({ recorded: false }) });
		const recordedIdle = row({ child: "exited" });
		const shell = terminal();
		for (const candidate of [stale, mapped, recordedIdle, shell]) {
			const h = harness({ reads: [[candidate]] });
			await stopProcess(candidate.id, h.ports);
			assert.equal(h.stops.length, 1, candidate.slot);
			const expectForget = candidate === stale || candidate === mapped || candidate === shell;
			assert.deepEqual(h.forgotten, expectForget ? [candidate.slot] : [], candidate.slot);
		}
	});

	it("forgets nothing when the stop did not succeed", async () => {
		const stale = orphan();
		const h = harness({ reads: [[stale]], outcomes: [{ kind: "unconfirmed", detail: "It did not.", canForce: false }] });
		await stopProcess(stale.id, h.ports);
		assert.deepEqual(h.forgotten, []);
	});

	it("still reports a stop whose mapping could not be forgotten", async () => {
		const stale = orphan();
		const h = harness({ reads: [[stale]], forgetFails: true });
		await stopProcess(stale.id, h.ports);
		assert.deepEqual(h.warns, []);
		assert.deepEqual(h.infos, []);
		assert.ok(h.events.includes("refresh"));
	});

	it("refreshes even when the stop path throws", async () => {
		const stale = orphan();
		const h = harness({ reads: [[stale]], outcomes: [new Error("boom")] });
		await assert.rejects(stopProcess(stale.id, h.ports), /boom/);
		assert.ok(h.events.includes("refresh"));
	});

	it("offers a force stop after a failed graceful stop, and forces only when it is accepted", async () => {
		const stuck = orphan();
		const unconfirmed: BrokerStopOutcome = { kind: "unconfirmed", detail: "The process did not exit.", canForce: true };
		const h = harness({ reads: [[stuck]], confirms: [true], outcomes: [unconfirmed, STOPPED] });
		await stopProcess(stuck.id, h.ports);
		assert.deepEqual(h.stops.map(call => call.mode), ["graceful", "force"]);
		assert.deepEqual(h.stops[1]?.target, stopTargetOf(stuck));
		assert.equal(h.confirms.length, 1, "only the force offer asks");
		assert.equal(h.confirms[0]?.label, "Force Stop");
		assert.equal(h.confirms[0]?.message, `Force ${describeProcess(stuck)} to stop?`);
		assert.deepEqual(h.warns, []);
		assert.deepEqual(h.infos, []);
	});

	it("does not force when the force offer is declined", async () => {
		const stuck = orphan();
		const unconfirmed: BrokerStopOutcome = { kind: "unconfirmed", detail: "The process did not exit.", canForce: true };
		const h = harness({ reads: [[stuck]], confirms: [false], outcomes: [unconfirmed, STOPPED] });
		await stopProcess(stuck.id, h.ports);
		assert.deepEqual(h.stops.map(call => call.mode), ["graceful"]);
		assert.equal(h.warns.length, 1);
		assert.match(h.warns[0] ?? "", /The process did not exit\./);
		assert.ok(h.events.includes("refresh"));
	});

	it("does not offer a force when the outcome says none is possible", async () => {
		const stuck = orphan();
		const unconfirmed: BrokerStopOutcome = { kind: "unconfirmed", detail: "It declined to shut down.", canForce: false };
		const h = harness({ reads: [[stuck]], outcomes: [unconfirmed] });
		await stopProcess(stuck.id, h.ports);
		assert.deepEqual(h.confirms, []);
		assert.deepEqual(h.stops.map(call => call.mode), ["graceful"]);
		assert.equal(h.warns.length, 1);
	});

	it("warns, and does not claim a stop, when a forced stop is not confirmed either", async () => {
		const stuck = orphan();
		const unconfirmed: BrokerStopOutcome = { kind: "unconfirmed", detail: "Still there.", canForce: true };
		const stillThere: BrokerStopOutcome = { kind: "unconfirmed", detail: "Still there after force.", canForce: false };
		const h = harness({ reads: [[stuck]], outcomes: [unconfirmed, stillThere] });
		await stopProcess(stuck.id, h.ports);
		assert.deepEqual(h.stops.map(call => call.mode), ["graceful", "force"]);
		assert.equal(h.warns.length, 1);
		assert.match(h.warns[0] ?? "", /Still there after force\./);
		assert.deepEqual(h.infos, []);
		assert.deepEqual(h.forgotten, []);
	});

	it("warns with the reason when the stop is refused, and does not claim a stop", async () => {
		const stale = orphan();
		const h = harness({ reads: [[stale]], outcomes: [{ kind: "refused", reason: "that slot now names another broker" }] });
		await stopProcess(stale.id, h.ports);
		assert.equal(h.warns.length, 1);
		assert.match(h.warns[0] ?? "", /that slot now names another broker/);
		assert.deepEqual(h.infos, []);
		assert.deepEqual(h.forgotten, []);
		assert.ok(h.events.includes("refresh"));
	});
});

describe("describeProcess", () => {
	it("names what a process hosts, or that nothing refers to it", () => {
		assert.match(describeProcess(row()), /Fix the build/);
		assert.match(describeProcess(terminal()), /terminal "app"/);
		assert.match(describeProcess(orphan({ title: "left over" })), /left over/);
		assert.match(describeProcess(orphan({ title: null })), /no session row refers to/);
		assert.match(describeProcess(terminal({ host: null, status: "orphaned" })), /no longer has a record/);
	});
});

describe("stopOrphanedAndIdle", () => {
	it("only reports when nothing is selected", async () => {
		const h = harness({ reads: [[row(), row({ window: "this-window" })]] });
		await stopOrphanedAndIdle(h.ports);
		assert.equal(h.infos.length, 1);
		assert.deepEqual(h.confirms, []);
		assert.deepEqual(h.stops, []);
		assert.deepEqual(h.readOptions, [{ fresh: true }]);
	});

	it("asks once, with the counts by kind, and stops each selected row gracefully", async () => {
		const sessionA = orphan();
		const sessionB = row({ child: "exited" });
		const shell = terminal({ child: "exited" });
		const h = harness({ reads: [[sessionA, sessionB, shell]] });
		await stopOrphanedAndIdle(h.ports);
		assert.equal(h.confirms.length, 1);
		assert.match(h.confirms[0]?.message ?? "", /2 session processes/);
		assert.match(h.confirms[0]?.message ?? "", /1 terminal process\b/);
		assert.equal(h.confirms[0]?.label, "Stop Processes");
		// One of the three still has a running child, and the confirmation says so.
		assert.match(h.confirms[0]?.detail ?? "", /One still has a session or shell running/);
		assert.deepEqual(h.stops.map(call => call.mode), ["graceful", "graceful", "graceful"]);
		assert.deepEqual(h.stops.map(call => call.target), [sessionA, sessionB, shell].map(stopTargetOf));
		assert.deepEqual(h.warns, []);
		assert.deepEqual(h.infos, []);
		assert.equal(h.events.at(-1), "refresh");
	});

	it("does not claim anything is still running when every selected child has exited", async () => {
		const h = harness({ reads: [[row({ child: "exited" })]] });
		await stopOrphanedAndIdle(h.ports);
		assert.doesNotMatch(h.confirms[0]?.detail ?? "", /still ha(s|ve) a session or shell running/);
	});

	it("stops nothing when the confirmation is dismissed", async () => {
		const h = harness({ reads: [[orphan()]], confirms: [false] });
		await stopOrphanedAndIdle(h.ports);
		assert.deepEqual(h.stops, []);
		assert.equal(h.infos.length, 1);
		assert.equal(h.readOptions.length, 1);
	});

	it("re-derives after the confirmation and skips a row that is no longer selected, saying so", async () => {
		const stays = orphan();
		const becameInUse = orphan();
		const vanished = orphan();
		const nowDriven = orphan();
		const nowShown = orphan();
		const h = harness({
			reads: [
				[stays, becameInUse, vanished, nowDriven, nowShown],
				[
					stays,
					{ ...becameInUse, status: "in-use", child: "running" },
					{ ...nowDriven, drivenHere: true },
					{ ...nowShown, window: "this-window" },
				],
			],
		});
		await stopOrphanedAndIdle(h.ports);
		assert.deepEqual(h.readOptions, [{ fresh: true }, { fresh: true }]);
		assert.deepEqual(h.stops.map(call => call.target.slot), [stays.slot]);
		assert.equal(h.warns.length, 1);
		assert.match(h.warns[0] ?? "", /Stopped 1 of 5/);
		assert.match(h.warns[0] ?? "", /4 changed after the confirmation/);
	});

	it("does not stop a row that appeared after the confirmation", async () => {
		const confirmed = orphan();
		const newcomer = orphan();
		const h = harness({ reads: [[confirmed], [confirmed, newcomer]] });
		await stopOrphanedAndIdle(h.ports);
		assert.deepEqual(h.stops.map(call => call.target.slot), [confirmed.slot]);
		assert.deepEqual(h.infos, []);
	});

	it("does not stop a row that is now a different broker in the same slot", async () => {
		const before = orphan({ slot: "tab:reused" });
		const after = orphan({ slot: "tab:reused", brokerId: "pty-newcomer" });
		const h = harness({ reads: [[before], [after]] });
		await stopOrphanedAndIdle(h.ports);
		assert.deepEqual(h.stops, []);
		assert.equal(h.warns.length, 1);
	});

	it("never forces, and never offers to", async () => {
		const stuck = orphan();
		const h = harness({ reads: [[stuck]], outcomes: [{ kind: "unconfirmed", detail: "It did not exit.", canForce: true }] });
		await stopOrphanedAndIdle(h.ports);
		assert.deepEqual(h.stops.map(call => call.mode), ["graceful"]);
		assert.equal(h.confirms.length, 1);
	});

	it("summarises the failures that are left running without process ids, and keeps going", async () => {
		const first = orphan({ brokerPid: 7001 });
		const second = orphan({ brokerPid: 7002 });
		const third = terminal({ brokerPid: 7003, child: "exited" });
		const h = harness({
			reads: [[first, second, third]],
			outcomes: [
				{ kind: "unconfirmed", detail: "no", canForce: true },
				STOPPED,
				{ kind: "refused", reason: "changed" },
			],
		});
		await stopOrphanedAndIdle(h.ports);
		assert.equal(h.stops.length, 3);
		assert.equal(h.warns.length, 1);
		const message = h.warns[0] ?? "";
		assert.match(message, /Stopped 1 of 3/);
		assert.match(message, /Still running/);
		assert.doesNotMatch(message, /pid|slot/i);
		assert.deepEqual(h.infos, []);
	});

	it("retires confirmed stopped shell records and unowned mappings during bulk stop, retaining recorded session rows", async () => {
		const stale = orphan();
		const mapped = orphan({ status: "in-use", child: "exited", host: sessionHost({ recorded: false }) });
		const recorded = row({ child: "exited" });
		const shell = terminal({ child: "exited" });
		const h = harness({ reads: [[stale, mapped, recorded, shell]] });
		await stopOrphanedAndIdle(h.ports);
		assert.equal(h.stops.length, 4);
		assert.deepEqual(h.forgotten.sort(), [stale.slot, mapped.slot, shell.slot].sort());
	});

	it("refreshes after the stops, also when one throws", async () => {
		const first = orphan();
		const second = orphan();
		const h = harness({ reads: [[first, second]], outcomes: [new Error("boom")] });
		await assert.rejects(stopOrphanedAndIdle(h.ports), /boom/);
		assert.ok(h.events.includes("refresh"));
		assert.equal(h.stops.length, 1);
	});

	it("never stops a driven row, a row this window shows, or a running in-use row", async () => {
		const drivenOrphan = orphan({ drivenHere: true });
		const drivenIdle = row({ child: "exited", drivenHere: true, host: sessionHost({ drivenHere: true }) });
		const shownOrphan = orphan({ window: "this-window" });
		const shownIdle = row({ child: "exited", window: "this-window" });
		const inUseRunning = row();
		const unknownRunning = row({ status: "unknown", host: null });
		const unreadChild = row({ child: "unknown" });
		const blocked = orphan({ stop: { available: false, reason: "predecessor" } });
		const target = orphan();
		const h = harness({
			reads: [[drivenOrphan, drivenIdle, shownOrphan, shownIdle, inUseRunning, unknownRunning, unreadChild, blocked, target]],
		});
		await stopOrphanedAndIdle(h.ports);
		assert.deepEqual(h.stops.map(call => call.target.slot), [target.slot]);
		assert.match(h.confirms[0]?.message ?? "", /^Stop 1 session process\?$/);
	});
});

describe("Stats process Stop", () => {
	it("uses broker stop, not a session lifecycle, and never alters session/shell mappings", async () => {
		const target = row({ kind: "stats", ptyKind: "stats-dashboard", host: { kind: "stats", window: "none" } });
		const h = harness({ reads: [[target]] });
		await stopProcess(target.id, h.ports);
		assert.equal(h.stops[0]?.target.kind, "stats-dashboard");
		assert.deepEqual(h.forgotten, []);
		assert.deepEqual(h.capturedFor, { driven: [], recorded: [] });
	});
});

describe("Kill All", () => {
	/** A folder terminal an editor of this window carries: tier 1, stopped through the broker route. */
	const here = (overrides: Partial<BrokerProcessRow> = {}): BrokerProcessRow =>
		terminal({ window: "this-window", host: terminalHost({ window: "this-window" }), ...overrides });
	/** A session this window drives: tier 1, stopped through its own lifecycle. */
	const driven = (overrides: Partial<BrokerProcessRow> = {}): BrokerProcessRow =>
		row({ drivenHere: true, window: "this-window", host: sessionHost({ drivenHere: true, window: "this-window" }), ...overrides });
	/** An rpc session another window holds: recorded route. */
	const held = (overrides: Partial<BrokerProcessRow> = {}): BrokerProcessRow =>
		row({ window: "other-window", host: sessionHost({ window: "other-window", tabId: "tab-held" }), ...overrides });
	/** An rpc session this window only shows (an editor, no runtime): never this window's to stop on its own. */
	const shown = (overrides: Partial<BrokerProcessRow> = {}): BrokerProcessRow =>
		row({ window: "this-window", host: sessionHost({ window: "this-window", recorded: false }), ...overrides });

	it("says so and asks nothing when there is nothing to stop", async () => {
		const h = harness({ reads: [[]] });
		await killAll(h.ports);
		assert.deepEqual(h.choices, []);
		assert.deepEqual(h.stops, []);
		assert.deepEqual(h.infos, ["No OMP processes are running."]);
	});

	it("names rows of another version that cannot be stopped, and asks nothing when only those exist", async () => {
		const old = orphan({ stop: { available: false, reason: "previous version" }, title: "Old chat" });
		const h = harness({ reads: [[old]] });
		await killAll(h.ports);
		assert.deepEqual(h.choices, []);
		assert.deepEqual(h.infos, []);
		assert.match(h.warns[0] ?? "", /No OMP process can be stopped from here\. Not stoppable from here: the OMP session "Old chat"/);
	});

	it("offers only 'this window' when nothing runs elsewhere, and stops exactly this window's rows", async () => {
		const a = here();
		const events: string[] = [];
		const b = driven();
		const h = harness({ reads: [[a, b], [a, b], []], driven: captured(events), events });
		await killAll(h.ports);
		assert.deepEqual(h.choices[0]?.options.map(option => option.label), ["Stop in This Window"]);
		assert.match(h.choices[0]?.message ?? "", /^Stop 1 session and 1 terminal in this window\?$/);
		assert.deepEqual(h.readOptions, [{ fresh: true }, { fresh: true }, { fresh: true }]);
		assert.deepEqual(h.infos, ["Stopped 2 OMP processes."]);
		assert.deepEqual(h.warns, []);
	});

	it("never counts a session this window merely shows as this window's, even with an editor open", async () => {
		assert.deepEqual(planKillAll([shown()]).here, []);
		const h = harness({ reads: [[shown()]], choices: [null] });
		await killAll(h.ports);
		assert.deepEqual(h.choices[0]?.options.map(option => option.id), ["all"]);
		assert.match(h.choices[0]?.detail ?? "", /that this window does not run/);
	});

	it("offers both buttons when other windows or this window's non-members hold processes, with their counts", async () => {
		const mine = here();
		const other = held();
		const detached = terminal();
		const dashboard = row({ kind: "stats", ptyKind: "stats-dashboard", host: { kind: "stats", window: "none" } });
		const h = harness({ reads: [[mine, other, detached, dashboard]], choices: [null] });
		await killAll(h.ports);
		const request = h.choices[0];
		assert.deepEqual(request?.options.map(option => option.label), ["Stop in This Window", "Stop in All Windows"]);
		assert.match(request?.detail ?? "", /Stop in All Windows also ends 1 session that another window holds and 1 terminal and the Stats dashboard that this window does not run\./);
		assert.deepEqual(h.infos, ["Nothing was stopped."]);
		assert.deepEqual(h.stops, []);
		assert.equal(h.events.filter(event => event === "read").length, 1, "a cancelled modal reads nothing more");
	});

	it("offers only the all-windows button when nothing runs in this window", async () => {
		const h = harness({ reads: [[held()]], choices: [null] });
		await killAll(h.ports);
		assert.deepEqual(h.choices[0]?.options.map(option => option.id), ["all"]);
		assert.match(h.choices[0]?.detail ?? "", /Nothing runs in this window\./);
	});

	it("'this window' leaves other windows' and unrun rows alone; 'all windows' stops them too", async () => {
		const mine = here();
		const other = terminal({ window: "other-window", host: terminalHost({ window: "other-window" }) });
		const detached = orphan();
		const everything = [mine, other, detached];
		const onlyHere = harness({ reads: [everything, everything, [other, detached]], choices: ["here"] });
		await killAll(onlyHere.ports);
		assert.deepEqual(onlyHere.stops.map(call => call.target.slot), [mine.slot]);
		assert.match(onlyHere.infos[0] ?? "", /Stopped 1 OMP process\./);

		const all = harness({ reads: [everything, everything, []], choices: ["all"] });
		await killAll(all.ports);
		assert.deepEqual(all.stops.map(call => call.target.slot).sort(), [mine.slot, other.slot, detached.slot].sort());
	});

	it("stops each row by the route its own Stop uses, so a driven session goes through its stop lifecycle", async () => {
		const drivenRow = driven();
		const recorded = held();
		const shell = here();
		const events: string[] = [];
		const h = harness({
			reads: [[drivenRow, recorded, shell], [drivenRow, recorded, shell], []],
			driven: captured(events),
			recorded: captured(events),
			events,
		});
		await killAll(h.ports);
		assert.deepEqual(h.capturedFor.driven.map(target => target.id), [drivenRow.id]);
		assert.deepEqual(h.capturedFor.recorded.map(target => target.id), [recorded.id]);
		assert.deepEqual(h.stops.map(call => call.target.slot), [shell.slot]);
		assert.equal(h.events.filter(event => event === "run").length, 2);
		assert.deepEqual(h.forgotten, [shell.slot], "the broker route retires the shell record, the row flows retire their own");
	});

	it("stops a native session another window holds through its broker, not by reattaching it", async () => {
		const native = held({ ptyKind: "managed-omp" });
		const h = harness({ reads: [[native], [native], []], recorded: captured([]), choices: ["all"] });
		await killAll(h.ports);
		assert.deepEqual(h.capturedFor.recorded, []);
		assert.deepEqual(h.stops.map(call => call.target.kind), ["managed-omp"]);
	});

	it("re-derives after the choice and leaves a row alone that left the chosen tier, saying so", async () => {
		const stays = here();
		const moved = here();
		const h = harness({
			reads: [[stays, moved], [stays, { ...moved, window: "other-window" }], [{ ...moved, window: "other-window" }]],
			choices: ["here"],
		});
		await killAll(h.ports);
		assert.deepEqual(h.stops.map(call => call.target.slot), [stays.slot]);
		assert.equal(h.warns.length, 1);
		assert.match(h.warns[0] ?? "", /Stopped 1 of 1 OMP process\./);
		assert.match(h.warns[0] ?? "", /1 process changed after the confirmation and was left alone\./);
	});

	it("leaves a terminal alone that another window attached while earlier stops ran, and says so", async () => {
		const first = here();
		const moved = here();
		const h = harness({
			reads: [[first, moved], [first, moved], [first, { ...moved, window: "other-window" }], [{ ...moved, window: "other-window" }]],
			choices: ["here"],
		});
		await killAll(h.ports);
		assert.deepEqual(h.stops.map(call => call.target.slot), [first.slot]);
		assert.match(h.warns[0] ?? "", /^Stopped 1 of 1 OMP process\./);
		assert.match(h.warns[0] ?? "", /1 process changed after the confirmation and was left alone\./);
	});

	it("does not report a process as stopped when its child exited but its broker was not proven gone", async () => {
		const a = here();
		const childOnly: BrokerStopOutcome = { kind: "stopped", childWasRunning: true, brokerGone: false, detail: "The child exited." };
		const h = harness({ reads: [[a], [a], []], outcomes: [childOnly] });
		await killAll(h.ports);
		assert.deepEqual(h.infos, []);
		assert.match(h.warns[0] ?? "", /^Stopped 0 of 1 OMP process\. Could not be confirmed stopped: .*could not be confirmed closed/);
	});

	it("never touches a row that appeared after the choice", async () => {
		const chosen = here();
		const newcomer = here();
		const h = harness({ reads: [[chosen], [chosen, newcomer], [newcomer]] });
		await killAll(h.ports);
		assert.deepEqual(h.stops.map(call => call.target.slot), [chosen.slot]);
	});

	it("reports per target: still listed is still running, a failed route not listed is unconfirmed", async () => {
		const failing = here();
		const ranButAlive = driven({ host: sessionHost({ drivenHere: true, window: "this-window", title: "Busy one" }) });
		const notListed = here();
		const events: string[] = [];
		const h = harness({
			reads: [[failing, ranButAlive, notListed], [failing, ranButAlive, notListed], [failing, ranButAlive]],
			driven: captured(events),
			events,
			outcomes: [{ kind: "refused", reason: "the broker changed" }, { kind: "refused", reason: "it could not be reached" }],
		});
		await killAll(h.ports);
		assert.deepEqual(h.infos, []);
		assert.equal(h.warns.length, 1);
		const message = h.warns[0] ?? "";
		assert.match(message, /^Stopped 0 of 3 OMP processes\./);
		assert.match(message, /Still running: .*was not stopped: the broker changed/);
		assert.match(message, /the OMP session "Busy one"/);
		assert.match(message, /Could not be confirmed stopped: .*was not stopped: it could not be reached/);
		assert.doesNotMatch(message, /pid|slot/i);
	});

	it("does not take a row missing from the final list for stopped unless its route confirmed it", async () => {
		const a = here();
		const b = here();
		const h = harness({ reads: [[a, b], [a, b], []], outcomes: [{ kind: "refused", reason: "the process is already gone" }, STOPPED] });
		await killAll(h.ports);
		assert.equal(h.warns.length, 1);
		assert.match(h.warns[0] ?? "", /^Stopped 1 of 2 OMP processes\. Could not be confirmed stopped:/);
	});

	it("says when the final check could not read the process list, counting only what the routes confirmed", async () => {
		const a = here();
		let reads = 0;
		const h = harness({ reads: [[a]] });
		const ports: typeof h.ports = {
			...h.ports,
			read: async options => {
				reads += 1;
				if (reads === 3) throw new Error("probe failed");
				return await h.ports.read(options);
			},
		};
		await killAll(ports);
		assert.match(h.warns[0] ?? "", /^Stopped 1 of 1 OMP process\. The final check of the process list failed/);
	});

	it("names the rows it could not attempt in the result, even when everything else stopped", async () => {
		const mine = here();
		const old = orphan({ stop: { available: false, reason: "previous version" }, title: "Old chat" });
		const h = harness({ reads: [[mine, old], [mine, old], [old]] });
		await killAll(h.ports);
		assert.equal(h.warns.length, 1);
		assert.match(h.warns[0] ?? "", /Stopped 1 of 1 OMP process\./);
		assert.match(h.warns[0] ?? "", /Not stoppable from here: the OMP session "Old chat" \(started by another version of OMP Desk\)\./);
	});

	it("keeps going and refreshes when one stop throws, and reports it", async () => {
		const first = here();
		const second = here();
		const h = harness({ reads: [[first, second], [first, second], [first]], outcomes: [new Error("boom"), STOPPED] });
		await killAll(h.ports);
		assert.equal(h.stops.length, 2);
		assert.ok(h.events.includes("refresh"));
		assert.match(h.warns[0] ?? "", /boom/);
	});

	it("offers the same Force Stop a single stop does, and never forces without it", async () => {
		const stuck = here();
		const unconfirmed: BrokerStopOutcome = { kind: "unconfirmed", detail: "It did not exit.", canForce: true };
		const declined = harness({ reads: [[stuck], [stuck], [stuck]], outcomes: [unconfirmed], confirms: [false] });
		await killAll(declined.ports);
		assert.deepEqual(declined.stops.map(call => call.mode), ["graceful"]);
		assert.equal(declined.confirms.length, 1);
		assert.equal(declined.warns.length, 1);

		const accepted = harness({ reads: [[stuck], [stuck], []], outcomes: [unconfirmed, STOPPED], confirms: [true] });
		await killAll(accepted.ports);
		assert.deepEqual(accepted.stops.map(call => call.mode), ["graceful", "force"]);
		assert.deepEqual(accepted.infos, ["Stopped 1 OMP process."]);
	});

	it("describes the modal by tier and kind", () => {
		const plan = planKillAll([
			driven(),
			driven(),
			here(),
			held(),
			orphan({ stop: { available: false, reason: "previous version" } }),
		]);
		const request = describeKillAll(plan);
		assert.equal(request.message, "Stop 2 sessions and 1 terminal in this window?");
		assert.match(request.detail, /1 process started by another version of OMP Desk cannot be stopped from here/);
		assert.deepEqual(request.options.map(option => option.id), ["here", "all"]);
	});
});

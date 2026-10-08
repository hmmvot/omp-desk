/**
 * Tests for the model behind the Processes view.
 *
 * Every reading arrives through a port, so what a row may claim is decided here with
 * fakes and no I/O: which records become rows, how the identity cache spends probes, how
 * a slot is classified from the union of durable sources, and how rows are ordered and
 * selected for the bulk stop.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	brokerRecordFacts,
	buildBrokerProcessCatalog,
	createBrokerProcessReader,
	deriveBrokerProcessRow,
	selectOrphanedAndIdle,
} from "./broker-processes.ts";
import type {
	BrokerCatalogSources,
	BrokerProcessCatalog,
	BrokerProcessChild,
	BrokerProcessReadPorts,
	BrokerProcessRow,
	BrokerRecordFacts,
	SourcedBrokerRecord,
} from "./broker-processes.ts";
import type { PtyIdentityReading } from "./pty-identity.ts";
import {
	PTY_PROTOCOL_VERSION,
	PTY_RECORD_VERSION,
	PTY_RUNTIME_VERSION,
	PTY_SERVICE,
	createPtyToken,
} from "./pty-protocol.ts";
import type { PtyBrokerRecord, PtyKind } from "./pty-protocol.ts";

const BUILD_DIGEST = "b".repeat(64);
const OTHER_DIGEST = "c".repeat(64);
const NOW = Date.parse("2026-10-07T12:00:00.000Z");

let serial = 0;

/** A record fact set with a unique broker id and PID, alive and verifiable by default. */
function facts(slot: string, overrides: Partial<BrokerRecordFacts> = {}): BrokerRecordFacts {
	serial += 1;
	const suffix = String(serial).padStart(12, "0");
	return {
		version: PTY_RECORD_VERSION,
		service: PTY_SERVICE,
		protocolVersion: PTY_PROTOCOL_VERSION,
		runtimeVersion: PTY_RUNTIME_VERSION,
		treeDigest: BUILD_DIGEST,
		brokerId: `pty-00000000-0000-4000-8000-${suffix}`,
		generation: `gen-00000000-0000-4000-8000-${suffix}`,
		slot,
		kind: "managed-rpc",
		port: 50000 + serial,
		brokerPid: 1000 + serial,
		brokerCreationTime: String(134349421014308869n + BigInt(serial)),
		startedAt: new Date(NOW - 60_000).toISOString(),
		cols: 100,
		rows: 30,
		title: null,
		...overrides,
	};
}

function current(record: BrokerRecordFacts): SourcedBrokerRecord {
	return { source: "current", record };
}

function predecessor(record: BrokerRecordFacts): SourcedBrokerRecord {
	return { source: "predecessor", record };
}

function sources(overrides: Partial<BrokerCatalogSources> = {}): BrokerCatalogSources {
	return {
		ready: true,
		rows: [],
		byConversation: new Map(),
		byEditor: new Set(),
		brokerSlotsComplete: true,
		shells: [],
		shellSlotsComplete: true,
		...overrides,
	};
}

const EMPTY_CATALOG = buildBrokerProcessCatalog(sources());

/** Fake ports whose answers a test steers, and which count what the reader asks. */
function harness(initial: readonly SourcedBrokerRecord[], catalog: BrokerProcessCatalog = EMPTY_CATALOG) {
	const state = {
		records: [...initial],
		catalog,
		alive: (_pid: number): boolean => true,
		creation: (record: BrokerRecordFacts): PtyIdentityReading => ({
			kind: "found",
			creationTime: record.brokerCreationTime ?? "",
		}),
		child: (_record: BrokerRecordFacts): BrokerProcessChild => "running",
		digest: BUILD_DIGEST as string | null,
		unreadable: 0,
		probeDelay: false,
		childDelay: false,
	};
	const calls = {
		creation: [] as number[],
		child: [] as string[],
		catalogFresh: [] as boolean[],
		probesInFlight: 0,
		maxProbesInFlight: 0,
		childrenInFlight: 0,
		maxChildrenInFlight: 0,
	};
	const byPid = (pid: number): BrokerRecordFacts => {
		const entry = state.records.find(candidate => candidate.record.brokerPid === pid);
		assert.ok(entry, `the fake was asked about an unknown pid ${pid}`);
		return entry.record;
	};
	const ports: BrokerProcessReadPorts = {
		listRecords: async () => ({ records: state.records, unreadable: state.unreadable }),
		catalog: async fresh => {
			calls.catalogFresh.push(fresh);
			return state.catalog;
		},
		isAlive: pid => state.alive(pid),
		readCreationTime: async pid => {
			calls.creation.push(pid);
			calls.probesInFlight++;
			calls.maxProbesInFlight = Math.max(calls.maxProbesInFlight, calls.probesInFlight);
			if (state.probeDelay) await new Promise<void>(resolve => setImmediate(resolve));
			calls.probesInFlight--;
			return state.creation(byPid(pid));
		},
		readChild: async record => {
			calls.child.push(record.slot);
			calls.childrenInFlight++;
			calls.maxChildrenInFlight = Math.max(calls.maxChildrenInFlight, calls.childrenInFlight);
			if (state.childDelay) await new Promise<void>(resolve => setImmediate(resolve));
			calls.childrenInFlight--;
			return state.child(record);
		},
		buildDigest: async () => state.digest,
		now: () => NOW,
	};
	return { state, calls, reader: createBrokerProcessReader(ports) };
}

describe("broker process reader: which records are rows", () => {
	it("shows a live record whose PID still reads as the recorded creation time", async () => {
		const record = facts("tab:a");
		const { reader } = harness([current(record)]);
		const snapshot = await reader.read();
		assert.equal(snapshot.rows.length, 1);
		assert.equal(snapshot.hidden, 0);
		const [row] = snapshot.rows;
		assert.equal(row?.slot, "tab:a");
		assert.equal(row?.brokerPid, record.brokerPid);
		assert.equal(row?.brokerCreationTime, record.brokerCreationTime);
		assert.equal(row?.uptimeMs, 60_000);
		assert.equal(snapshot.takenAt, NOW);
	});

	it("hides a record whose PID is dead, and counts it", async () => {
		const dead = facts("tab:dead");
		const live = facts("tab:live");
		const { state, calls, reader } = harness([current(dead), current(live)]);
		state.alive = pid => pid !== dead.brokerPid;
		const snapshot = await reader.read();
		assert.deepEqual(snapshot.rows.map(row => row.slot), ["tab:live"]);
		assert.equal(snapshot.hidden, 1);
		// A dead PID is never worth a probe.
		assert.deepEqual(calls.creation, [live.brokerPid]);
	});

	it("hides a recycled PID, whose creation time is another process's, and counts it", async () => {
		const recycled = facts("tab:recycled");
		const { state, reader } = harness([current(recycled)]);
		state.creation = () => ({ kind: "found", creationTime: "134349421019999999" });
		const snapshot = await reader.read();
		assert.equal(snapshot.rows.length, 0);
		assert.equal(snapshot.hidden, 1);
	});

	it("hides a record with no creation time without probing it, and counts it", async () => {
		const unnamed = facts("tab:unnamed", { brokerCreationTime: null });
		const { calls, reader } = harness([current(unnamed)]);
		const snapshot = await reader.read();
		assert.equal(snapshot.rows.length, 0);
		assert.equal(snapshot.hidden, 1);
		assert.deepEqual(calls.creation, []);
	});

	it("hides a PID whose process has gone between the liveness check and the probe", async () => {
		const record = facts("tab:gone");
		const { state, reader } = harness([current(record)]);
		state.creation = () => ({ kind: "gone" });
		const snapshot = await reader.read();
		assert.equal(snapshot.rows.length, 0);
		assert.equal(snapshot.hidden, 1);
	});

	it("carries the unreadable count of the listing through", async () => {
		const { state, reader } = harness([current(facts("tab:a"))]);
		state.unreadable = 3;
		assert.equal((await reader.read()).unreadable, 3);
	});
});

describe("broker process reader: the identity cache", () => {
	it("keeps a gone verdict for good, even across explicit reads", async () => {
		const record = facts("tab:gone");
		const { state, calls, reader } = harness([current(record)]);
		state.creation = () => ({ kind: "gone" });
		assert.equal((await reader.read()).hidden, 1);
		assert.equal((await reader.read()).hidden, 1);
		const fresh = await reader.read({ fresh: true });
		assert.equal(fresh.hidden, 1);
		assert.equal(fresh.rows.length, 0);
		assert.equal(calls.creation.length, 1, "a broker judged gone cost more than one probe");
	});

	it("keeps a mismatch verdict for good", async () => {
		const record = facts("tab:recycled");
		const { state, calls, reader } = harness([current(record)]);
		state.creation = () => ({ kind: "found", creationTime: "134349421019999999" });
		await reader.read();
		// Even if the PID later read as the recorded time, that broker was judged.
		state.creation = r => ({ kind: "found", creationTime: r.brokerCreationTime ?? "" });
		const again = await reader.read({ fresh: true });
		assert.equal(again.rows.length, 0);
		assert.equal(again.hidden, 1);
		assert.equal(calls.creation.length, 1);
	});

	it("does not re-probe a verified record on a tick, but does after an explicit read", async () => {
		const record = facts("tab:a");
		const { calls, reader } = harness([current(record)]);
		await reader.read();
		await reader.read();
		assert.equal(calls.creation.length, 1, "a tick re-probed a verified record");
		await reader.read({ fresh: true });
		assert.equal(calls.creation.length, 2, "an explicit read did not re-verify");
		// Verification is remembered again afterwards.
		await reader.read();
		assert.equal(calls.creation.length, 2);
	});

	it("drops a verified record whose process died, without waiting for a probe", async () => {
		const record = facts("tab:a");
		const { state, reader } = harness([current(record)]);
		assert.equal((await reader.read()).rows.length, 1);
		state.alive = () => false;
		const snapshot = await reader.read();
		assert.equal(snapshot.rows.length, 0);
		assert.equal(snapshot.hidden, 1);
	});

	it("re-verifies a verified record now and then on ticks, so a recycled PID cannot show for long", async () => {
		const record = facts("tab:a");
		const { state, calls, reader } = harness([current(record)]);
		await reader.read();
		state.creation = () => ({ kind: "found", creationTime: "134349421019999999" });
		let shown = true;
		for (let tick = 0; tick < 24 && shown; tick++) shown = (await reader.read()).rows.length === 1;
		assert.equal(shown, false, "a recycled PID kept showing across many ticks");
		assert.ok(calls.creation.length >= 2);
	});

	it("retries an unreadable reading next time instead of caching it", async () => {
		const record = facts("tab:a");
		const { state, calls, reader } = harness([current(record)]);
		state.creation = () => ({ kind: "unknown", detail: "the helper timed out" });
		const first = await reader.read();
		assert.equal(first.rows.length, 0);
		assert.equal(first.hidden, 1);
		state.creation = r => ({ kind: "found", creationTime: r.brokerCreationTime ?? "" });
		const second = await reader.read();
		assert.equal(second.rows.length, 1);
		assert.equal(second.hidden, 0);
		assert.equal(calls.creation.length, 2);
	});

	it("probes at most four records at once", async () => {
		const records = Array.from({ length: 11 }, (_, index) => current(facts(`tab:${index}`)));
		const { state, calls, reader } = harness(records);
		state.probeDelay = true;
		const snapshot = await reader.read();
		assert.equal(snapshot.rows.length, 11);
		assert.equal(calls.creation.length, 11);
		assert.equal(calls.maxProbesInFlight, 4);
	});
});

describe("broker process reader: child state", () => {
	it("reads no child state on a tick", async () => {
		const { calls, reader } = harness([current(facts("tab:a"))]);
		const snapshot = await reader.read();
		assert.deepEqual(calls.child, []);
		assert.equal(snapshot.rows[0]?.child, "unknown");
	});

	it("reads it on an explicit read, and reuses the answer on the next tick", async () => {
		const { state, calls, reader } = harness([current(facts("tab:a"))]);
		state.child = () => "exited";
		const explicit = await reader.read({ fresh: true });
		assert.equal(explicit.rows[0]?.child, "exited");
		state.child = () => "running";
		const tick = await reader.read();
		assert.equal(tick.rows[0]?.child, "exited", "a tick re-read the child");
		assert.deepEqual(calls.child, ["tab:a"]);
		const next = await reader.read({ fresh: true });
		assert.equal(next.rows[0]?.child, "running");
		assert.equal(calls.child.length, 2);
	});

	it("reads it only for rows this build can stop", async () => {
		const ok = facts("tab:ok");
		const old = facts("tab:old");
		const wrongProtocol = facts("tab:protocol", { protocolVersion: PTY_PROTOCOL_VERSION + 1 });
		const wrongRuntime = facts("tab:runtime", { runtimeVersion: PTY_RUNTIME_VERSION + 1 });
		const { calls, reader } = harness([current(ok), predecessor(old), current(wrongProtocol), current(wrongRuntime)]);
		const snapshot = await reader.read({ fresh: true });
		assert.deepEqual(calls.child, ["tab:ok"]);
		const byId = new Map(snapshot.rows.map(row => [row.slot, row] as const));
		assert.equal(byId.get("tab:ok")?.child, "running");
		for (const slot of ["tab:old", "tab:protocol", "tab:runtime"]) assert.equal(byId.get(slot)?.child, "unknown", slot);
	});

	it("reads at most four children at once", async () => {
		const records = Array.from({ length: 10 }, (_, index) => current(facts(`tab:${index}`)));
		const { state, calls, reader } = harness(records);
		state.childDelay = true;
		await reader.read({ fresh: true });
		assert.equal(calls.child.length, 10);
		assert.equal(calls.maxChildrenInFlight, 4);
	});

	it("asks for a fresh catalog only on an explicit read, after listing the records", async () => {
		const { calls, reader } = harness([current(facts("tab:a"))]);
		await reader.read();
		await reader.read({ fresh: true });
		assert.deepEqual(calls.catalogFresh, [false, true]);
	});
});

describe("broker process rows: stop availability and flags", () => {
	it("never attaches to a predecessor row and leaves its status unknown", async () => {
		const record = facts("tab:old", { brokerPid: 424242 });
		// The catalog references the slot, which must not make a predecessor "in use".
		const catalog = buildBrokerProcessCatalog(
			sources({
				rows: [{ tabId: "t1", title: "T", folder: null, hostSlot: "tab:old", window: "none", drivenSlot: null }],
			}),
		);
		const { calls, reader } = harness([predecessor(record)], catalog);
		const [row] = (await reader.read({ fresh: true })).rows;
		assert.ok(row);
		assert.equal(row.source, "predecessor");
		assert.equal(row.status, "unknown");
		assert.equal(row.host, null);
		assert.equal(row.child, "unknown");
		assert.equal(row.stop.available, false);
		assert.equal(row.brokerPid, 424242);
		assert.deepEqual(calls.child, []);
	});

	it("gives a protocol or runtime mismatch no stop while retaining diagnostic identity", async () => {
		const protocol = facts("tab:p", { protocolVersion: PTY_PROTOCOL_VERSION + 1, brokerPid: 777001 });
		const runtime = facts("tab:r", { runtimeVersion: PTY_RUNTIME_VERSION + 1, brokerPid: 777002 });
		const { reader } = harness([current(protocol), current(runtime)]);
		const rows = (await reader.read()).rows;
		assert.equal(rows.length, 2);
		for (const row of rows) {
			assert.equal(row.stop.available, false);
			assert.doesNotMatch(row.stop.available ? "" : row.stop.reason, new RegExp(String(row.brokerPid)));
			assert.match(row.stop.available ? "" : row.stop.diagnosticReason ?? "", new RegExp(String(row.brokerPid)));
		}
	});

	it("offers a stop for a record of this build", async () => {
		const { reader } = harness([current(facts("tab:a"))]);
		assert.deepEqual((await reader.read()).rows[0]?.stop, { available: true });
	});

	it("flags an older build only when the tree digest differs from this build's", async () => {
		const same = facts("tab:same");
		const older = facts("tab:older", { treeDigest: OTHER_DIGEST });
		const { state, reader } = harness([current(same), current(older)]);
		const bySlot = async () => new Map((await reader.read()).rows.map(row => [row.slot, row] as const));
		const known = await bySlot();
		assert.equal(known.get("tab:same")?.olderBuild, false);
		assert.equal(known.get("tab:older")?.olderBuild, true);
		// With no digest for this build nothing can be called older.
		state.digest = null;
		const unknown = await bySlot();
		assert.equal(unknown.get("tab:older")?.olderBuild, false);
	});
});

describe("broker process classification", () => {
	function derive(
		slot: string,
		catalogSources: BrokerCatalogSources,
		kind: PtyKind = "managed-rpc",
		source: "current" | "predecessor" = "current",
	): BrokerProcessRow {
		return deriveBrokerProcessRow({ source, record: facts(slot, { kind }) }, buildBrokerProcessCatalog(catalogSources), BUILD_DIGEST, NOW, "running");
	}

	const row = (overrides: Partial<BrokerCatalogSources["rows"][number]> = {}) => ({
		tabId: "t1",
		title: "Fix the build",
		folder: "C:/work/app",
		hostSlot: null,
		window: "none" as const,
		drivenSlot: null,
		...overrides,
	});

	it("calls a slot a row's recorded host names in use, with that row as its host", () => {
		const result = derive("tab:a", sources({ rows: [row({ hostSlot: "tab:a", window: "other-window" })] }));
		assert.equal(result.status, "in-use");
		assert.equal(result.kind, "session");
		assert.equal(result.window, "other-window");
		assert.deepEqual(result.host, {
			kind: "session",
			tabId: "t1",
			title: "Fix the build",
			folder: "C:/work/app",
			window: "other-window",
			drivenHere: false,
			recorded: true,
		});
	});

	it("calls a conversation mapping whose row still exists in use, but not recorded", () => {
		const result = derive("tab:a", sources({ rows: [row()], byConversation: new Map([["tab:a", "t1"]]) }));
		assert.equal(result.status, "in-use");
		assert.equal(result.host?.kind === "session" ? result.host.recorded : null, false);
		assert.equal(result.host?.kind === "session" ? result.host.tabId : null, "t1");
	});

	it("calls a conversation mapping whose row is gone orphaned", () => {
		const result = derive("tab:a", sources({ rows: [], byConversation: new Map([["tab:a", "t-gone"]]) }));
		assert.equal(result.status, "orphaned");
		assert.equal(result.host, null);
	});

	it("calls an editor-only mapping in use, without a row", () => {
		const result = derive("tab:a", sources({ byEditor: new Set(["tab:a"]) }));
		assert.equal(result.status, "in-use");
		assert.equal(result.host?.kind === "session" ? result.host.tabId : "not a session", null);
		assert.equal(result.drivenHere, false);
	});

	it("calls a slot in the shell list in use for a terminal", () => {
		const result = derive(
			"shell:a",
			sources({ shells: [{ slot: "shell:a", folder: "C:/work/app", label: "app", window: "other-window" }] }),
			"folder-shell",
		);
		assert.equal(result.status, "in-use");
		assert.equal(result.kind, "terminal");
		assert.equal(result.window, "other-window");
		assert.deepEqual(result.host, { kind: "terminal", folder: "C:/work/app", label: "app", window: "other-window" });
	});

	it("does not take a terminal's slot from the session mappings, or a session's from the shell list", () => {
		const shellAsSession = derive("shell:a", sources({ shells: [{ slot: "shell:a", folder: "f", label: "l", window: "none" }] }), "managed-rpc");
		assert.equal(shellAsSession.status, "orphaned");
		const sessionAsShell = derive("tab:a", sources({ rows: [row({ hostSlot: "tab:a" })] }), "folder-shell");
		assert.equal(sessionAsShell.status, "orphaned");
	});

	it("calls an unreferenced slot orphaned when every source was read in full", () => {
		const result = derive("tab:a", sources());
		assert.equal(result.status, "orphaned");
		assert.equal(result.window, "none");
		assert.equal(result.drivenHere, false);
	});

	it("calls everything unknown while the catalog is not ready", () => {
		const result = derive("tab:a", sources({ ready: false, rows: [row({ hostSlot: "tab:a" })] }));
		assert.equal(result.status, "unknown");
		assert.equal(result.host, null);
	});

	for (const [name, incomplete] of [
		["the broker-slot table", { brokerSlotsComplete: false }],
		["the shell slot list", { shellSlotsComplete: false }],
	] as const) {
		it(`makes an unreferenced slot unknown, not orphaned, when ${name} was not read in full`, () => {
			assert.equal(derive("tab:a", sources(incomplete)).status, "unknown");
			assert.equal(derive("shell:a", sources(incomplete), "folder-shell").status, "unknown");
		});

		it(`keeps a referenced slot in use when ${name} was not read in full`, () => {
			const result = derive("tab:a", sources({ ...incomplete, rows: [row({ hostSlot: "tab:a" })] }));
			assert.equal(result.status, "in-use");
			const shell = derive(
				"shell:a",
				sources({ ...incomplete, shells: [{ slot: "shell:a", folder: "f", label: "l", window: "none" }] }),
				"folder-shell",
			);
			assert.equal(shell.status, "in-use");
		});
	}

	it("decides driven-here per slot, not per row", () => {
		const catalogSources = sources({
			rows: [row({ hostSlot: "tab:a", drivenSlot: "tab:a" })],
			byConversation: new Map([["tab:b", "t1"]]),
		});
		const driven = derive("tab:a", catalogSources);
		const other = derive("tab:b", catalogSources);
		assert.equal(driven.drivenHere, true);
		assert.equal(other.drivenHere, false);
		assert.equal(other.status, "in-use");
	});

	it("does not classify a predecessor row, whatever the catalog says", () => {
		const result = derive("tab:a", sources({ rows: [row({ hostSlot: "tab:a" })] }), "managed-rpc", "predecessor");
		assert.equal(result.status, "unknown");
		assert.equal(result.host, null);
	});

	it("derives a stable id, and the uptime from the start time", () => {
		const record = facts("tab:a", { startedAt: new Date(NOW - 3_600_000).toISOString() });
		const first = deriveBrokerProcessRow(current(record), EMPTY_CATALOG, null, NOW, "unknown");
		const later = deriveBrokerProcessRow(current(record), EMPTY_CATALOG, null, NOW + 5_000, "unknown");
		assert.equal(first.id, later.id);
		assert.equal(first.uptimeMs, 3_600_000);
		assert.equal(later.uptimeMs, 3_605_000);
		const dateless = deriveBrokerProcessRow(current({ ...record, startedAt: "not a date" }), EMPTY_CATALOG, null, NOW, "unknown");
		assert.equal(dateless.uptimeMs, null);
	});
});

describe("broker process ordering", () => {
	function at(minutesAgo: number): string {
		return new Date(NOW - minutesAgo * 60_000).toISOString();
	}

	it("orders orphaned, exited child, in use, then predecessor, last", async () => {
		const orphan = facts("tab:orphan", { startedAt: at(1) });
		const exited = facts("tab:exited", { startedAt: at(5) });
		const inUse = facts("tab:in-use", { startedAt: at(2) });
		const old = facts("tab:old", { startedAt: at(0) });
		const catalog = buildBrokerProcessCatalog(
			sources({
				rows: [
					{ tabId: "t1", title: "exited", folder: null, hostSlot: "tab:exited", window: "none", drivenSlot: null },
					{ tabId: "t2", title: "in use", folder: null, hostSlot: "tab:in-use", window: "none", drivenSlot: null },
				],
			}),
		);
		const { state, reader } = harness([predecessor(old), current(inUse), current(exited), current(orphan)], catalog);
		state.child = record => (record.slot === "tab:exited" ? "exited" : "running");
		const rows = (await reader.read({ fresh: true })).rows;
		assert.deepEqual(rows.map(row => row.slot), ["tab:orphan", "tab:exited", "tab:in-use", "tab:old"]);
		assert.deepEqual(rows.map(row => row.status), ["orphaned", "in-use", "in-use", "unknown"]);
	});

	it("puts unknown between an exited child and in use", async () => {
		const exited = facts("tab:exited");
		const unknown = facts("tab:unknown");
		const inUse = facts("tab:in-use");
		// An incomplete catalog: the unreferenced slot cannot be called orphaned.
		const catalog = buildBrokerProcessCatalog(
			sources({
				brokerSlotsComplete: false,
				rows: [
					{ tabId: "t1", title: "exited", folder: null, hostSlot: "tab:exited", window: "none", drivenSlot: null },
					{ tabId: "t2", title: "in use", folder: null, hostSlot: "tab:in-use", window: "none", drivenSlot: null },
				],
			}),
		);
		const { state, reader } = harness([current(inUse), current(unknown), current(exited)], catalog);
		state.child = record => (record.slot === "tab:exited" ? "exited" : "running");
		const rows = (await reader.read({ fresh: true })).rows;
		assert.deepEqual(rows.map(row => row.slot), ["tab:exited", "tab:unknown", "tab:in-use"]);
	});

	it("puts the newer broker first within a group, and a predecessor after every current row", async () => {
		const older = facts("tab:older", { startedAt: at(30) });
		const newer = facts("tab:newer", { startedAt: at(3) });
		const oldPredecessor = facts("tab:p-old", { startedAt: at(60) });
		const newPredecessor = facts("tab:p-new", { startedAt: at(1) });
		const catalog = buildBrokerProcessCatalog(sources());
		const { reader } = harness([current(older), predecessor(oldPredecessor), current(newer), predecessor(newPredecessor)], catalog);
		const rows = (await reader.read()).rows;
		assert.deepEqual(rows.map(row => row.slot), ["tab:newer", "tab:older", "tab:p-new", "tab:p-old"]);
	});
});

describe("selectOrphanedAndIdle", () => {
	function row(overrides: Partial<BrokerProcessRow> = {}): BrokerProcessRow {
		serial += 1;
		return {
			id: `current|tab:${serial}|pty-${serial}`,
			source: "current",
			kind: "session",
			ptyKind: "managed-rpc",
			slot: `tab:${serial}`,
			brokerId: `pty-${serial}`,
			generation: `gen-${serial}`,
			brokerPid: 2000 + serial,
			brokerCreationTime: "134349421014308869",
			startedAt: new Date(NOW).toISOString(),
			uptimeMs: 0,
			title: null,
			status: "in-use",
			host: null,
			window: "none",
			drivenHere: false,
			child: "running",
			olderBuild: false,
			stop: { available: true },
			...overrides,
		};
	}

	it("includes an orphaned row and a row whose child has exited", () => {
		const orphan = row({ status: "orphaned" });
		const idle = row({ child: "exited" });
		const idleOrphan = row({ status: "orphaned", child: "exited" });
		assert.deepEqual(selectOrphanedAndIdle([orphan, idle, idleOrphan]), [orphan, idle, idleOrphan]);
	});

	it("includes one that another window shows", () => {
		const orphan = row({ status: "orphaned", window: "other-window" });
		assert.deepEqual(selectOrphanedAndIdle([orphan]), [orphan]);
	});

	it("excludes a row whose stop is unavailable", () => {
		const blocked = row({ status: "orphaned", stop: { available: false, reason: "no" } });
		const blockedIdle = row({ child: "exited", stop: { available: false, reason: "no" } });
		assert.deepEqual(selectOrphanedAndIdle([blocked, blockedIdle]), []);
	});

	it("excludes a row this window drives, even an orphaned or idle one", () => {
		assert.deepEqual(selectOrphanedAndIdle([row({ status: "orphaned", drivenHere: true }), row({ child: "exited", drivenHere: true })]), []);
	});

	it("excludes a row this window shows", () => {
		assert.deepEqual(selectOrphanedAndIdle([row({ status: "orphaned", window: "this-window" }), row({ child: "exited", window: "this-window" })]), []);
	});

	it("excludes an in-use running row, an unknown running row, and one whose child state is unread", () => {
		assert.deepEqual(
			selectOrphanedAndIdle([
				row({ status: "in-use", child: "running" }),
				row({ status: "unknown", child: "running" }),
				row({ status: "in-use", child: "unknown" }),
				row({ status: "unknown", child: "unknown" }),
			]),
			[],
		);
	});
});

describe("brokerRecordFacts", () => {
	it("drops the token and keeps everything else", () => {
		const record: PtyBrokerRecord = { ...facts("tab:a"), token: createPtyToken() };
		const result = brokerRecordFacts(record);
		assert.equal("token" in result, false);
		assert.deepEqual(Object.keys(result).sort(), Object.keys(record).filter(key => key !== "token").sort());
		assert.equal(result.brokerId, record.brokerId);
		assert.equal(result.brokerCreationTime, record.brokerCreationTime);
		assert.equal(JSON.stringify(result).includes(record.token), false);
	});
});

describe("Stats broker discovery", () => {
	it("lists a standalone stats record without session/shell references, including before catalog load", () => {
		const catalog = buildBrokerProcessCatalog(sources({ ready: false }));
		const result = deriveBrokerProcessRow(current(facts("stats:dashboard", { kind: "stats-dashboard" })), catalog, BUILD_DIGEST, NOW, "running");
		assert.equal(result.kind, "stats");
		assert.equal(result.status, "in-use");
		assert.deepEqual(result.host, { kind: "stats", window: "none" });
		assert.equal(result.drivenHere, false);
		assert.equal(result.stop.available, true);
		assert.deepEqual(selectOrphanedAndIdle([result]), []);
	});
});

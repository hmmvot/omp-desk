/**
 * Stopping the recorded host of a conversation this window does not drive: the broker provenance of a row, the
 * transport the index stops it through, and the gated operation that records what follows a stop that happened.
 *
 * The module's host imports resolve extensionless specifiers the way esbuild does, so it is compiled with the
 * project's bundler.
 *
 * Runner: `node --test src/runtime/local-recorded-stop.test.ts`.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, before, describe, it } from "node:test";
import { build } from "esbuild";
import { recordingLogger } from "../shared/logger.ts";
import type { LoggedLine } from "../shared/logger.ts";
import type { BrokerSlotProvenance, BrokerSlotStore } from "../host/broker-slots.ts";
import type { StopRecordedHostResult } from "../host/session-availability.ts";
import type { SessionIndex } from "../host/session-index.ts";
import type { SessionIndexEntry } from "../host/session-model.ts";
import type * as Module from "./local-recorded-stop.ts";

let mod: typeof Module;
let temp: string;
before(async () => {
	temp = await mkdtemp(path.join(tmpdir(), "omp-recorded-stop-"));
	const outfile = path.join(temp, "local-recorded-stop.mjs");
	await build({ entryPoints: [fileURLToPath(new URL("./local-recorded-stop.ts", import.meta.url))], outfile, bundle: true, platform: "node", format: "esm", target: "node20" });
	mod = (await import(pathToFileURL(outfile).href)) as typeof Module;
});
after(async () => { await rm(temp, { recursive: true, force: true }); });

const TAB = "tab:11111111-2222-4333-8444-555555555555";
const SLOT = "host:legacy-fixture";
const STAMP = "2026-09-29T10:25:25Z";

describe("the broker provenance of a row", () => {
	const table = (answers: Record<string, BrokerSlotProvenance>) => ({
		provenanceFor: (keys: { conversation?: string | null; editor?: string | null }) => answers[keys.conversation != null ? `conversation:${keys.conversation}` : `editor:${keys.editor}`] ?? { kind: "none" },
	}) as unknown as BrokerSlotStore;
	const sources = (brokerSlots: BrokerSlotStore | undefined, bindings: { role: string; slotId: string }[] = []) => ({ brokerSlots, slotsForConversation: () => bindings });

	it("is unreadable without a slot table, never `none`", () => {
		assert.deepEqual(mod.readBrokerProvenance(sources(undefined), TAB), { kind: "unreadable" });
	});

	it("is what the conversation's own entry says when it says anything", () => {
		assert.deepEqual(mod.readBrokerProvenance(sources(table({ [`conversation:${TAB}`]: { kind: "slot", slot: "host:a" } })), TAB), { kind: "slot", slot: "host:a" });
		assert.deepEqual(mod.readBrokerProvenance(sources(table({ [`conversation:${TAB}`]: { kind: "unreadable" } }), [{ role: "controlling", slotId: "e1" }]), TAB), { kind: "unreadable" });
	});

	it("falls back to the slot recorded for the editor that controls the conversation, and to nothing a passive editor says", () => {
		const slots = table({ "editor:controller": { kind: "slot", slot: "host:editor" }, "editor:passive": { kind: "slot", slot: "host:passive" } });
		assert.deepEqual(mod.readBrokerProvenance(sources(slots, [{ role: "passive", slotId: "passive" }, { role: "controlling", slotId: "controller" }]), TAB), { kind: "slot", slot: "host:editor" });
		assert.deepEqual(mod.readBrokerProvenance(sources(slots, [{ role: "passive", slotId: "passive" }]), TAB), { kind: "none" });
	});

	it("stays unreadable when an editor's entry was unreadable and no other editor named a slot", () => {
		const slots = table({ "editor:broken": { kind: "unreadable" } });
		assert.deepEqual(mod.readBrokerProvenance(sources(slots, [{ role: "controlling", slotId: "broken" }, { role: "controlling", slotId: "empty" }]), TAB), { kind: "unreadable" });
		assert.deepEqual(mod.readBrokerProvenance(sources(slots, [{ role: "controlling", slotId: "empty" }]), TAB), { kind: "none" });
	});
});

describe("the transport that stops a recorded host", () => {
	const entry = (overrides: Record<string, unknown> = {}) =>
		({ tabId: TAB, host: { pid: 51704, startedAt: STAMP, transport: "rpc", rpc: { slot: SLOT, brokerId: "broker-1", brokerGeneration: "gen-1" } }, ...overrides }) as unknown as SessionIndexEntry;
	const port = (provenance: BrokerSlotProvenance, client: unknown = null, expectedSlot = SLOT, expectedBroker: { brokerId: string; brokerGeneration: string } | null = null) => {
		const logged: LoggedLine[] = [];
		const stop = mod.createRecordedHostStopPort({ brokerProvenanceFor: () => provenance, attachBrokerClient: async () => client as never, log: recordingLogger(logged) }, expectedSlot, expectedBroker);
		return { stop: (row: SessionIndexEntry) => stop.stopRecordedHost(row), logged };
	};

	it("refuses, saying nothing was stopped, when the row's slot or broker is not the one the confirmation named", async () => {
		const detail = "This session changed while the confirmation was open. Nothing was stopped; try Stop again.";
		assert.deepEqual(await port({ kind: "slot", slot: "host:other" }).stop(entry()), { kind: "unknown", detail });
		const broker = { brokerId: "broker-1", brokerGeneration: "gen-1" };
		assert.deepEqual(await port({ kind: "slot", slot: SLOT }, null, SLOT, { ...broker, brokerGeneration: "gen-2" }).stop(entry()), { kind: "unknown", detail });
		assert.deepEqual(await port({ kind: "slot", slot: SLOT }, null, SLOT, broker).stop(entry({ host: { pid: 1, startedAt: STAMP, transport: "rpc", rpc: null } })), { kind: "unknown", detail });
	});

	it("names an unreadable or missing slot table as such, and never signals a pid", async () => {
		assert.deepEqual(await port({ kind: "unreadable" }).stop(entry()), { kind: "unknown", detail: "This session's connection details could not be read. Refresh Sessions and try again." });
		assert.deepEqual(await port({ kind: "none" }).stop(entry()), { kind: "unknown", detail: "This session's connection details are missing. Reopen its editor and try Stop again." });
	});

	it("refuses without a broker client, and for a native writer, which only its own Terminal stops", async () => {
		assert.deepEqual(await port({ kind: "slot", slot: SLOT }, null).stop(entry()), { kind: "unknown", detail: "This session is disconnected. Reopen its editor and try Stop again." });
		const native = entry({ host: { pid: 1, startedAt: STAMP, transport: "native", rpc: null } });
		assert.deepEqual(await port({ kind: "slot", slot: SLOT }, {}).stop(native), { kind: "unknown", detail: "Stop this session from its Terminal editor, or use /exit there." });
	});

	it("names the tab, its title and the slot in the line it logs for a stop the broker could not carry out", async () => {
		const noRecord = { readRecord: async () => ({ kind: "none" }) };
		const stopping = port({ kind: "slot", slot: SLOT }, noRecord);
		const outcome = await stopping.stop(entry({ title: "  Fix the\n build  " }));
		assert.equal(outcome.kind, "unknown");
		assert.deepEqual(stopping.logged.map(line => [line.level, line.message]), [
			["warn", `recorded host stop ${TAB} "Fix the build" (slot ${SLOT}): no broker is recorded for this row's slot, so this window cannot reach the OMP process it started`],
		]);
		const untitled = port({ kind: "slot", slot: SLOT }, noRecord);
		await untitled.stop(entry());
		assert.match(untitled.logged[0]?.message ?? "", new RegExp(`^recorded host stop ${TAB} \\(slot ${SLOT}\\): `));
	});
});

describe("stopping a recorded host under the conversation's gate", () => {
	const row = { tabId: TAB, host: { pid: 51704, startedAt: STAMP, transport: "rpc", rpc: { slot: SLOT, brokerId: "broker-1", brokerGeneration: "gen-1" } }, ownership: { ownerGeneration: "owner-1" } } as unknown as SessionIndexEntry;
	const request = { conversation: TAB, slot: SLOT, broker: null, expect: { attemptStartedAt: STAMP, pid: 51704 } };

	const LEASE = {};

	function fixture(result: StopRecordedHostResult, writerPid: number | null = 51704) {
		const events: string[] = [];
		const index = {
			get: () => row,
			lifecycle: { run: async (key: string, work: (lease: unknown) => Promise<unknown>) => { events.push(`gate ${key}`); return await work(LEASE); } },
			stopRecordedHost: async (key: string, options: { expect: unknown; stop: unknown }, lease: unknown) => {
				events.push(`stopRecordedHost ${key} ${JSON.stringify(options.expect)} lease=${lease === LEASE}`);
				return result;
			},
		} as unknown as SessionIndex;
		const stop = new mod.LocalRecordedStop({
			index,
			writer: { pid: async () => writerPid },
			control: { release: async (key: string, owner: string | null) => { events.push(`release ${key} ${owner}`); } },
			brokerSlots: () => ({ forget: async (slot: string) => { events.push(`forget ${slot}`); } }) as unknown as BrokerSlotStore,
			window: { forgetOutcome: key => { events.push(`outcome ${key}`); } },
			stopPort: (slot, broker) => { events.push(`port ${slot} ${JSON.stringify(broker)}`); return { stopRecordedHost: async () => ({ kind: "unknown", detail: "unused" }) }; },
		});
		return { stop, events };
	}

	it("holds the gate across the index's stop, then retires the slot, drops the outcome and releases the recorded owner's credentials", async () => {
		const f = fixture({ stopped: true, detail: "stopped", slot: SLOT });
		const outcome = await f.stop.stopRecorded(request);
		assert.deepEqual(outcome, { kind: "result", result: { stopped: true, detail: "stopped", slot: SLOT } });
		assert.deepEqual(f.events, [
			`gate ${TAB}`, `port ${SLOT} null`, `stopRecordedHost ${TAB} {"attemptStartedAt":"${STAMP}","pid":51704} lease=true`,
			`forget ${SLOT}`, `outcome ${TAB}`, `release ${TAB} owner-1`,
		]);
	});

	it("records nothing when the stop did not happen, and reports the index's own sentence", async () => {
		const f = fixture({ stopped: false, detail: "The session could not be confirmed stopped.", slot: null });
		const outcome = await f.stop.stopRecorded(request);
		assert.deepEqual(outcome, { kind: "result", result: { stopped: false, detail: "The session could not be confirmed stopped.", slot: null } });
		assert.deepEqual(f.events.filter(event => /^(forget|outcome|release)/.test(event)), []);
	});

	it("checks under the gate that the writer is still the one the caller verified, and stops nothing otherwise", async () => {
		const gone = fixture({ stopped: true, detail: "stopped", slot: SLOT }, null);
		assert.deepEqual(await gone.stop.stopRecorded({ ...request, expectedWriter: { pid: 51704 } }), { kind: "writer-gone" });
		assert.deepEqual(gone.events, [`gate ${TAB}`]);
		const changed = fixture({ stopped: true, detail: "stopped", slot: SLOT }, 99);
		assert.deepEqual(await changed.stop.stopRecorded({ ...request, expectedWriter: { pid: 51704 } }), { kind: "writer-changed" });
		assert.deepEqual(changed.events, [`gate ${TAB}`]);
		const same = fixture({ stopped: true, detail: "stopped", slot: SLOT }, 51704);
		assert.equal((await same.stop.stopRecorded({ ...request, expectedWriter: { pid: 51704 } })).kind, "result");
	});

	it("passes the broker the confirmation was shown to the transport", async () => {
		const f = fixture({ stopped: false, detail: "no", slot: null });
		await f.stop.stopRecorded({ ...request, broker: { brokerId: "broker-1", brokerGeneration: "gen-1" } });
		assert.ok(f.events.includes(`port ${SLOT} {"brokerId":"broker-1","brokerGeneration":"gen-1"}`));
	});
});

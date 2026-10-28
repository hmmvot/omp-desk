/**
 * `LocalSessionRuntime` over a fake index, reconciler and launcher: what each port operation passes
 * to the index (the admission table of the design, §2.2), and that nothing a window could use to
 * widen an admission is reachable through the port.
 *
 * Runner: `node --test src/runtime/local-runtime.test.ts`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { OmpHostAttachRequest, OmpHostLauncher, RestoreOutcome, RestoreOptions, RestoreAllOptions, RestoreReport, SessionIndex } from "../host/session-index.ts";
import type { OwnerReconciler } from "../host/session-availability.ts";
import { LocalSessionRuntime } from "./local-runtime.ts";
import type { SessionRuntime, StopRecordedRequest } from "./session-runtime.ts";

const TAB = "tab:one";
const restored: RestoreOutcome = { status: "attached", tabId: TAB, sessionFile: "s.jsonl", detail: "attached" };

interface Calls {
	restore: [string, RestoreOptions][];
	restoreAll: RestoreAllOptions[];
	observed: string[];
	stopRecorded: StopRecordedRequest[];
	writer: [string, { readonly display?: boolean } | undefined][];
	provenance: string[];
}

function fixture(overrides: { entry?: unknown; verdict?: { kind: string }; restore?: () => Promise<RestoreOutcome> } = {}) {
	const calls: Calls = { restore: [], restoreAll: [], observed: [], stopRecorded: [], writer: [], provenance: [] };
	const report = { order: [TAB], restored: [], attached: [], conflicts: [], failures: [], drafts: [], stopped: [], skipped: [], activeTabId: null, persistError: null, saved: Promise.resolve(null), rowsMs: 0 } as RestoreReport;
	const entry = "entry" in overrides ? overrides.entry : { tabId: TAB, sessionFile: "s.jsonl", host: { transport: "native" }, ownership: { ownerGeneration: "gen-1", draftIdentity: null } };
	const index = {
		claimHolder: { id: "holder-1", pid: 4242, processCreationTime: undefined },
		get: () => entry,
		observeOwnership: async (tabId: string) => { calls.observed.push(tabId); return { ok: true, claim: null }; },
		restore: async (tabId: string, options: RestoreOptions) => { calls.restore.push([tabId, options]); return overrides.restore === undefined ? restored : await overrides.restore(); },
		restoreAll: async (options: RestoreAllOptions) => { calls.restoreAll.push(options); return report; },
	};
	const attached: OmpHostAttachRequest[] = [];
	const launches: unknown[] = [];
	let launcherReads = 0;
	const hostLauncher: OmpHostLauncher = {
		launch: async request => { launches.push(request); return { state: "unconfirmed", reason: "fixture" }; },
		attach: async request => { attached.push(request); return { state: "unavailable", reason: "fixture" }; },
	};
	const reconciler = { reconcile: async () => overrides.verdict ?? { kind: "attachable" } } as unknown as OwnerReconciler;
	const runtime = new LocalSessionRuntime({
		index: index as unknown as SessionIndex,
		records: {} as never,
		reconciler: () => reconciler,
		launcher: () => { launcherReads++; return hostLauncher; },
		stop: { requestStop: async () => ({ writerGone: true, treeEmpty: true, detail: "fixture" }), confirmEnded: async () => null, awaitSettled: async () => null, readTransitionFacts: async () => null },
		chat: {} as never, control: {} as never, identity: {} as never, nativeWatch: {} as never, exit: {} as never, kill: {} as never, transitions: {} as never,
		recorded: { stopRecorded: async request => { calls.stopRecorded.push(request); return { kind: "writer-gone" }; } },
		writer: { pid: async (conversation, options) => { calls.writer.push([conversation, options]); return 4321; } },
		brokerProvenance: conversation => { calls.provenance.push(conversation); return { kind: "none" }; },
	});
	return { runtime, calls, report, hostLauncher, reconciler, attached, launches, launcherReads: () => launcherReads };
}

describe("the holder", () => {
	it("is the index's claim holder, with a start time that has not been read as null", () => {
		assert.deepEqual(fixture().runtime.holder, { id: "holder-1", pid: 4242, creationTime: null });
	});
});

describe("open", () => {
	it("passes the admission fields, the mode and the editor slot to the index, with this runtime's reconciler and launcher", async () => {
		const f = fixture();
		const outcome = await f.runtime.open({ conversation: TAB, mode: "terminal", allowStoppedResume: true, editorBinding: { slot: "slot-1" } });
		assert.equal(outcome, restored);
		assert.equal(f.calls.restore.length, 1);
		const [tabId, options] = f.calls.restore[0];
		assert.equal(tabId, TAB);
		assert.equal(options.reconciler, f.reconciler);
		assert.equal(options.launcher, f.hostLauncher);
		assert.equal(options.mode, "terminal");
		assert.equal(options.editorSlotId, "slot-1");
		assert.equal(options.allowStoppedResume, true);
		assert.equal(options.automatic, undefined, "an open is never an automatic pass");
	});

	it("leaves the editor slot unset when no editor is bound and keeps a refused stopped resume false", async () => {
		const f = fixture();
		await f.runtime.open({ conversation: TAB, mode: "chat", allowStoppedResume: false });
		const options = f.calls.restore[0][1];
		assert.equal(options.editorSlotId, undefined);
		assert.equal(options.allowStoppedResume, false, "a restored editor never lifts a stopped intent");
	});

	it("lets what the index throws reach the caller unchanged", async () => {
		const failure = new Error("index failed");
		const f = fixture({ restore: async () => { throw failure; } });
		await assert.rejects(f.runtime.open({ conversation: TAB, mode: "chat", allowStoppedResume: false }), failure);
	});

	it("reads the reconciler and the launcher when it acts, so a replacement is used by the next call", async () => {
		const f = fixture();
		assert.equal(f.launcherReads(), 0, "construction reads neither");
		await f.runtime.open({ conversation: TAB, mode: "chat", allowStoppedResume: false });
		await f.runtime.open({ conversation: TAB, mode: "chat", allowStoppedResume: false });
		assert.equal(f.launcherReads(), 2);
	});
});

describe("restore", () => {
	it("pins the pass to the cohort the caller captured and passes no admission the caller could widen", async () => {
		const f = fixture();
		const cohort = new Set([TAB, "tab:two"]);
		const report = await f.runtime.restore({ cohort });
		assert.equal(report, f.report);
		assert.equal(f.calls.restoreAll.length, 1);
		const options = f.calls.restoreAll[0];
		assert.equal(options.only, cohort);
		assert.equal(options.reconciler, f.reconciler);
		assert.equal(options.launcher, f.hostLauncher);
		assert.equal(options.restoreDrafts, undefined, "a startup pass never starts a draft");
		assert.equal(options.allowStoppedResume, undefined, "a startup pass never lifts a stopped intent");
		assert.equal(options.resumeStopped, undefined);
		assert.equal(options.signal, undefined);
	});

	it("hands the caller's signal to the index", async () => {
		const f = fixture();
		const controller = new AbortController();
		await f.runtime.restore({ cohort: new Set([TAB]) }, { signal: controller.signal });
		assert.equal(f.calls.restoreAll[0].signal, controller.signal);
	});
});

describe("reattach", () => {
	it("re-adopts an attachable native writer through the launcher's attach and never launches", async () => {
		const f = fixture();
		const outcome = await f.runtime.reattach({ conversation: TAB });
		assert.equal(outcome, restored);
		assert.deepEqual(f.calls.observed, [TAB]);
		const [tabId, options] = f.calls.restore[0];
		assert.equal(tabId, TAB);
		assert.equal(options.allowStoppedResume, false);
		assert.equal(options.mode, "terminal");
		assert.deepEqual(await options.launcher.launch({} as never), { state: "not-started", reason: "A lifecycle action only reattaches an existing native writer." });
		assert.deepEqual(f.launches, [], "the real launcher is never asked to launch");
		const request = { tabId: TAB } as OmpHostAttachRequest;
		assert.deepEqual(await options.launcher.attach(request), { state: "unavailable", reason: "fixture" });
		assert.deepEqual(f.attached, [request]);
	});

	it("skips a conversation whose row has no native writer without observing or restoring anything", async () => {
		for (const entry of [null, { tabId: TAB, host: null }, { tabId: TAB, host: { transport: "rpc" } }]) {
			const f = fixture({ entry });
			const outcome = await f.runtime.reattach({ conversation: TAB });
			assert.equal(outcome.status, "skipped");
			assert.deepEqual(f.calls.observed, []);
			assert.deepEqual(f.calls.restore, []);
		}
	});

	it("skips a native writer the reconciler does not prove attachable", async () => {
		const f = fixture({ verdict: { kind: "free" } });
		const outcome = await f.runtime.reattach({ conversation: TAB });
		assert.equal(outcome.status, "skipped");
		assert.deepEqual(f.calls.restore, []);
	});
});

describe("what the runtime delegates to its own services", () => {
	it("stops a recorded host, verifies a writer and reads a broker provenance through them", async () => {
		const f = fixture();
		const request = { conversation: TAB, slot: "host:a", broker: null, expect: { attemptStartedAt: "t", pid: 1 } };
		assert.deepEqual(await f.runtime.stopRecorded(request), { kind: "writer-gone" });
		assert.deepEqual(f.calls.stopRecorded, [request]);
		assert.equal(await f.runtime.verifiedWriterPid(TAB, { display: true }), 4321);
		assert.deepEqual(f.calls.writer, [[TAB, { display: true }]]);
		assert.deepEqual(f.runtime.brokerProvenance(TAB), { kind: "none" });
		assert.deepEqual(f.calls.provenance, [TAB]);
	});
});

describe("the port", () => {
	it("exposes no admission the window could widen", () => {
		const port: SessionRuntime = fixture().runtime;
		// Type-level checks only: the closure is never called.
		const typeChecks = () => {
			// @ts-expect-error a restore pass carries a cohort and nothing else.
			void port.restore({ cohort: new Set<string>(), restoreDrafts: true });
		};
		assert.equal(typeof typeChecks, "function");
		assert.equal(typeof port.open, "function");
	});
});

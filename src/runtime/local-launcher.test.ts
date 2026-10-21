/**
 * `LocalLauncher` over fake hosts, hooks and index: the order of one launch, the early refusals,
 * and the release of the broker slot only when nothing was started.
 *
 * Runner: `node --test src/runtime/local-launcher.test.ts`.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { silentLogger } from "../shared/logger.ts";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, before, describe, it } from "node:test";
import { build } from "esbuild";
import type { LiveConversationInput } from "../host/chat-runtime.ts";
import { LaunchTimeline } from "../host/launch-timeline.ts";
import type { BrokerSlotStore } from "../host/broker-slots.ts";
import type { SessionHostRuntime } from "../host/native-session.ts";
import type { OmpHostAttachRequest, OmpHostLaunchRequest, SessionIndex } from "../host/session-index.ts";
import type { LocalLauncher as LocalLauncherType, LocalLauncherDeps, LauncherWindow } from "./local-launcher.ts";

// The host modules resolve extensionless relative imports the way esbuild does, so the launcher is
// compiled with the project's bundler (no `vscode` stand-in is needed: the layer imports none).
let LocalLauncher: new (deps: LocalLauncherDeps) => LocalLauncherType;
let temp: string;
before(async () => {
	temp = await mkdtemp(path.join(tmpdir(), "omp-launcher-"));
	const outfile = path.join(temp, "local-launcher.mjs");
	await build({ entryPoints: [fileURLToPath(new URL("./local-launcher.ts", import.meta.url))], outfile, bundle: true, platform: "node", format: "esm", target: "node20" });
	LocalLauncher = ((await import(pathToFileURL(outfile).href)) as { LocalLauncher: typeof LocalLauncher }).LocalLauncher;
});
after(async () => { await rm(temp, { recursive: true, force: true }); });

const TAB = "tab:one";
const request: OmpHostLaunchRequest = {
	tabId: TAB, sessionFile: null, sessionId: null, cwd: "C:/proj", scope: { profile: null, sessionDir: null } as never,
	transport: "rpc", ownerGeneration: "gen-1", claimPath: "",
};

/** An attach request for a row whose file id is `file-session-id` and whose recorded host reported `recordedId`. */
function attachRequest(recordedId: string | null): OmpHostAttachRequest {
	return {
		...request,
		sessionId: "file-session-id",
		transport: "rpc",
		recordedHost: { pid: 4242, instanceId: null, generation: null, sessionId: recordedId, startedAt: "2026-10-19T00:00:00.000Z", transport: "rpc", rpc: null },
		pin: {} as never,
	};
};

function fixture(options: { precheck?: boolean; launch?: "running" | "not-started" | "unconfirmed"; stagingFails?: boolean; undelivered?: boolean; refusal?: string; attachable?: boolean } = {}) {
	const events: string[] = [];
	const withheld: string[] = [];
	const runtime = {
		kind: "chat", pid: 4242, cwd: request.cwd, notice: null, binary: null, resolutionMs: undefined,
		...(options.undelivered === true ? { control: null } : {}),
		identity: { slot: "slot-x", childCreationTime: "created" },
		handle: { brokerPid: process.pid, record: { brokerCreationTime: null } },
	} as unknown as SessionHostRuntime;
	const window: LauncherWindow = {
		async retireDocument() { events.push("retireDocument"); return "editor-1"; },
		adopt() { events.push("adopt"); },
		isCurrent: () => { events.push("isCurrent"); return false; },
		async prepareView() { events.push("prepareView"); },
		attached() { events.push("attached"); },
		notice() { events.push("notice"); },
	};
	const recorded: unknown[] = [];
	const forgotten: string[] = [];
	const brokerSlots = {
		record: async (entry: unknown) => { events.push("reserve"); recorded.push(entry); return { ok: true }; },
		forget: async (slot: string) => { events.push("forget"); forgotten.push(slot); },
	} as unknown as BrokerSlotStore;
	const diagnostics = new Proxy({}, { get: () => () => undefined }) as never;
	const state = options.launch ?? "running";
	const launches: Array<{ forkFrom?: string | null }> = [];
	const sources = new Map<string, string>();
	const dropped: string[] = [];
	const liveInputs: LiveConversationInput[] = [];
	const deps: LocalLauncherDeps = {
		index: { get: () => null, setRunIntent: async () => { events.push("setRunIntent"); } } as unknown as SessionIndex,
		window,
		chat: { startLive: (_tab: string, input: LiveConversationInput) => { events.push("startLive"); liveInputs.push(input); return undefined as never; } },
		diagnostics,
		launchRefusal: () => options.refusal ?? null,
		entries: async () => {
			if (options.stagingFails === true) throw new Error("staging failed");
			return { hostControl: { path: "control.mjs" }, runtimeProbe: { path: "runtime-probe.mjs" } } as never;
		},
		hosts: {
			launchRpc: async (launchRequest: { forkFrom?: string | null }) => { launches.push(launchRequest); events.push("launch"); return state === "running" ? { state, reason: "ok", runtime } : { state, reason: "no", runtime: null }; },
			launchNative: async () => { throw new Error("not used"); },
			attachRpc: async () => options.attachable === true ? { state: "attached", reason: "ok", runtime } : { state: "unavailable", reason: "x", runtime: null },
			attachNative: async () => ({ state: "unavailable", reason: "x", runtime: null }),
		} as never,
		brokerSlots,
		brokerClient: async () => ({}) as never,
		attachBrokerClient: async () => options.attachable === true ? ({} as never) : null,
		brokerUnavailableReason: () => null,
		brokerWatches: new WeakMap(),
		linkReminder: () => false,
		toolIntent: () => false,
		htmlPages: () => false,
		forks: { peek: tab => sources.get(tab) ?? null, forget: tab => { dropped.push(tab); } },
		control: {
			storeRecipient: async () => { events.push("storeRecipient"); },
			directory: () => "control-dir",
			connect: async () => { events.push("connectControl"); },
			reconnect: async () => { events.push("reconnectControl"); },
			withhold: async (_tab: string, _generation: unknown, _runtime: unknown, _control: unknown, reason: string) => { events.push("withholdControl"); withheld.push(reason); },
			fail: () => { events.push("controlFailed"); },
		},
		native: { servesFile: async () => { events.push("launchPrecheck"); return options.precheck === true; } },
		exit: { brokerLost: async () => { events.push("brokerLost"); } },
		diagnosticsLabel: cwd => cwd,
		log: silentLogger,
	};
	const launcher = new LocalLauncher(deps);
	return { launcher, events, recorded, forgotten, runtime, deps, withheld, launches, sources, dropped, liveInputs };
}

describe("launch", () => {
	it("runs the window's hooks in launch order and records the run intent last", async () => {
		const f = fixture();
		const result = await f.launcher.launch(request);
		f.deps.brokerWatches.get(f.runtime)?.();
		assert.equal(result.state, "running");
		assert.deepEqual(f.events.filter(event => event !== "isCurrent"), [
			"storeRecipient", "retireDocument", "reserve", "launch", "adopt", "prepareView", "startLive", "attached", "connectControl", "setRunIntent",
		]);
		assert.deepEqual(f.recorded.map(entry => (entry as { editor: string | null }).editor), ["editor-1"], "the slot is recorded for the editor the document hook returned");
	});

	it("puts the start's steps on one timeline line: laps, OMP spawned, OMP ready, host control verified and Chat live", async () => {
		const lines: string[] = [];
		const timeline = new LaunchTimeline(Date.now, line => lines.push(line));
		const f = fixture();
		const launcher = new LocalLauncher({ ...f.deps, timeline });
		timeline.begin(TAB, "resume");
		assert.equal((await launcher.launch(request)).state, "running");
		f.deps.brokerWatches.get(f.runtime)?.();
		assert.deepEqual(lines, [], "nothing is reported while host control and the Chat are still to come");
		f.liveInputs[0]?.onReady?.();
		timeline.finish(TAB);
		assert.deepEqual(lines, []);
		timeline.mark(TAB, "chat live");
		assert.equal(lines.length, 1);
		assert.match(lines[0]!, new RegExp(`^window timing: resume ${TAB} start timeline, ms from the command: admission \\d+ · stage \\d+ · host control keys \\d+ · runtime proof \\d+ · editor document \\d+ · broker slot \\d+ · omp spawned \\d+ · conversation \\d+ · run intent \\d+ · omp ready \\d+ · host control verified \\d+ · chat live \\d+$`));
	});

	it("reports the partial timeline of a launch that did not start, naming the step", async () => {
		const lines: string[] = [];
		const timeline = new LaunchTimeline(Date.now, line => lines.push(line));
		const f = fixture({ launch: "unconfirmed" });
		timeline.begin(TAB, "new session");
		assert.equal((await new LocalLauncher({ ...f.deps, timeline }).launch(request)).state, "unconfirmed");
		assert.equal(lines.length, 1);
		assert.match(lines[0]!, new RegExp(`^window timing: new session ${TAB} start ended after \\d+ ms, failed or cancelled at unconfirmed at the broker launch; ms from the command: admission \\d+ · stage \\d+ · host control keys \\d+ · runtime proof \\d+ · editor document \\d+ · broker slot \\d+$`));
	});

	it("withholds host control instead of connecting when the launcher could not carry the recipient (ADR-0075)", async () => {
		const f = fixture({ undelivered: true });
		const result = await f.launcher.launch(request);
		f.deps.brokerWatches.get(f.runtime)?.();
		assert.equal(result.state, "running");
		assert.ok(f.events.includes("withholdControl"), "the marker is recorded, so a reload or the watch never looks for a channel");
		assert.ok(!f.events.includes("connectControl"));
		// A launcher that could not be checked is not reported as one that refuses: the reason covers both and points at the notice.
		assert.equal(f.withheld.length, 1);
		assert.match(f.withheld[0] ?? "", /did not carry the startup options host control needs/);
		assert.match(f.withheld[0] ?? "", /could not be checked/);
		assert.doesNotMatch(f.withheld[0] ?? "", /^this OMP launcher does not accept/);
	});

	it("refuses a second writer for a file this window's native process already serves, before staging anything", async () => {
		const f = fixture({ precheck: true });
		const result = await f.launcher.launch({ ...request, sessionFile: "s.jsonl" });
		assert.equal(result.state, "not-started");
		assert.deepEqual(f.events, ["launchPrecheck"]);
	});

	it("reports a staging failure as not started without preparing credentials", async () => {
		const f = fixture({ stagingFails: true });
		const result = await f.launcher.launch(request);
		assert.equal(result.state, "not-started");
		assert.ok(!f.events.includes("storeRecipient"));
	});

	it("releases the reserved slot only when the host reported nothing was started", async () => {
		const notStarted = fixture({ launch: "not-started" });
		assert.equal((await notStarted.launcher.launch(request)).state, "not-started");
		assert.equal(notStarted.forgotten.length, 1);
		const unconfirmed = fixture({ launch: "unconfirmed" });
		assert.equal((await unconfirmed.launcher.launch(request)).state, "unconfirmed");
		assert.deepEqual(unconfirmed.forgotten, [], "a broker may exist, so the reservation is kept");
	});

	it("passes the fork source of a fileless draft to every launch until the row has a file (a fork that died is retried)", async () => {
		for (const state of ["running", "unconfirmed", "not-started"] as const) {
			const f = fixture({ launch: state });
			f.sources.set(TAB, "C:/proj/original.jsonl");
			await f.launcher.launch(request);
			f.deps.brokerWatches.get(f.runtime)?.();
			assert.equal(f.launches[0]?.forkFrom, "C:/proj/original.jsonl", state);
			assert.deepEqual(f.dropped, [], `${state}: the source is not spent by a launch that has not shown a file`);
		}
	});

	it("never forks an ordinary draft, and a resume of a file ends the fork", async () => {
		const draft = fixture();
		await draft.launcher.launch(request);
		draft.deps.brokerWatches.get(draft.runtime)?.();
		assert.equal(draft.launches[0]?.forkFrom, null);
		assert.deepEqual(draft.dropped, []);
		const resume = fixture();
		resume.sources.set(TAB, "C:/proj/original.jsonl");
		await resume.launcher.launch({ ...request, sessionFile: "C:/proj/exact.jsonl" });
		resume.deps.brokerWatches.get(resume.runtime)?.();
		assert.equal(resume.launches[0]?.forkFrom, null, "a resume names its exact file");
		assert.deepEqual(resume.dropped, [TAB]);
	});

	it("forgets the fork source before a native launch, which has no --fork", async () => {
		const f = fixture();
		f.sources.set(TAB, "C:/proj/original.jsonl");
		await assert.rejects(f.launcher.launch({ ...request, transport: "native" }), /not used/);
		assert.deepEqual(f.dropped, [TAB]);
	});

	it("starts nothing in a window whose installed package changed on disk, before any hook runs", async () => {
		const f = fixture({ refusal: "the installed extension changed on disk" });
		const result = await f.launcher.launch(request);
		assert.deepEqual(result, { state: "not-started", reason: "the installed extension changed on disk" });
		assert.deepEqual(f.events, [], "no precheck, staging, reservation or launch");
		assert.equal(f.launches.length, 0);
	});

	it("does not refuse an attach of a host that already runs when the installed package changed", async () => {
		const f = fixture({ refusal: "the installed extension changed on disk", attachable: true });
		const result = await f.launcher.attach(attachRequest(null));
		f.deps.brokerWatches.get(f.runtime)?.();
		assert.equal(result.state, "attached");
	});
});

describe("attach", () => {
	it("hands back the provider id the index recorded for the host, not the row's file id (a Chat clear rotated it)", async () => {
		const f = fixture({ attachable: true });
		const result = await f.launcher.attach(attachRequest("provider-after-clear"));
		f.deps.brokerWatches.get(f.runtime)?.();
		assert.equal(result.state, "attached");
		assert.equal(result.state === "attached" ? result.host.sessionId : null, "provider-after-clear");
	});

	it("falls back to the row's id for a host whose provider id was never recorded", async () => {
		const f = fixture({ attachable: true });
		const result = await f.launcher.attach(attachRequest(null));
		f.deps.brokerWatches.get(f.runtime)?.();
		assert.equal(result.state === "attached" ? result.host.sessionId : "unavailable", "file-session-id");
	});
});

describe("startConversation", () => {
	it("adopts before the broker watch is installed and runs the view and attach hooks after it", async () => {
		const f = fixture();
		await f.launcher.startConversation(TAB, f.runtime, null, false);
		assert.ok(f.deps.brokerWatches.has(f.runtime), "the watch is installed");
		f.deps.brokerWatches.get(f.runtime)?.();
		assert.deepEqual(f.events.filter(event => event !== "isCurrent"), ["adopt", "prepareView", "startLive", "attached"]);
	});

	it("runs the attached hook again on a second call without a second launch", async () => {
		const f = fixture();
		await f.launcher.startConversation(TAB, f.runtime, null, true);
		await f.launcher.startConversation(TAB, f.runtime, null, true);
		f.deps.brokerWatches.get(f.runtime)?.();
		assert.equal(f.events.filter(event => event === "attached").length, 2);
		assert.ok(!f.events.includes("launch"));
	});

	it("asks the conversation to reclaim input only when it adopts a surviving host, never for a fresh launch or a bare call", async () => {
		const adopting = fixture({ attachable: true });
		assert.equal((await adopting.launcher.attach(attachRequest(null))).state, "attached");
		adopting.deps.brokerWatches.get(adopting.runtime)?.();
		assert.deepEqual(adopting.liveInputs.map(input => input.reclaimInput), [{ attempts: 10, intervalMs: 200 }], "about ten tries over two seconds");
		const launching = fixture();
		assert.equal((await launching.launcher.launch(request)).state, "running");
		launching.deps.brokerWatches.get(launching.runtime)?.();
		assert.deepEqual(launching.liveInputs.map(input => input.reclaimInput), [undefined]);
		const bare = fixture();
		await bare.launcher.startConversation(TAB, bare.runtime, null, true);
		bare.deps.brokerWatches.get(bare.runtime)?.();
		assert.deepEqual(bare.liveInputs.map(input => input.reclaimInput), [undefined], "replaying from the start does not arm it");
	});
});

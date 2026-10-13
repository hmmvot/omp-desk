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
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, before, describe, it } from "node:test";
import { build } from "esbuild";
import type { BrokerSlotStore } from "../host/broker-slots.ts";
import type { SessionHostRuntime } from "../host/native-session.ts";
import type { OmpHostLaunchRequest, SessionIndex } from "../host/session-index.ts";
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

function fixture(options: { precheck?: boolean; launch?: "running" | "not-started" | "unconfirmed"; stagingFails?: boolean } = {}) {
	const events: string[] = [];
	const runtime = {
		kind: "chat", pid: 4242, cwd: request.cwd, notice: null, binary: null, resolutionMs: undefined,
		identity: { slot: "slot-x", childCreationTime: "created" },
		handle: { brokerPid: process.pid, record: { brokerCreationTime: null } },
	} as unknown as SessionHostRuntime;
	const window: LauncherWindow = {
		async retireDocument() { events.push("retireDocument"); return "editor-1"; },
		adopt() { events.push("adopt"); },
		isCurrent: () => { events.push("isCurrent"); return false; },
		async prepareView() { events.push("prepareView"); },
		attached() { events.push("attached"); },
		async launchPrecheck() { events.push("launchPrecheck"); return options.precheck === true; },
		async connectControl() { events.push("connectControl"); },
		async reconnectControl() { events.push("reconnectControl"); },
		controlFailed() { events.push("controlFailed"); },
		async brokerLost() { events.push("brokerLost"); },
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
	const deps: LocalLauncherDeps = {
		index: { get: () => null, setRunIntent: async () => { events.push("setRunIntent"); } } as unknown as SessionIndex,
		window,
		chat: { startLive: () => { events.push("startLive"); return undefined as never; } },
		diagnostics,
		entries: async () => {
			if (options.stagingFails === true) throw new Error("staging failed");
			return { hostControl: { path: "control.mjs" } } as never;
		},
		hosts: {
			launchRpc: async () => { events.push("launch"); return state === "running" ? { state, reason: "ok", runtime } : { state, reason: "no", runtime: null }; },
			launchNative: async () => { throw new Error("not used"); },
			attachRpc: async () => ({ state: "unavailable", reason: "x", runtime: null }),
			attachNative: async () => ({ state: "unavailable", reason: "x", runtime: null }),
		} as never,
		brokerSlots,
		brokerClient: async () => ({}) as never,
		attachBrokerClient: async () => null,
		brokerUnavailableReason: () => null,
		brokerWatches: new WeakMap(),
		linkReminder: () => false,
		control: { storeRecipient: async () => { events.push("storeRecipient"); }, directory: () => "control-dir" },
		diagnosticsLabel: cwd => cwd,
		log: () => undefined,
	};
	const launcher = new LocalLauncher(deps);
	return { launcher, events, recorded, forgotten, runtime, deps };
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
});

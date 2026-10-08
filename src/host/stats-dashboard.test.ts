import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PtyHandle } from "./pty-client.ts";
import type { PtyBrokerRecord } from "./pty-protocol.ts";
import { isPtyKind } from "./pty-protocol.ts";
import { admitStatsLaunch, compatibleStatsResponse, ensureStatsDashboard, statsLaunchSpec, statsPreloadSupported } from "./stats-dashboard.ts";
import type { StatsDashboardPorts, StatsProbe } from "./stats-dashboard.ts";
import { statsWebviewHtml } from "./stats-webview.ts";

function harness(probes: StatsProbe[] = ["absent", "absent", "absent", "ready"]) {
	let now = 0;
	const calls: string[] = [];
	let record: PtyBrokerRecord | null = null;
	const child = {
		record: { brokerId: "broker-1" }, kind: "stats-dashboard", state: "running", closed: false,
		async refreshStatus() { calls.push("status"); },
		async shutdown() { calls.push("shutdown"); return { stopped: true }; },
		disconnect() { calls.push("disconnect"); },
	};
	const handle = child as unknown as PtyHandle;
	const ports: StatsDashboardPorts = {
		client: {
			async list() { calls.push("list"); return { directory: "fixture", missing: false, records: record === null ? [] : [record], invalid: [] }; },
			async attachRecord() { calls.push("attach"); return { state: "attached", reason: "attached", handle }; },
			async launch(spec) {
				calls.push("launch"); assert.equal(spec.kind, "stats-dashboard"); assert.match(spec.slot, /^stats:/);
				return { state: "running", reason: "started", handle, adopted: false, brokerPid: 123 };
			},
		},
		async withLaunchLock(work) { calls.push("lock"); try { return await work(); } finally { calls.push("unlock"); } },
		brokerAlive: () => true,
		async brokerGone() { return false; },
		async retireExited(handle) { await handle.shutdown({ requireStopped: true }); },
		async resolveLaunch() { calls.push("resolve"); return statsLaunchSpec({ command: "omp.exe", prefixArgs: [] }, "C:/fixture"); },
		async observeOpener() { calls.push("opener"); },
		async probe() { calls.push("probe"); return probes.length > 1 ? probes.shift()! : probes[0]!; },
		now: () => now, async wait(ms) { now += ms; }, readinessMs: 1000,
	};
	return { ports, calls, child, record(value: PtyBrokerRecord | null) { record = value; } };
}

const RECORD = { kind: "stats-dashboard", brokerId: "broker-1", brokerPid: 123, brokerCreationTime: "134349421014308869" } as PtyBrokerRecord;

describe("Stats dashboard lifecycle", () => {
	it("recognizes only the installed compatible security/bind-host contract", () => {
		const headers = { "x-omp-stats-dashboard": "3", "x-omp-stats-hostname": "127.0.0.1" };
		assert.equal(compatibleStatsResponse(200, headers), true);
		for (const variant of [ { ...headers, "x-omp-stats-dashboard": "2" }, { ...headers, "x-omp-stats-hostname": "0.0.0.0" }, { ...headers, "access-control-allow-origin": "*" } ]) {
			assert.equal(compatibleStatsResponse(200, variant), false);
		}
		assert.equal(compatibleStatsResponse(500, headers), false);
		assert.equal(compatibleStatsResponse(200, {}), false);
	});
	it("opens an existing compatible listener without launching or resolving OMP", async () => {
		const h = harness(["ready"]);
		await ensureStatsDashboard(h.ports);
		assert.deepEqual(h.calls, ["probe"]);
	});
	it("rejects an unrelated listener without spawning", async () => {
		const h = harness(["occupied"]);
		await assert.rejects(ensureStatsDashboard(h.ports), /Port 3847.*not a compatible/);
		assert.equal(h.calls.includes("launch"), false);
	});
	it("launches a broker and waits for identity-header readiness before disconnecting presentation", async () => {
		const h = harness(["absent", "absent", "absent", "absent", "ready"]);
		await ensureStatsDashboard(h.ports);
		assert.equal(h.calls.filter(call => call === "launch").length, 1);
		assert.equal(h.calls.includes("status"), true);
		assert.equal(h.calls.at(-1), "disconnect");
		assert.equal(h.calls.includes("shutdown"), false);
	});
	it("reattaches a startup broker after reload without starting another child", async () => {
		const h = harness(["absent", "ready"]); h.record(RECORD);
		await ensureStatsDashboard(h.ports);
		assert.equal(h.calls.includes("attach"), true);
		assert.equal(h.calls.includes("launch"), false);
		assert.equal(h.calls.includes("resolve"), false);
	});
	it("retires a confirmed exited broker before relaunching", async () => {
		const h = harness(); h.record(RECORD); h.child.state = "exited";
		const original = h.ports.client.launch;
		h.ports.client.launch = async spec => { h.child.state = "running"; return original(spec); };
		await ensureStatsDashboard(h.ports);
		assert.ok(h.calls.indexOf("shutdown") < h.calls.indexOf("launch"));
	});
	it("retains a running broker on readiness timeout with actionable Stop recovery", async () => {
		const h = harness(["absent"]);
		await assert.rejects(ensureStatsDashboard(h.ports), /process remains tracked.*Processes/);
		assert.equal(h.calls.includes("shutdown"), false);
		assert.equal(h.calls.at(-1), "disconnect");
	});
	it("retires a naturally failed child without issuing a stop", async () => {
		const h = harness(["absent"]); h.child.state = "exited";
		await assert.rejects(ensureStatsDashboard(h.ports), /exited before/);
		assert.equal(h.calls.includes("shutdown"), true);
	});
	it("never replaces an unreachable recorded broker", async () => {
		const h = harness(["absent"]); h.record(RECORD);
		h.ports.client.attachRecord = async () => ({ state: "unavailable", reason: "unreachable", handle: null });
		await assert.rejects(ensureStatsDashboard(h.ports), /could not be reached/);
		assert.equal(h.calls.includes("launch"), false);
	});
	it("keeps dead-broker recovery records without letting them block a fresh launch", async () => {
		const h = harness(); h.record(RECORD);
		h.ports.client.attachRecord = async () => ({ state: "unavailable", reason: "gone", handle: null });
		h.ports.brokerGone = async () => true;
		await ensureStatsDashboard(h.ports);
		assert.equal(h.calls.includes("launch"), true);
		assert.equal(h.calls.includes("shutdown"), false);
	});
	it("skips definitely dead broker PIDs without identity helper work", async () => {
		const h = harness(); h.record(RECORD);
		h.ports.brokerAlive = () => false;
		h.ports.brokerGone = async () => { throw new Error("unexpected identity query"); };
		await ensureStatsDashboard(h.ports);
		assert.equal(h.calls.includes("attach"), false);
		assert.equal(h.calls.includes("launch"), true);
	});
	it("skips records without a creation-time identity", async () => {
		const h = harness(); h.record({ ...RECORD, brokerCreationTime: null });
		await ensureStatsDashboard(h.ports);
		assert.equal(h.calls.includes("attach"), false);
		assert.equal(h.calls.includes("launch"), true);
	});
	it("releases admission before waiting for dashboard readiness", async () => {
		const h = harness(["absent", "absent", "absent", "absent", "ready"]);
		await ensureStatsDashboard(h.ports);
		assert.ok(h.calls.indexOf("unlock") < h.calls.indexOf("status"));
	});
	it("does not misidentify a slow listener as an unrelated HTTP server", async () => {
		const h = harness(["unresponsive"]);
		await assert.rejects(ensureStatsDashboard(h.ports), /not responding/);
		assert.equal(h.calls.includes("launch"), false);
	});
	it("preserves the installed launch prefix and loopback exposure", () => {
		const spec = statsLaunchSpec({ command: "bun.exe", prefixArgs: ["entry.ts"] }, "C:/fixture");
		assert.deepEqual(spec.args, ["entry.ts", "stats", "--host", "127.0.0.1", "--port", "3847"]);
		assert.equal(spec.kind, "stats-dashboard"); assert.equal(isPtyKind(spec.kind), true);
		assert.notEqual(statsLaunchSpec({ command: "omp.exe", prefixArgs: [] }, "C:/fixture").slot, spec.slot);
	});
	it("frames only the mapped origin with same-origin scripts for dashboard SSE", () => {
		const html = statsWebviewHtml("https://mapped.example/dashboard/?a=1&b=2", "abcd");
		assert.ok(html.includes("frame-src https://mapped.example;"));
		assert.ok(html.includes('sandbox="allow-scripts allow-same-origin allow-forms allow-downloads"'));
		assert.ok(html.includes("a=1&amp;b=2"));
		assert.ok(!html.includes("acquireVsCodeApi"));
		assert.throws(() => statsWebviewHtml("file:///dashboard", "abcd"));
	});
});

describe("Stats browser-side-effect admission", () => {
	const binary = { command: "bun.exe", prefixArgs: ["entry.ts"] };
	it("requires a successful harmless marker probe rather than a version guess", () => {
		assert.equal(statsPreloadSupported({ exitCode: 0, stdout: "18.6.3", stderr: "OMP_DESK_STATS_PRELOAD_READY\n" }), true);
		assert.equal(statsPreloadSupported({ exitCode: 0, stdout: "18.0.4", stderr: "" }), false);
		assert.equal(statsPreloadSupported({ exitCode: 1, stdout: "", stderr: "OMP_DESK_STATS_PRELOAD_READY\n" }), false);
	});
	it("uses verified preload before the installed entry without asking to open a browser", async () => {
		let asks = 0;
		const spec = await admitStatsLaunch(binary, "C:/fixture", "C:/preload.mjs", async () => { asks++; return false; });
		assert.deepEqual(spec?.args.slice(0, 3), ["--preload", "C:/preload.mjs", "entry.ts"]);
		assert.equal(asks, 0);
	});
	it("never starts or opens a tab after unsupported-build Cancel", async () => {
		let asks = 0;
		assert.equal(await admitStatsLaunch(binary, "C:/fixture", null, async () => { asks++; return false; }), null);
		assert.equal(asks, 1);
		const h = harness(["absent"]);
		h.ports.resolveLaunch = async () => null;
		assert.equal(await ensureStatsDashboard(h.ports), false);
		assert.equal(h.calls.includes("launch"), false);
	});
	it("runs the original stats command only after explicit unsupported-build Start, with no remembered consent", async () => {
		let asks = 0;
		const confirm = async () => { asks++; return true; };
		const spec = await admitStatsLaunch(binary, "C:/fixture", null, confirm);
		assert.deepEqual(spec?.args.slice(0, 2), ["entry.ts", "stats"]);
		await admitStatsLaunch(binary, "C:/fixture", null, confirm);
		assert.equal(asks, 2);
	});
});

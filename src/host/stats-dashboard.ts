import { randomUUID } from "node:crypto";
import { request } from "node:http";
import { createConnection } from "node:net";
import type { PtyBrokerClient, PtyHandle, PtyLaunchSpec } from "./pty-client";
import type { PtyBrokerRecord } from "./pty-protocol";
import type { OmpCommand } from "./native-terminal";
import { acquirePtySlotLock, releasePtySlotLock } from "./pty-registry.ts";

export const STATS_PORT = 3847;
export const STATS_ORIGIN = `http://127.0.0.1:${STATS_PORT}`;
const STATS_LOCK = "stats-dashboard-launch";
export type StatsProbe = "ready" | "occupied" | "unresponsive" | "absent";

/** Match installed OMP's security-version/bind-host reuse contract, without fetching its data. */
export function compatibleStatsResponse(status: number | undefined, headers: Readonly<Record<string, string | string[] | undefined>>): boolean {
	return status === 200 && headers["x-omp-stats-dashboard"] === "3" &&
		headers["x-omp-stats-hostname"] === "127.0.0.1" && headers["access-control-allow-origin"] === undefined;
}

/** A non-HTTP TCP listener is occupied too; never ask OMP to reclaim it. */
export async function probeStatsDashboard(): Promise<StatsProbe> {
	const http = Promise.withResolvers<StatsProbe | null>();
	const req = request(`${STATS_ORIGIN}/api/stats/models`, { method: "GET" }, response => {
		http.resolve(compatibleStatsResponse(response.statusCode, response.headers) ? "ready" : "occupied");
		response.destroy();
	});
	const httpTimer = setTimeout(() => { http.resolve(null); req.destroy(); }, 750);
	req.on("close", () => clearTimeout(httpTimer));
	req.on("error", () => http.resolve(null));
	req.end();
	const result = await http.promise;
	if (result !== null) return result;
	const tcp = Promise.withResolvers<StatsProbe>();
	const socket = createConnection({ host: "127.0.0.1", port: STATS_PORT });
	const finish = (result: StatsProbe): void => { clearTimeout(timer); socket.destroy(); tcp.resolve(result); };
	const timer = setTimeout(() => finish("unresponsive"), 750);
	socket.once("connect", () => finish("unresponsive"));
	socket.once("error", (error: NodeJS.ErrnoException) => finish(error.code === "ECONNREFUSED" ? "absent" : "unresponsive"));
	return await tcp.promise;
}

export function statsLaunchSpec(binary: OmpCommand, cwd: string, preload: string | null = null): PtyLaunchSpec {
	return {
		slot: `stats:${randomUUID()}`, kind: "stats-dashboard", file: binary.command,
		args: [...(preload === null ? [] : ["--preload", preload]), ...binary.prefixArgs, "stats", "--host", "127.0.0.1", "--port", String(STATS_PORT)],
		cwd, title: "Stats dashboard", cols: 120, rows: 30,
	};
}

/** A harmless version invocation must positively observe the installed preload's marker. */
export function statsPreloadSupported(result: { readonly exitCode: number; readonly stdout: string; readonly stderr: string }): boolean {
	return result.exitCode === 0 && `${result.stdout}\n${result.stderr}`.split(/\r?\n/).includes("OMP_DESK_STATS_PRELOAD_READY");
}

/** Unsupported builds require per-start consent; never remember or bypass that choice. */
export async function admitStatsLaunch(binary: OmpCommand, cwd: string, verifiedPreload: string | null, confirmBrowser: () => Promise<boolean>): Promise<PtyLaunchSpec | null> {
	if (verifiedPreload === null && !(await confirmBrowser())) return null;
	return statsLaunchSpec(binary, cwd, verifiedPreload);
}

/** Fixed interprocess admission key, separate from fresh retained recovery-record slots. */
export async function withStatsLaunchLock<T>(storageDir: string, work: () => Promise<T>): Promise<T> {
	const holderId = `stats-${randomUUID()}`;
	const lock = await acquirePtySlotLock(storageDir, STATS_LOCK, { holderId, waitMs: 35_000 });
	if (!lock.acquired) throw new Error("Another window is starting OMP Stats. Wait for it to finish, then try Open Stats again.");
	try { return await work(); }
	finally { await releasePtySlotLock(storageDir, STATS_LOCK, holderId); }
}

export interface StatsDashboardPorts {
	readonly client: Pick<PtyBrokerClient, "list" | "attachRecord" | "launch">;
	withLaunchLock<T>(work: () => Promise<T>): Promise<T>;
	brokerAlive(pid: number): boolean;
	brokerGone(record: PtyBrokerRecord): Promise<boolean>;
	retireExited(handle: PtyHandle): Promise<void>;
	resolveLaunch(): Promise<PtyLaunchSpec | null>;
	observeOpener(handle: PtyHandle): Promise<void>;
	probe(): Promise<StatsProbe>;
	now(): number;
	wait(ms: number): Promise<void>;
	readonly readinessMs?: number;
}

const RECOVERY = "See Processes to stop Stats dashboard; if it belongs to another OMP Desk version, close it there, then try Open Stats again.";
const CONFLICT = `Port ${STATS_PORT} is occupied by a listener that is not a compatible OMP Stats dashboard. Stop that listener or change its port, then try Open Stats again.`;
const UNRESPONSIVE = `The listener on port ${STATS_PORT} is not responding as an OMP Stats dashboard. Wait for it to become ready, or stop that listener, then try Open Stats again.`;

async function awaitDashboard(handle: PtyHandle, ports: StatsDashboardPorts): Promise<void> {
	const deadline = ports.now() + (ports.readinessMs ?? 30_000);
	while (ports.now() < deadline) {
		const probe = await ports.probe();
		if (probe === "ready") return;
		if (handle.closed) throw new Error(`The Stats background process disconnected before readiness. ${RECOVERY}`);
		await handle.refreshStatus();
		if (handle.state === "exited") {
			await ports.retireExited(handle);
			throw new Error(probe === "occupied" ? CONFLICT : "OMP Stats exited before its dashboard was ready. See OMP Desk output and try Open Stats again.");
		}
		await ports.wait(250);
	}
	throw new Error(`OMP Stats did not become ready in time. Its process remains tracked. ${RECOVERY}`);
}

/** Compatible external servers are reused, never represented by a fake owned broker. */
export async function ensureStatsDashboard(ports: StatsDashboardPorts): Promise<boolean> {
	if (await ports.probe() === "ready") return true;
	let cancelled = false;
	const handle = await ports.withLaunchLock(async () => {
		for (const record of (await ports.client.list()).records) {
			if (record.kind !== "stats-dashboard") continue;
			if (record.brokerCreationTime === null || !ports.brokerAlive(record.brokerPid)) continue;
			const attached = await ports.client.attachRecord(record, { adopted: true });
			if (attached.handle === null) {
				if (await ports.brokerGone(record)) continue; // Keep stale evidence; it cannot block a fresh slot.
				throw new Error(`The recorded Stats process could not be reached. ${RECOVERY}`);
			}
			if (attached.handle.state !== "exited") return attached.handle;
			try { await ports.retireExited(attached.handle); }
			finally { attached.handle.disconnect(); }
		}
		const beforeLaunch = await ports.probe();
		if (beforeLaunch === "ready") return null;
		if (beforeLaunch === "occupied") throw new Error(CONFLICT);
		if (beforeLaunch === "unresponsive") throw new Error(UNRESPONSIVE);
		const spec = await ports.resolveLaunch();
		if (spec === null) { cancelled = true; return null; }
		// The user may have spent time answering the browser-side-effect modal.
		const lastProbe = await ports.probe();
		if (lastProbe === "ready") return null;
		if (lastProbe === "occupied") throw new Error(CONFLICT);
		if (lastProbe === "unresponsive") throw new Error(UNRESPONSIVE);
		const outcome = await ports.client.launch(spec);
		if (outcome.handle === null) throw new Error(`The Stats dashboard could not be started (${outcome.state}). ${RECOVERY}`);
		return outcome.handle;
	});
	if (handle === null) return !cancelled;
	try {
		await awaitDashboard(handle, ports);
		if (!handle.adopted) await ports.observeOpener(handle);
		return true;
	}
	finally { handle.disconnect(); }
}

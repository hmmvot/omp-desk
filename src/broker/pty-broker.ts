/**
 * The extension-owned PTY broker
 * ([ADR-0024](../../docs/decisions/0024-own-omp-pty-for-in-tab-terminal.md)).
 *
 * One detached Node process owns one PTY — and therefore one native OMP TUI or one
 * folder shell — for as long as that child lives. It is not a VS Code extension, an
 * editor or a Webview: closing the editor stops nothing, reloading the extension
 * host stops nothing, and a window that exits leaves the child running under a
 * broker the next window can find through its record and reattach to. That is the
 * whole point of putting a process between the editor and OMP, and it is why the
 * broker's own state (screen, identity, input ownership) lives here rather than in
 * a frontend.
 *
 * A `managed-rpc` slot
 * ([ADR-0038](../../docs/decisions/0038-host-chat-over-rpc-ui-on-a-broker-pipe-child.md))
 * is the same broker around a different child: `omp --mode rpc-ui` on plain pipes, with no
 * pseudo console and no `node-pty` or screen model loaded. The identity, record, lock,
 * authentication and never-auto-stop rules are unchanged; the child's stdout is drained into
 * a bounded line ring (`./rpc-ring.ts`), stdin takes whole lines only, and a stop is
 * closing stdin. The `rpc-*` frames are kind-gated: a terminal broker refuses them and an
 * rpc broker refuses the terminal ones, both as `wrong-kind`.
 *
 * It is run from a content-addressed copy of a staged tree outside the installed
 * extension folder ([ADR-0012](../../docs/decisions/0012-run-child-process-entries-from-staged-copies.md)):
 * this entry, the PowerShell identity probe, and the `node-pty` package with its
 * native addon, `conpty.dll` and `OpenConsole.exe`. Nothing it loads is inside the
 * installed extension folder, so a forced reinstall can rename that folder while a
 * session keeps running.
 *
 * Closing the pseudo console is not a root-only operation: it ends the session for every
 * console client still attached to it, and it is the only termination this provider
 * offers. No numeric process id is ever signalled — an id is not an identity, and the
 * process it named may have exited and the id may since belong to someone else.
 *
 * What it refuses to do, deliberately:
 * - start without proving its own kernel identity. The token in its record
 *   authenticates a connection, but the client must also be able to check *which
 *   process* answered, and that check needs the creation time this process can only
 *   read through the staged probe. A broker that cannot produce it exits with
 *   `identity-unavailable` instead of publishing a record a careful client would
 *   have to refuse;
 * - start when the record directory is not provably owner-only, because the record
 *   carries a bearer token;
 * - claim a slot that already has a record. Two windows racing for one slot produce
 *   one occupant; the loser reports the occupant rather than starting a second
 *   writer;
 * - exit while its child is alive on its own initiative, or drop the child when a
 *   frontend goes away. Losing every client is an ordinary state: output keeps being
 *   consumed, the screen keeps being maintained, and the replay backlog keeps being
 *   bounded.
 *
 * Three process identities are kept apart: this broker's pid, the native child's pid
 * (`pty.pid` with the ConPTY backend *is* the process started in the pseudo console,
 * which is what OMP's own registry and host-control channel report) and the
 * generation minted for this start. Each is recorded with its kernel creation time.
 *
 * The Windows backend is the bundled `conpty.dll` + `OpenConsole.exe`
 * (`useConptyDll: true`). In testing, the operating system's own ConPTY path was broken:
 * its data path produced no child output at all, input never reached the child, and
 * `kill()` left the child alive. The bundled one worked end to end, including
 * termination of a shell's whole process tree when the pseudo console closes.
 * `pty.pid` is the child on both paths, but only the bundled path was observed to work,
 * so it is the only one this broker uses.
 *
 * Bounded and honest about it:
 * - the retained screen, the replay backlog, each connection's send queue and every
 *   probe answer have bounds;
 * - `stop` reports `verified: true` only when the whole process tree is proven gone.
 *   This provider has no kernel-enforced process group, so it always reports
 *   `verified: false`, together with what was and was not established: whether the
 *   native pid's creation-time reading says the process is gone, and what the
 *   descendant read saw (tree `unknown` or `remaining`);
 * - the optional `--log` file records lifecycle facts only. It never receives
 *   terminal output, typed input, the token or any frame body.
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import process from "node:process";
import type * as NodePty from "node-pty";
import type { IPty } from "node-pty";
import {
	PTY_PROTOCOL_VERSION,
	PTY_MAX_SNAPSHOT_CHARS,
	PTY_RPC_MAX_STDERR_CHARS,
	PTY_RPC_MAX_WRITE_BYTES,
	PtyRpcFragmentAssembler,
	PtyRpcLineTooLongError,
	isPtyRpcOnlyRequest,
	isPtyTerminalOnlyRequest,
	PTY_RECORD_VERSION,
	PTY_RUNTIME_VERSION,
	PTY_SERVICE,
	PTY_DEFAULT_OWNER_GRACE_MS,
	PTY_OWNER_GRACE_RANGE,
	clampPtySize,
	chunkPtyOutput,
	createPtyBrokerId,
	createPtyGeneration,
	createPtyToken,
	isPtyDigest,
	isPtyFrontendId,
	isPtyKind,
	isPtySlot,
	isPtyOwnerHint,
	parsePtyTitle,
	PTY_COLUMN_RANGE,
	PTY_ROW_RANGE,
	type PtyBrokerRecord,
	type PtyClientFrame,
	type PtyEventFrame,
	type PtyKind,
	type PtyOwnerHint,
	type PtyOwnerStopStatus,
	type PtyRefusalCode,
	type PtyStatusPayload,
	type PtyStopMode,
	type PtyStopResult,
	type PtyTreeEvidence,
	type PtyTreeVerdict,
} from "../host/pty-protocol.ts";
import {
	isPtyProcessAlive,
	queryPtyProcessIdentity,
	queryPtyProcessTree,
	waitForPtyProcessGone,
	type PtyProbeHelper,
} from "../host/pty-identity.ts";
import { startPtyBrokerServer, type PtyBrokerServer, type PtyBrokerSideConnection } from "../host/pty-ipc.ts";
import { claimPtyRecord, ensurePtyStateAccess, retirePtyRecord } from "../host/pty-registry.ts";
import type * as PtyScreenModule from "./pty-screen.ts";
import type { PtyScreenChunk, PtyScreenModel } from "./pty-screen.ts";
import { RpcChildWriteError, startRpcChild, type RpcChild } from "./rpc-child.ts";
import { RPC_PACE_BYTES, RpcLineRing, RpcSubscriber, type RpcSink } from "./rpc-ring.ts";
import { PTY_OWNER_EXIT_REASON, PtyOwnerMonitor } from "./pty-owner-monitor.ts";
import {
	SELF_CHECK_DEADLINE_MS,
	SELF_CHECK_OUTPUT_LIMIT,
	selfCheckChild,
	selfCheckPlan,
	selfCheckTools,
	selfCheckVerdict,
} from "./pty-self-check.ts";

/** Exit codes of this entry, for a caller that only has the child's status. */
export const PTY_BROKER_EXIT = {
	/** The broker shut down normally, whether a child ever ran or not. */
	ok: 0,
	/** Bad arguments: nothing was claimed and no child was started. */
	arguments: 5,
	/** The record directory is missing or not provably owner-only. */
	storage: 2,
	/** The slot already has a record; this broker started nothing. */
	slotOccupied: 3,
	/** The PTY child could not be started. */
	spawnFailed: 4,
	/** This process could not prove its own kernel identity. */
	identityUnavailable: 6,
	/** The staged runtime could not run a child through its own PTY backend. */
	selfCheckFailed: 7,
} as const;

/** Default time a broker with an exited child stays available without a client. */
export const PTY_DEFAULT_EXIT_RETENTION_MS = 10 * 60_000;

/** Default bound for one stop request. */
export const PTY_DEFAULT_STOP_TIMEOUT_MS = 20_000;

/**
 * Process-environment markers that must not reach a child from the broker's own
 * environment, which it inherits from VS Code and so from whatever started VS Code.
 *
 * `ELECTRON_RUN_AS_NODE` is how this extension starts its own Node processes from
 * VS Code's Electron binary; a folder shell that inherited it would hand every
 * `node`/`code` started inside it this extension's runtime instead of the user's.
 * The rest are OMP's own runtime markers (verified in OMP 18.8.5): it sets
 * `PI_NO_PTY`/`PI_NO_TITLE` on itself in protocol modes, `PI_NOTIFICATIONS=off` in
 * RPC mode, the `PI_*` eval bridge variables for its kernels, and this extension
 * sets the host-control pair for a native child. A VS Code started from inside an
 * OMP session would otherwise launch native sessions without PTY bash or titles.
 */
export const SCRUBBED_INHERITED_ENV: Readonly<Record<string, true>> = {
	ELECTRON_RUN_AS_NODE: true,
	PI_NO_PTY: true, PI_NO_TITLE: true, PI_NOTIFICATIONS: true,
	PI_SESSION_FILE: true, PI_ARTIFACTS_DIR: true, PI_TOOL_BRIDGE_URL: true, PI_TOOL_BRIDGE_TOKEN: true, PI_TOOL_BRIDGE_SESSION: true, PI_EVAL_LOCAL_ROOTS: true,
	OMP_VSCODE_CONTROL_DIR: true, OMP_VSCODE_CONTROL_SLOT: true,
};

/**
 * A child's environment: the broker's own minus {@link SCRUBBED_INHERITED_ENV}, then
 * the caller's explicit deltas, which may set any of those markers deliberately
 * (the host-control pair). `ELECTRON_RUN_AS_NODE` is never passed on.
 */
export function childEnvironment(inherited: Readonly<Record<string, string | undefined>>, deltas: Readonly<Record<string, string>>): Record<string, string> {
	const env: Record<string, string> = {};
	// Windows environment names are case-insensitive.
	for (const [key, value] of Object.entries(inherited)) {
		if (value === undefined || Object.hasOwn(SCRUBBED_INHERITED_ENV, key.toUpperCase())) continue;
		env[key] = value;
	}
	for (const [key, value] of Object.entries(deltas)) {
		if (key.toUpperCase() === "ELECTRON_RUN_AS_NODE") continue;
		env[key] = value;
	}
	return env;
}

/** Default bound on a broker's own screen backlog when the caller does not set one. */
const DEFAULT_BACKLOG_CHARS = 2 * 1024 * 1024;
const DEFAULT_SCROLLBACK_LINES = 2000;

interface BrokerOptions {
	readonly slot: string;
	readonly kind: PtyKind;
	readonly storageDir: string;
	readonly brokerId: string;
	readonly generation: string;
	readonly treeDigest: string;
	readonly file: string;
	readonly args: readonly string[];
	readonly cwd: string;
	readonly env: Readonly<Record<string, string>>;
	readonly cols: number;
	readonly rows: number;
	readonly title: string | null;
	readonly scrollbackLines: number;
	readonly backlogChars: number;
	readonly snapshotChars: number;
	readonly helper: PtyProbeHelper | null;
	/** The staged owner-watch helper, or `null` when this build has none. */
	readonly ownerHelper: PtyProbeHelper | null;
	/** The owner hint a launch was started with; a hint only, never authority. */
	readonly ownerHint: PtyOwnerHint | null;
	/** Finite grace between every admitted owning VS Code main process having signaled and the one stop attempt. */
	readonly ownerGraceMs: number;
	readonly logPath: string | null;
	readonly exitRetentionMs: number;
	/** The lock holder id of the launcher that started this broker, when it gave one. */
	readonly launchId: string | null;
}

/** The flags that take one value, so an unknown flag is refused rather than ignored. */
const VALUED_FLAGS: Record<string, true> = {
	slot: true,
	kind: true,
	"storage-dir": true,
	"broker-id": true,
	generation: true,
	"tree-digest": true,
	file: true,
	cwd: true,
	cols: true,
	rows: true,
	title: true,
	scrollback: true,
	backlog: true,
	"snapshot-chars": true,
	helper: true,
	"helper-sha256": true,
	"owner-helper": true,
	"owner-helper-sha256": true,
	"owner-grace-ms": true,
	"owner-host-pid": true,
	"owner-parent-pid": true,
	"owner-main-pid": true,
	"launch-id": true,
	log: true,
	"exit-retention-ms": true,
};

/**
 * The owner hint's three pid flags, in the order the hint's fields are read. A hint is
 * all three or none: a partially given topology is refused rather than guessed at.
 */
const OWNER_HINT_FLAGS = ["owner-host-pid", "owner-parent-pid", "owner-main-pid"] as const;

/** Parse one argument line, or report the line as unusable. */
export function parsePtyBrokerArgs(argv: readonly string[]): BrokerOptions | string {
	const values = new Map<string, string>();
	const repeated = new Map<string, string[]>();
	const flags = new Set<string>();
	for (let index = 0; index < argv.length; index += 1) {
		const token = argv[index];
		if (token === undefined) break;
		if (!token.startsWith("--")) return `unexpected argument ${JSON.stringify(token)}`;
		const name = token.slice(2);
		if (name === "arg" || name === "env") {
			const value = argv[index + 1];
			if (value === undefined) return `--${name} needs a value`;
			index += 1;
			const list = repeated.get(name) ?? [];
			list.push(value);
			repeated.set(name, list);
			continue;
		}
		if (VALUED_FLAGS[name] === true) {
			const value = argv[index + 1];
			if (value === undefined) return `--${name} needs a value`;
			index += 1;
			values.set(name, value);
			continue;
		}
		if (name === "no-helper") {
			flags.add(name);
			continue;
		}
		return `unknown argument --${name}`;
	}
	for (const name of ["slot", "kind", "storage-dir", "file", "cwd"]) {
		if (!values.has(name)) return `--${name} is required`;
	}
	const slot = values.get("slot") ?? "";
	if (!isPtySlot(slot)) return "--slot is not a usable slot key";
	const kind = values.get("kind") ?? "";
	if (!isPtyKind(kind)) return "--kind must be managed-rpc, managed-omp, folder-shell or stats-dashboard";
	const storageDir = values.get("storage-dir") ?? "";
	if (!isAbsolute(storageDir)) return "--storage-dir must be an absolute path";
	const file = values.get("file") ?? "";
	if (!isAbsolute(file)) return "--file must be an absolute path";
	const cwd = values.get("cwd") ?? "";
	if (!isAbsolute(cwd)) return "--cwd must be an absolute path";
	const treeDigest = values.get("tree-digest") ?? "";
	if (!isPtyDigest(treeDigest)) return "--tree-digest must be the digest of the staged runtime tree";
	const env: Record<string, string> = {};
	for (const entry of repeated.get("env") ?? []) {
		const separator = entry.indexOf("=");
		if (separator <= 0) return `--env expects NAME=VALUE, got ${JSON.stringify(entry)}`;
		env[entry.slice(0, separator)] = entry.slice(separator + 1);
	}
	const size = clampPtySize(
		values.has("cols") ? Number(values.get("cols")) : undefined,
		values.has("rows") ? Number(values.get("rows")) : undefined,
		{ cols: 80, rows: 24 },
	);
	const launchId = values.get("launch-id") ?? null;
	if (launchId !== null && !/^[A-Za-z0-9_-]{8,64}$/.test(launchId)) return "--launch-id is not a usable launcher id";
	const helperPath = values.get("helper");
	const helperDigest = values.get("helper-sha256");
	const noHelper = flags.has("no-helper");
	if (!noHelper && (helperPath === undefined || helperDigest === undefined)) {
		// A half-configured probe is refused rather than silently ignored: a broker
		// that quietly stops proving identity is exactly what this design must not do.
		return "--helper and --helper-sha256 are required unless --no-helper is given";
	}
	const helper =
		noHelper || helperPath === undefined || helperDigest === undefined
			? null
			: { path: helperPath, sha256: helperDigest };
	if (helper !== null && !isPtyDigest(helper.sha256)) return "--helper-sha256 must be a sha256 digest";
	const ownerHelperPath = values.get("owner-helper");
	const ownerHelperDigest = values.get("owner-helper-sha256");
	if ((ownerHelperPath === undefined) !== (ownerHelperDigest === undefined)) {
		// A half-configured owner helper is refused for the same reason a half-configured
		// probe is: a broker that quietly stops watching the owner is not acceptable.
		return "--owner-helper and --owner-helper-sha256 must be given together";
	}
	if (ownerHelperDigest !== undefined && !isPtyDigest(ownerHelperDigest)) {
		return "--owner-helper-sha256 must be a sha256 digest";
	}
	const ownerHelper =
		ownerHelperPath === undefined || ownerHelperDigest === undefined
			? null
			: { path: ownerHelperPath, sha256: ownerHelperDigest };
	const ownerHintValues = OWNER_HINT_FLAGS.map(flag => values.get(flag));
	if (ownerHintValues.some(value => value !== undefined) && ownerHintValues.some(value => value === undefined)) {
		return "--owner-host-pid, --owner-parent-pid and --owner-main-pid must be given together";
	}
	const ownerHint =
		ownerHintValues[0] === undefined
			? null
			: {
					extensionHostPid: Number(ownerHintValues[0]),
					parentPid: Number(ownerHintValues[1]),
					mainPid: Number(ownerHintValues[2]),
				};
	if (ownerHint !== null && !isPtyOwnerHint(ownerHint)) {
		return "the owner hint must be three positive process ids with the extension host distinct from the main process";
	}
	return {
		slot,
		kind,
		storageDir,
		brokerId: values.get("broker-id") ?? createPtyBrokerId(),
		generation: values.get("generation") ?? createPtyGeneration(),
		treeDigest,
		file,
		args: repeated.get("arg") ?? [],
		cwd,
		env,
		cols: size.cols,
		rows: size.rows,
		title: parsePtyTitle(values.get("title") ?? null),
		scrollbackLines: boundedInt(values.get("scrollback"), DEFAULT_SCROLLBACK_LINES, 50, 100_000),
		backlogChars: boundedInt(values.get("backlog"), DEFAULT_BACKLOG_CHARS, 64 * 1024, 64 * 1024 * 1024),
		snapshotChars: boundedInt(values.get("snapshot-chars"), PTY_MAX_SNAPSHOT_CHARS, 64 * 1024, 16 * 1024 * 1024),
		helper,
		ownerHelper,
		ownerHint,
		ownerGraceMs: boundedInt(
			values.get("owner-grace-ms"),
			PTY_DEFAULT_OWNER_GRACE_MS,
			PTY_OWNER_GRACE_RANGE.min,
			PTY_OWNER_GRACE_RANGE.max,
		),
		launchId,
		logPath: values.get("log") ?? null,
		exitRetentionMs: boundedInt(values.get("exit-retention-ms"), PTY_DEFAULT_EXIT_RETENTION_MS, 1_000, 24 * 3600_000),
	};
}

function boundedInt(raw: string | undefined, fallback: number, min: number, max: number): number {
	if (raw === undefined) return fallback;
	const value = Number(raw);
	if (!Number.isSafeInteger(value)) return fallback;
	return Math.min(Math.max(value, min), max);
}

/** One output chunk split into frame-sized pieces, each with its own position. */
function positionedChunks(chunk: PtyScreenChunk): Array<{ readonly fromPosition: number; readonly data: string }> {
	const parts = chunkPtyOutput(chunk.data);
	const positioned: Array<{ fromPosition: number; data: string }> = [];
	let offset = 0;
	for (const part of parts) {
		positioned.push({ fromPosition: chunk.fromPosition + offset, data: part });
		offset += part.length;
	}
	return positioned;
}

/**
 * One broker's whole lifetime.
 *
 * Every mutation of the child, the screen and the input owner happens in a socket
 * callback or a timer on this one thread, so a position read and the write that
 * follows it cannot interleave with another actor.
 */
export class PtyBroker {
	/** The pseudo-console screen; `null` for a `managed-rpc` broker, which never loads the screen model. */
	private screen: PtyScreenModel | null = null;
	private readonly notices: string[] = [];
	private readonly connections = new Set<PtyBrokerSideConnection>();
	private readonly attached = new Set<PtyBrokerSideConnection>();
	/** Connections that completed the handshake before the child existed. */
	private readonly pending: PtyBrokerSideConnection[] = [];
	private readonly startedAt = Date.now();
	private readonly done = Promise.withResolvers<number>();
	private server: PtyBrokerServer | null = null;
	private record: PtyBrokerRecord | null = null;
	private child: IPty | null = null;
	/** The pipe child of a `managed-rpc` broker; `null` for the pseudo-console kinds. */
	private rpc: RpcChild | null = null;
	private readonly ring = new RpcLineRing();
	/** Per attached connection: the cursor that delivers replay and live lines, paced on its queue. */
	private readonly subscribers = new Map<PtyBrokerSideConnection, RpcSubscriber>();
	/** Subscribers that still owe the client the child's exit `state` until their backlog is delivered. */
	private readonly exitBarrier = new Set<PtyBrokerSideConnection>();
	/** Per connection: the `rpc-write` line being assembled, and the write id refused so far. */
	private readonly rpcWrites = new Map<
		PtyBrokerSideConnection,
		{ readonly assembler: PtyRpcFragmentAssembler; rejected: string | null }
	>();
	private childExit: { readonly code: number; readonly signal: number } | null = null;
	private childExitedAtMs: number | null = null;
	private nativeCreationTime: string | null = null;
	private inputOwner: { readonly frontendId: string; readonly connection: PtyBrokerSideConnection } | null = null;
	private lastSoloAt: number | null = Date.now();
	/**
	 * Whether the child's process tree is unproven.
	 *
	 * It starts `true`: before anything is observed nothing has been proved, and this
	 * provider has no way to prove a tree gone later either — so a record whose child is
	 * simply gone keeps its recovery metadata instead of being retired on a timer.
	 */
	private treeUnproven = true;
	/**
	 * Whether a stop positively proved the exact child generation gone.
	 *
	 * Only a helper reading may set this — the kernel could no longer open the pid, or
	 * opened a *different* creation time for it — so it is absence evidence about the
	 * process this broker spawned, never a numeric-pid liveness guess. It exists because
	 * node-pty's Windows exit event can lag or never arrive: the shutdown gate accepts
	 * this proof where `childExit` is still `null` ([ADR-0029](../../docs/decisions/0029-report-uncontained-pty-tree-stop-as-unknown.md)).
	 */
	private childAbsenceProven = false;
	private retentionTimer: NodeJS.Timeout | null = null;
	private stopping: Promise<PtyStopResult> | null = null;
	/** Replies for accepted stops must be queued before another client retires the endpoint. */
	private stopRepliesQueued: Promise<void> | null = null;
	private exiting = false;

	private readonly options: BrokerOptions;
	/** The admitted owning-main set and its one authorized stop (ADR-0030). */
	private readonly ownerMonitor: PtyOwnerMonitor;
	private lastOwnerState: PtyOwnerStopStatus["state"] | null = null;

	constructor(options: BrokerOptions) {
		this.options = options;
		this.ownerMonitor = new PtyOwnerMonitor({
			kind: options.kind,
			brokerPid: process.pid,
			helper: options.ownerHelper,
			graceMs: options.ownerGraceMs,
			onStatusChanged: status => this.ownerStatusChanged(status),
			onAutoStop: reason => this.stopOwnedShell(reason),
			log: line => this.log(line),
		});
	}

	/**
	 * Bring the broker up and run until it decides to stop.
	 *
	 * The resolve value is this entry's exit code.
	 */
	async run(): Promise<number> {
		await this.log(`start pid=${process.pid} slot=${this.options.slot} kind=${this.options.kind} runtime=${PTY_RUNTIME_VERSION}`);
		const access = await ensurePtyStateAccess(this.options.storageDir).catch(error => ({
			ok: false,
			reason: messageOf(error),
		}));
		if (!access.ok) {
			await this.log(`refused: the broker state directory is not usable: ${access.reason ?? "unknown"}`);
			return PTY_BROKER_EXIT.storage;
		}
		const creation = await this.readOwnCreationTime();
		if (creation === null) {
			await this.log("refused: this process could not prove its own kernel creation time");
			return PTY_BROKER_EXIT.identityUnavailable;
		}
		const token = createPtyToken();
		let server: PtyBrokerServer;
		try {
			server = await startPtyBrokerServer({
				token,
				brokerId: this.options.brokerId,
				generation: this.options.generation,
				slot: this.options.slot,
				kind: this.options.kind,
				protocolVersion: PTY_PROTOCOL_VERSION,
				runtimeVersion: PTY_RUNTIME_VERSION,
				treeDigest: this.options.treeDigest,
				brokerPid: process.pid,
				brokerCreationTime: creation,
			});
		} catch (error) {
			await this.log(`refused: the broker socket could not be created (${messageOf(error)})`);
			return PTY_BROKER_EXIT.storage;
		}
		this.server = server;
		server.onConnection(connection => this.acceptConnection(connection));
		// The record carries the listening port, so the socket has to be bound before
		// the slot is claimed. Claiming comes before the child: a broker that lost the
		// race must not have started a second writer.
		const record: PtyBrokerRecord = {
			version: PTY_RECORD_VERSION,
			service: PTY_SERVICE,
			protocolVersion: PTY_PROTOCOL_VERSION,
			runtimeVersion: PTY_RUNTIME_VERSION,
			treeDigest: this.options.treeDigest,
			brokerId: this.options.brokerId,
			generation: this.options.generation,
			slot: this.options.slot,
			kind: this.options.kind,
			port: server.port,
			token,
			brokerPid: process.pid,
			brokerCreationTime: creation,
			startedAt: new Date().toISOString(),
			cols: this.options.cols,
			rows: this.options.rows,
			title: this.options.title,
		};
		const claim = await claimPtyRecord(this.options.storageDir, record, {
			...(this.options.launchId === null ? {} : { launchId: this.options.launchId }),
		});
		if (!claim.claimed) {
			await this.log(`refused: the slot is occupied (${claim.detail})`);
			await server.close();
			return PTY_BROKER_EXIT.slotOccupied;
		}
		this.record = record;
		await this.log(`claimed port=${server.port} broker=${this.options.brokerId}`);
		const failure = await this.spawnChild();
		if (failure !== null) {
			await this.log(`refused: ${failure}`);
			// No child ever existed, so there is no tree to keep recovery metadata about.
			await this.finish(`the PTY child could not be started`, PTY_BROKER_EXIT.spawnFailed, true);
			return await this.done.promise;
		}
		this.flushPending();
		// The owner watch is armed before any client exists, because the situation it
		// exists for is one where no client can: the extension host is gone. A hint the
		// launch carried is admitted here; a failure disarms and is reported in status.
		void this.ownerMonitor.start(this.options.ownerHint).catch(error => {
			void this.log(`owner watch start failed: ${messageOf(error)}`);
		});
		return await this.done.promise;
	}

	/** Spawn the child, or report why it could not be started. */
	private async spawnChild(): Promise<string | null> {
		const env = childEnvironment(process.env, this.options.env);
		return this.options.kind === "managed-rpc" ? await this.spawnRpcChild(env) : await this.spawnPtyChild(env);
	}

	/**
	 * The pipe child of a `managed-rpc` slot. Neither `node-pty` nor the screen model is
	 * loaded for it: `omp --mode rpc-ui` is JSONL, which a pseudo console would corrupt.
	 */
	private async spawnRpcChild(env: Record<string, string>): Promise<string | null> {
		try {
			this.rpc = await startRpcChild(
				{ file: this.options.file, args: this.options.args, cwd: this.options.cwd, env },
				{
					onLine: () => this.pumpAll(),
					onReady: (ready, rpcProtocol) => this.announceReady(ready, rpcProtocol),
					onStderr: text => this.forwardStderr(text),
					onExit: exit => this.noteChildExit(exit.code, exit.signal),
					log: line => void this.log(line),
				},
				this.ring,
			);
		} catch (error) {
			return `the rpc child could not be started: ${messageOf(error)}`;
		}
		void this.log(`rpc child pid=${this.rpc.pid} file=${this.options.file}`);
		void this.readChildIdentity(this.rpc.pid);
		return null;
	}

	private async spawnPtyChild(env: Record<string, string>): Promise<string | null> {
		let pty: typeof NodePty;
		let screenModule: typeof PtyScreenModule;
		try {
			// Loaded here and not at the top: a `managed-rpc` broker never loads node-pty or the screen model.
			[pty, screenModule] = await Promise.all([import("node-pty"), import("./pty-screen.ts")]);
		} catch (error) {
			return `the PTY runtime could not be loaded: ${messageOf(error)}`;
		}
		const screen = new screenModule.PtyScreenModel({
			cols: this.options.cols,
			rows: this.options.rows,
			scrollbackLines: this.options.scrollbackLines,
			backlogChars: this.options.backlogChars,
			snapshotChars: this.options.snapshotChars,
		});
		// Registered before any child exists: every byte the PTY produces is fed to
		// the screen and offered to the attached frontends from the same call.
		screen.onOutput(chunk => {
			for (const part of positionedChunks(chunk)) {
				this.sendToAttached({ v: PTY_PROTOCOL_VERSION, t: "output", fromPosition: part.fromPosition, data: part.data });
			}
		});
		this.screen = screen;
		let child: IPty;
		try {
			child = pty.spawn(this.options.file, [...this.options.args], {
				name: "xterm-256color",
				cols: this.options.cols,
				rows: this.options.rows,
				cwd: this.options.cwd,
				env,
				// The bundled ConPTY is the only backend measured working here; see the
				// module comment. On other platforms these options are ignored by
				// node-pty's Unix backend, which this design has not exercised.
				useConpty: process.platform === "win32",
				useConptyDll: process.platform === "win32",
				conptyInheritCursor: true,
			});
		} catch (error) {
			return `the PTY child could not be started: ${messageOf(error)}`;
		}
		this.child = child;
		child.onData(data => {
			screen.write(data);
		});
		child.onExit(event => this.noteChildExit(event.exitCode, event.signal ?? 0));
		void this.log(`child pid=${child.pid} file=${this.options.file}`);
		void this.readChildIdentity(child.pid);
		return null;
	}

	private noteChildExit(code: number, signal: number): void {
		this.childExit = { code, signal };
		this.childExitedAtMs = Date.now() - this.startedAt;
		this.notices.push(`the child exited with code ${code} after ${this.childExitedAtMs}ms`);
		// Nothing is left to stop automatically: the shell is already over.
		this.ownerMonitor.childHasExited();
		const state: PtyEventFrame = { v: PTY_PROTOCOL_VERSION, t: "state", status: this.status() };
		for (const connection of this.connections) {
			// An rpc consumer learns of the exit only after the lines it is still owed, so the
			// last frames of a turn are never overtaken by the news that the child is gone.
			if (this.subscribers.has(connection)) this.exitBarrier.add(connection);
			else connection.send(state);
		}
		this.pumpAll();
		this.scheduleRetention();
		void this.log(`child exited code=${code} signal=${signal}`);
	}

	/** Tell every attached rpc consumer that `ready` was seen and the protocol settled. */
	private announceReady(ready: string, rpcProtocol: 1 | 2): void {
		void this.log(`rpc ready, protocol ${rpcProtocol}`);
		for (const connection of this.subscribers.keys()) {
			connection.send({ v: PTY_PROTOCOL_VERSION, t: "rpc-ready", rpcProtocol, ready });
		}
	}

	/** Forward fresh stderr to attached consumers whose queue has room; the tail is read on attach. */
	private forwardStderr(text: string): void {
		for (const connection of this.subscribers.keys()) {
			if (connection.pendingBytes >= RPC_PACE_BYTES) continue;
			for (let start = 0; start < text.length; start += PTY_RPC_MAX_STDERR_CHARS) {
				connection.send({ v: PTY_PROTOCOL_VERSION, t: "rpc-stderr", data: text.slice(start, start + PTY_RPC_MAX_STDERR_CHARS) });
			}
		}
	}

	/** Pump every consumer, release transient lines all of them have passed, then flush exit barriers. */
	private pumpAll(): void {
		let minCursor = Number.MAX_SAFE_INTEGER;
		for (const [connection, subscriber] of this.subscribers) {
			const idle = subscriber.pump();
			minCursor = Math.min(minCursor, subscriber.cursor);
			if (idle) this.flushExitBarrier(connection, subscriber);
		}
		this.ring.dropTransientsThrough(minCursor);
	}

	private flushExitBarrier(connection: PtyBrokerSideConnection, subscriber: RpcSubscriber): void {
		if (!this.exitBarrier.has(connection) || !subscriber.idle) return;
		this.exitBarrier.delete(connection);
		connection.send({ v: PTY_PROTOCOL_VERSION, t: "state", status: this.status() });
	}

	/** One connection's socket drained: its paced backlog may continue. */
	private pumpConnection(connection: PtyBrokerSideConnection): void {
		const subscriber = this.subscribers.get(connection);
		if (subscriber === undefined) return;
		if (subscriber.pump()) this.flushExitBarrier(connection, subscriber);
	}

	private async readChildIdentity(pid: number): Promise<void> {
		const helper = this.options.helper;
		if (helper === null) {
			this.notices.push("no process probe was configured, so the native process identity is not proven");
			return;
		}
		const reading = await queryPtyProcessIdentity(helper, pid);
		if (reading.kind === "found") {
			this.nativeCreationTime = reading.creationTime;
			await this.log(`child identity pid=${pid} creation=${reading.creationTime}`);
			return;
		}
		this.notices.push(
			reading.kind === "gone"
				? "the native process was already gone when its identity was read"
				: `the native process identity could not be read: ${reading.detail}`,
		);
	}

	private async readOwnCreationTime(): Promise<string | null> {
		const helper = this.options.helper;
		if (helper === null) return null;
		const reading = await queryPtyProcessIdentity(helper, process.pid);
		return reading.kind === "found" ? reading.creationTime : null;
	}

	/** Everything a caller may rely on about this broker right now. */
	status(): PtyStatusPayload {
		const screen = this.screen;
		const pid = this.rpc?.pid ?? this.child?.pid;
		const dropped = this.rpc?.droppedLineCount ?? 0;
		return {
			state: this.childExit === null ? "running" : "exited",
			exitCode: this.childExit?.code ?? null,
			signal: this.childExit?.signal ?? null,
			// An rpc child has no screen: the record's geometry is reported and `alt` is false.
			cols: screen?.cols ?? this.options.cols,
			rows: screen?.rows ?? this.options.rows,
			alt: screen?.alt ?? false,
			title: screen?.title ?? this.options.title,
			// `0` is reported only in the impossible window before the child exists;
			// the broker does not accept requests until after the spawn.
			nativePid: typeof pid === "number" && pid > 0 ? pid : 0,
			nativeCreationTime: this.nativeCreationTime,
			brokerPid: process.pid,
			brokerCreationTime: this.record?.brokerCreationTime ?? null,
			clients: this.connections.size,
			inputOwner: this.inputOwner?.frontendId ?? null,
			uptimeMs: Date.now() - this.startedAt,
			noClientForMs: this.connections.size === 0 && this.lastSoloAt !== null ? Date.now() - this.lastSoloAt : null,
			childExitedAtMs: this.childExitedAtMs,
			// For an rpc child the "output position" is the newest line `seq`.
			outputPosition: screen?.position ?? this.ring.latestSeq,
			oldestPosition: screen?.oldestPosition ?? this.ring.oldestSeq(),
			notices: dropped === 0 ? [...this.notices] : [...this.notices, `${dropped} stdout line(s) above the bound were dropped`],
			ownerStop: this.ownerMonitor.status(),
		};
	}

	/**
	 * Broadcast every owner-watch transition to attached clients.
	 *
	 * A client that has already rendered "this shell is cleaned up when VS Code exits"
	 * must be able to learn that the answer changed, so the transition is pushed exactly
	 * as the status carries it — and a transition into a disarmed or finished state is
	 * also recorded as a notice, where a caller that never re-reads status still sees it.
	 */
	private ownerStatusChanged(status: PtyOwnerStopStatus): void {
		const previous = this.lastOwnerState;
		this.lastOwnerState = status.state;
		if (previous !== status.state) {
			// The monitor's detail is self-describing in every state, so it is recorded as it
			// stands rather than prefixed again here.
			if (status.state === "disarmed" || status.state === "stopped" || status.state === "grace") this.notices.push(status.detail);
		}
		this.broadcast({ v: PTY_PROTOCOL_VERSION, t: "owner-stop", id: 0, status });
	}

	private broadcast(body: PtyEventFrame): void {
		for (const connection of this.connections) connection.send(body);
	}

	private sendToAttached(body: PtyEventFrame): void {
		for (const connection of this.attached) connection.send(body);
	}

	private acceptConnection(connection: PtyBrokerSideConnection): void {
		if (this.child === null && this.rpc === null && !this.exiting) {
			// The handshake can finish while the child is still being spawned: hold the
			// connection instead of answering with a status that has no process yet.
			this.pending.push(connection);
			return;
		}
		this.adoptConnection(connection);
	}

	private flushPending(): void {
		for (const connection of this.pending.splice(0)) this.adoptConnection(connection);
	}

	private adoptConnection(connection: PtyBrokerSideConnection): void {
		this.connections.add(connection);
		this.lastSoloAt = null;
		if (this.retentionTimer !== null) {
			clearTimeout(this.retentionTimer);
			this.retentionTimer = null;
		}
		void this.log(`client connected (${this.connections.size} total)`);
		connection.onFrame(frame => this.handleFrame(connection, frame));
		connection.onDrain(() => this.pumpConnection(connection));
		connection.onClosed(reason => {
			this.connections.delete(connection);
			this.attached.delete(connection);
			this.subscribers.delete(connection);
			this.exitBarrier.delete(connection);
			this.rpcWrites.delete(connection);
			this.ring.setConsumers(this.subscribers.size);
			const index = this.pending.indexOf(connection);
			if (index >= 0) this.pending.splice(index, 1);
			if (this.inputOwner?.connection === connection) {
				const previous = this.inputOwner.frontendId;
				this.inputOwner = null;
				this.broadcast({ v: PTY_PROTOCOL_VERSION, t: "input-owner", id: 0, frontendId: null, previous });
			}
			if (this.connections.size === 0) {
				this.lastSoloAt = Date.now();
				this.scheduleRetention();
			}
			void this.log(`client closed: ${reason} (${this.connections.size} left)`);
		});
		// A client that attaches nothing still learns the truth about the child.
		connection.send({ v: PTY_PROTOCOL_VERSION, t: "state", status: this.status() });
	}

	/**
	 * A frame from a client.
	 *
	 * The transport has already refused an event type arriving from a client and any
	 * request whose fields are not the ones its type carries, so everything here is a
	 * well-formed request this broker serves.
	 */
	private handleFrame(connection: PtyBrokerSideConnection, frame: PtyClientFrame): void {
		if (this.exiting) return;
		void this.runRequest(connection, frame).catch(error => {
			connection.send({
				v: PTY_PROTOCOL_VERSION,
				t: "ack",
				id: frame.id,
				ok: false,
				code: "internal",
				detail: messageOf(error).slice(0, 512),
			});
		});
	}

	private async runRequest(connection: PtyBrokerSideConnection, frame: PtyClientFrame): Promise<void> {
		const refuse = (code: PtyRefusalCode, detail: string): void => {
			connection.send({ v: PTY_PROTOCOL_VERSION, t: "ack", id: frame.id, ok: false, code, detail });
		};
		const rpcKind = this.options.kind === "managed-rpc";
		if (rpcKind && isPtyTerminalOnlyRequest(frame.t)) {
			refuse("wrong-kind", "this broker serves an rpc child, not a terminal");
			return;
		}
		if (!rpcKind && isPtyRpcOnlyRequest(frame.t)) {
			refuse("wrong-kind", "this broker serves a terminal, not an rpc child");
			return;
		}
		switch (frame.t) {
			case "status":
				connection.send({ v: PTY_PROTOCOL_VERSION, t: "status", id: frame.id, status: this.status() });
				return;
			case "snapshot": {
				const snapshot = await this.requireScreen().snapshot();
				const chunks = chunkPtyOutput(snapshot.data);
				connection.send({
					v: PTY_PROTOCOL_VERSION,
					t: "snapshot",
					id: frame.id,
					meta: {
						position: snapshot.position,
						cols: snapshot.cols,
						rows: snapshot.rows,
						alt: snapshot.alt,
						title: snapshot.title,
						cursorX: snapshot.cursorX,
						cursorY: snapshot.cursorY,
						cursorVisible: snapshot.cursorVisible,
						chunks: chunks.length,
						chars: snapshot.chars,
						truncated: snapshot.truncated,
						encoding: "ansi",
					},
				});
				for (let index = 0; index < chunks.length; index += 1) {
					connection.send({ v: PTY_PROTOCOL_VERSION, t: "snapshot-data", id: frame.id, index, data: chunks[index] ?? "" });
				}
				return;
			}
			case "attach": {
				if (!Number.isSafeInteger(frame.sincePosition) || frame.sincePosition < 0) {
					refuse("malformed", "attach needs a non-negative output position");
					return;
				}
				// The replay is read, the connection is marked live and the frames are
				// queued in one synchronous step, so no output can slip between them.
				const replay = this.requireScreen().backlogSince(frame.sincePosition);
				this.attached.add(connection);
				connection.send({
					v: PTY_PROTOCOL_VERSION,
					t: "attached",
					id: frame.id,
					fromPosition: frame.sincePosition,
					oldestPosition: replay.oldestPosition,
					truncated: replay.truncated,
					status: this.status(),
				});
				for (const chunk of replay.chunks) {
					for (const part of positionedChunks(chunk)) {
						connection.send({ v: PTY_PROTOCOL_VERSION, t: "output", fromPosition: part.fromPosition, data: part.data });
					}
				}
				return;
			}
			case "input": {
				if (!isPtyFrontendId(frame.frontendId)) {
					refuse("malformed", "input needs a frontend id");
					return;
				}
				if (frame.data.length > 1024 * 1024) {
					refuse("frame-too-large", "one input frame carries at most 1 MiB of keystrokes");
					return;
				}
				const owner = this.inputOwner;
				if (owner === null) {
					refuse("no-input-owner", "no frontend holds input for this terminal");
					return;
				}
				if (owner.frontendId !== frame.frontendId) {
					refuse("input-not-owner", `input belongs to ${owner.frontendId}`);
					return;
				}
				if (this.child === null || this.childExit !== null) {
					refuse("child-exited", "the native process is not running");
					return;
				}
				this.child.write(frame.data);
				connection.send({ v: PTY_PROTOCOL_VERSION, t: "ack", id: frame.id, ok: true });
				return;
			}
			case "resize": {
				if (!isPtyFrontendId(frame.frontendId)) {
					refuse("malformed", "resize needs a frontend id");
					return;
				}
				const owner = this.inputOwner;
				if (owner === null || owner.frontendId !== frame.frontendId) {
					refuse(owner === null ? "no-input-owner" : "input-not-owner", "resize belongs to the input owner");
					return;
				}
				if (
					!Number.isSafeInteger(frame.cols) ||
					!Number.isSafeInteger(frame.rows) ||
					frame.cols < PTY_COLUMN_RANGE.min ||
					frame.cols > PTY_COLUMN_RANGE.max ||
					frame.rows < PTY_ROW_RANGE.min ||
					frame.rows > PTY_ROW_RANGE.max
				) {
					refuse(
						"invalid-size",
						`columns must be ${PTY_COLUMN_RANGE.min}..${PTY_COLUMN_RANGE.max} and rows ${PTY_ROW_RANGE.min}..${PTY_ROW_RANGE.max}`,
					);
					return;
				}
				// The screen model is resized first so the redraw this provokes is parsed
				// at the new geometry.
				this.requireScreen().resize(frame.cols, frame.rows);
				this.child?.resize(frame.cols, frame.rows);
				connection.send({ v: PTY_PROTOCOL_VERSION, t: "ack", id: frame.id, ok: true });
				return;
			}
			case "rpc-attach": {
				const rpc = this.rpc;
				if (rpc === null) {
					refuse("internal", "the rpc child does not exist");
					return;
				}
				// One cursor serves replay and live delivery, paced on this connection's queue.
				// It is created, marked live and answered in one synchronous step, so no line can
				// slip between the replay and the stream. Re-attaching on a live connection replaces
				// the cursor; the client resets its line assembly on the answer.
				const replay = this.ring.replay(frame.sinceSeq);
				const subscriber = new RpcSubscriber(this.ring, this.rpcSink(connection), replay.entries, this.ring.latestSeq);
				this.subscribers.set(connection, subscriber);
				this.exitBarrier.delete(connection);
				this.ring.setConsumers(this.subscribers.size);
				connection.send({
					v: PTY_PROTOCOL_VERSION,
					t: "rpc-attached",
					id: frame.id,
					fromSeq: replay.fromSeq,
					oldestSeq: this.ring.oldestSeq(),
					latestSeq: this.ring.latestSeq,
					truncated: replay.truncated,
					pinnedOverflow: this.ring.pinnedOverflow,
					rpcProtocol: rpc.rpcProtocol,
					ready: rpc.rpcProtocol === null ? null : rpc.readyLine,
					child: this.status(),
				});
				const tail = rpc.stderrTail();
				for (let start = 0; start < tail.length; start += PTY_RPC_MAX_STDERR_CHARS) {
					connection.send({ v: PTY_PROTOCOL_VERSION, t: "rpc-stderr", data: tail.slice(start, start + PTY_RPC_MAX_STDERR_CHARS) });
				}
				this.pumpConnection(connection);
				return;
			}
			case "rpc-write": {
				const writes = this.rpcWrites.get(connection) ?? {
					assembler: new PtyRpcFragmentAssembler(PTY_RPC_MAX_WRITE_BYTES),
					rejected: null,
				};
				this.rpcWrites.set(connection, writes);
				// The rest of a write that was already refused is dropped, not refused again.
				if (writes.rejected === frame.writeId) return;
				const reject = (code: PtyRefusalCode, detail: string): void => {
					writes.rejected = frame.writeId;
					writes.assembler.reset();
					refuse(code, detail);
				};
				const owner = this.inputOwner;
				if (owner === null || owner.frontendId !== frame.frontendId) {
					reject(owner === null ? "no-input-owner" : "input-not-owner", "stdin belongs to the input owner");
					return;
				}
				const rpc = this.rpc;
				if (rpc === null || this.childExit !== null) {
					reject("child-exited", "the rpc child is not running");
					return;
				}
				let line: Buffer | null;
				try {
					line = writes.assembler.push(frame.writeId, frame.index, frame.count, frame.data);
				} catch (error) {
					reject(
						error instanceof PtyRpcLineTooLongError ? "line-too-long" : "malformed",
						error instanceof Error ? error.message : "the write's fragments are malformed",
					);
					return;
				}
				// Interior fragments are not acknowledged: the last one settles the whole line.
				if (line === null) return;
				if (line.length === 0 || line.includes(0x0a) || line.includes(0x0d)) {
					reject("malformed", "a stdin line is one non-empty line of text");
					return;
				}
				try {
					await rpc.writeLine(line);
				} catch (error) {
					reject(error instanceof RpcChildWriteError ? error.code : "internal", "the line was not written to the child");
					return;
				}
				connection.send({ v: PTY_PROTOCOL_VERSION, t: "ack", id: frame.id, ok: true });
				return;
			}
			case "claim-input": {
				if (!isPtyFrontendId(frame.frontendId)) {
					refuse("malformed", "claim-input needs a frontend id");
					return;
				}
				const current = this.inputOwner;
				if (current !== null && current.frontendId !== frame.frontendId && !frame.takeover) {
					refuse("input-not-owner", `input is held by ${current.frontendId}; take it over explicitly`);
					return;
				}
				const previous = current?.frontendId ?? null;
				this.inputOwner = { frontendId: frame.frontendId, connection };
				this.broadcast({ v: PTY_PROTOCOL_VERSION, t: "input-owner", id: frame.id, frontendId: frame.frontendId, previous });
				return;
			}
			case "release-input": {
				if (!isPtyFrontendId(frame.frontendId)) {
					refuse("malformed", "release-input needs a frontend id");
					return;
				}
				const current = this.inputOwner;
				if (current === null || current.frontendId !== frame.frontendId) {
					refuse(current === null ? "no-input-owner" : "input-not-owner", "that frontend does not hold input");
					return;
				}
				this.inputOwner = null;
				this.broadcast({ v: PTY_PROTOCOL_VERSION, t: "input-owner", id: frame.id, frontendId: null, previous: frame.frontendId });
				return;
			}
			case "stop": {
				const mode: PtyStopMode = frame.mode === "force" ? "force" : "graceful";
				const timeoutMs = boundedInt(String(frame.timeoutMs), PTY_DEFAULT_STOP_TIMEOUT_MS, 1_000, 300_000);
				const earlierReplies = this.stopRepliesQueued;
				let replyQueued!: () => void;
				const queued = new Promise<void>(resolve => { replyQueued = resolve; });
				const barrier = earlierReplies === null ? queued : earlierReplies.then(() => queued);
				this.stopRepliesQueued = barrier;
				try {
					const result = await this.stopChild(mode, timeoutMs);
					connection.send({ v: PTY_PROTOCOL_VERSION, t: "stopped", id: frame.id, result });
				} catch (error) {
					// A failed stop also owes its accepted caller a reply before shutdown.
					refuse("internal", messageOf(error).slice(0, 512));
				} finally {
					replyQueued();
					await barrier;
					if (this.stopRepliesQueued === barrier) this.stopRepliesQueued = null;
				}
				return;
			}
			case "admit-owner": {
				// The transport has already narrowed the field to a hint or `null`, and this
				// connection is authenticated: a hint is a candidate to attest, while `null`
				// says the attaching frontend exists and cannot attest an owner, which
				// disarms automatic stopping instead of leaving a possible live owner
				// unwatched. Either way the request is answered with the resulting state,
				// which is also what the caller reads from status afterwards.
				const status =
					frame.owner === null
						? await this.ownerMonitor.admitUnattestable()
						: await this.ownerMonitor.admit(frame.owner);
				connection.send({ v: PTY_PROTOCOL_VERSION, t: "owner-stop", id: frame.id, status });
				return;
			}
			case "shutdown": {
				// Child exit can trigger another client's natural-retirement request while
				// an accepted stop is still collecting its verdict. Do not drop that reply.
				const acceptedStopReplies = this.stopRepliesQueued;
				if (acceptedStopReplies !== null) await acceptedStopReplies;
				// "Stopped" means the exit event arrived *or* a stop positively proved the
				// exact child generation gone. The second source exists because node-pty's
				// Windows exit event can lag or never arrive at all, while `waitForPtyProcessGone`
				// has already had the kernel confirm absence; a numeric-pid liveness reading is
				// never that proof, so a child that is merely unobserved still refuses.
				const childGone = this.childExit !== null || this.childAbsenceProven;
				if (frame.requireStopped && !childGone) {
					refuse("child-alive", "the native process is not proven gone; stop it before shutting the broker down");
					return;
				}
				connection.send({ v: PTY_PROTOCOL_VERSION, t: "shutdown-ok", id: frame.id, stopped: childGone });
				if (this.childExit === null && this.childAbsenceProven) {
					await this.log("shutdown: no exit event ever arrived, but a stop proved this exact child generation gone");
				}
				// Shutdown closes the endpoint but cannot prove the child tree is gone.
				// Keep the record as recovery metadata, just as on a signal.
				await this.finish("asked to shut down", PTY_BROKER_EXIT.ok, false);
				return;
			}
			default:
				// Unreachable while the request union is exhaustive; a request added to the
				// protocol without a handler lands here rather than being ignored.
				refuse("unknown-request", "the broker does not serve that request");
		}
	}

	/**
	 * Attempt to stop the child and report separately what was observed.
	 *
	 * Closing ConPTY can stop attached clients, but it cannot prove that escaped
	 * descendants are gone. Unverifiable tree absence remains `unknown`; `force`
	 * never signals a process by a potentially reused numeric PID.
	 */
	private async stopChild(mode: PtyStopMode, timeoutMs: number): Promise<PtyStopResult> {
		const existing = this.stopping;
		if (existing !== null) return await existing;
		const run = this.performStop(mode, timeoutMs);
		this.stopping = run;
		try {
			return await run;
		} finally {
			this.stopping = null;
		}
	}

	private async performStop(mode: PtyStopMode, timeoutMs: number): Promise<PtyStopResult> {
		const rpc = this.rpc;
		const child = this.child;
		if (child === null && rpc === null) {
			return {
				verified: false,
				mode,
				nativePid: 0,
				pidGone: true,
				tree: "unknown",
				treeEvidence: "unavailable",
				remainingPids: [],
				checkedPids: [],
				exitCode: null,
				detail: "this broker never started a child",
			};
		}
		const pid = rpc !== null ? rpc.pid : (child?.pid ?? 0);
		if (this.childExit === null) {
			try {
				// A pipe child is asked to leave by closing its stdin (OMP aborts a running turn,
				// persists it, appends `session_exit` and exits); only `force` terminates it, through
				// the handle Node retains for that exact process. A pseudo console is closed.
				if (rpc !== null) {
					if (mode === "force") rpc.kill();
					else rpc.closeStdin();
				} else {
					child?.kill();
				}
			} catch (error) {
				await this.log(`stop: ending the child failed (${messageOf(error)})`);
			}
		}
		if (mode === "force" && rpc === null) await this.escalateWithinHandles();
		const helper = this.options.helper;
		let pidGone = false;
		/**
		 * Positive absence evidence about the exact child generation. Only a helper
		 * reading sets it: `isPtyProcessAlive` answers about a numeric pid, which is not
		 * an identity, so the no-probe fallback below never proves anything.
		 */
		let absenceProven = false;
		let detail = "";
		if (helper === null) {
			pidGone = !isPtyProcessAlive(pid);
			detail = "no process probe is configured, so liveness was read without a creation-time check";
		} else {
			const gone = await waitForPtyProcessGone(helper, pid, this.nativeCreationTime, timeoutMs);
			pidGone = gone.gone;
			absenceProven = gone.gone;
			detail = gone.detail;
			if (!gone.gone && mode === "graceful" && rpc === null) {
				// A graceful stop that did not take effect is escalated once, within the
				// handles this broker holds, so a stuck child never leaves the caller without
				// a bounded next step — and no numeric process id is ever signalled.
				await this.escalateWithinHandles();
				const retry = await waitForPtyProcessGone(helper, pid, this.nativeCreationTime, timeoutMs);
				pidGone = retry.gone;
				absenceProven = retry.gone;
				detail = retry.detail;
			}
		}
		// The proof is about the process, not about its tree: it stands even when the
		// descendant read is unavailable, and it is what lets an explicit shutdown proceed
		// when the exit event itself never arrives.
		if (absenceProven) this.childAbsenceProven = true;
		// A live-table walk cannot prove a tree empty (see `PtyTreeEvidence`): this provider
		// has no kernel-enforced group, so the strongest honest answer is `unknown` with the
		// survivors it did see reported. The constant names that, so the verdict's meaning is
		// not encoded as a comparison that can never be true.
		const treeProvenEmpty = false;
		let tree: PtyTreeVerdict = "unknown";
		let checked: number[] = [];
		let treeEvidence: PtyTreeEvidence = "unavailable";
		if (helper === null) {
			detail = `${detail}; descendant evidence needs a process probe`;
		} else {
			const reading = await queryPtyProcessTree(helper, pid);
			if (reading.kind === "found") {
				checked = [...reading.pids];
				// A live-table walk only reaches a child whose parent link still leads back
				// to this pid: a descendant whose intermediary already exited is invisible to
				// it, so an empty answer is *not* proof of an empty tree and is never reported
				// as one. Survivors it did see are reported as such.
				tree = checked.length === 0 ? "unknown" : "remaining";
				treeEvidence = "parent-links-only";
				if (checked.length === 0) {
					detail = `${detail}; no live process names ${pid} as its parent, but a descendant whose intermediate parent already exited cannot be reached from a process-table snapshot and no kernel-enforced group is available through this PTY provider`;
				}
			} else {
				detail = `${detail}; the descendant read failed: ${reading.detail}`;
			}
		}
		this.treeUnproven = !treeProvenEmpty;
		if (this.treeUnproven) {
			this.notices.push(
				"the child's process tree could not be proven gone: this broker keeps its record and stays reachable until it is asked to shut down",
			);
		}
		const result: PtyStopResult = {
			// `verified` means the whole tree is proven gone. That needs kernel-enforced group
			// ownership at spawn time, which this PTY provider does not offer, so it is false
			// here by construction; `pidGone` is the part that is actually proven.
			verified: pidGone && treeProvenEmpty,
			mode,
			nativePid: pid,
			pidGone,
			tree,
			treeEvidence,
			remainingPids: checked,
			checkedPids: checked,
			exitCode: this.childExit?.code ?? null,
			detail,
		};
		await this.log(
			`stop mode=${mode} pid=${pid} verified=${result.verified} pidGone=${pidGone} tree=${tree} checked=${checked.length}`,
		);
		return result;
	}

	/**
	 * The only escalation this provider offers: closing the pseudo console again through
	 * node-pty's own retained handle.
	 *
	 * Nothing here signals a numeric process id. A numeric id is not an identity — the
	 * process it named may have exited and the id may now belong to an unrelated process —
	 * and node-pty exposes no process handle to verify one against, so a signal would be a
	 * guess that can terminate a stranger. When the console close does not end the child,
	 * this broker reports what it proved (`pidGone: false`, tree unknown) instead of
	 * escalating with something it cannot verify.
	 *
	 * The escalation is therefore a refusal with a reason, which is the honest answer: the
	 * caller learns that the stop did not take effect and that nothing further was tried.
	 */
	private async escalateWithinHandles(): Promise<void> {
		// A second `child.kill()` is not safe here: on an already-closed pseudo console it
		// can fail inside node-pty's own teardown, and a failed escalation must not take the
		// broker (and its record, and every other session it owns) down with it. The
		// provider has no verified handle-based termination left, so the escalation is
		// refused and the verdict reports what the readings actually showed.
		await this.log(
			"escalation refused: closing the pseudo console is the only termination this provider offers, and no process id is signalled",
		);
	}

	private requireScreen(): PtyScreenModel {
		if (this.screen === null) throw new Error("this broker has no pseudo-console screen");
		return this.screen;
	}

	/** One attached connection as the line ring's paced sink. */
	private rpcSink(connection: PtyBrokerSideConnection): RpcSink {
		return {
			get closed() {
				return connection.closed;
			},
			get pendingBytes() {
				return connection.pendingBytes;
			},
			sendFragment: (seq, index, count, data) => {
				connection.send({ v: PTY_PROTOCOL_VERSION, t: "rpc-line", lineSeq: seq, index, count, data });
			},
			close: reason => connection.close(reason),
		};
	}

	/**
	 * The one stop this broker performs on its own initiative
	 * ([ADR-0030](../../docs/decisions/0030-watch-the-verified-owning-vscode-process-for-shell-grace.md)).
	 *
	 * It is reachable only from the owner monitor, only for a folder shell, and only
	 * after every admitted owning VS Code main-process handle has positively signaled
	 * and the finite grace elapsed with nothing changing. It is the *same* stop an
	 * explicit caller gets: the pseudo console is closed through node-pty's own retained
	 * handle, no numeric process id is signalled, and an unproven descendant tree stays
	 * `unknown` with the slot's recovery record retained
	 * ([ADR-0029](../../docs/decisions/0029-report-uncontained-pty-tree-stop-as-unknown.md)).
	 * A managed OMP host can never get here: the monitor reports `not-applicable` for it
	 * and never arms.
	 */
	private async stopOwnedShell(reason: string): Promise<PtyStopResult> {
		this.notices.push(`${reason}; attempting this folder shell's stop (${PTY_OWNER_EXIT_REASON})`);
		await this.log(`automatic stop triggered: ${reason}`);
		const result = await this.stopChild("graceful", PTY_DEFAULT_STOP_TIMEOUT_MS);
		this.notices.push(
			`the automatic stop of the shell attempted after ${reason}: process ${result.pidGone ? "gone" : "still present"}, descendant tree ${result.tree}`,
		);
		return result;
	}

	/**
	 * Leave the broker available while a client may still reconnect.
	 *
	 * An exited child is retained for `--exit-retention-ms` so a window that was
	 * closed while the shell ran can still show its final screen and exit code; a live
	 * child is never abandoned by a timer.
	 */
	private scheduleRetention(): void {
		if (this.exiting || this.childExit === null || this.connections.size > 0 || this.retentionTimer !== null) return;
		if (this.treeUnproven) {
			// A record whose process tree could not be proven gone is not retired on a
			// timer: the shell slot has to stay recoverable, so only an explicit shutdown
			// may take it away.
			return;
		}
		this.retentionTimer = setTimeout(() => {
			this.retentionTimer = null;
			void this.finish("the retained child exited long ago and no client returned", PTY_BROKER_EXIT.ok, false);
		}, this.options.exitRetentionMs);
		this.retentionTimer.unref();
	}

	/**
	 * A termination signal: close this endpoint and leave, without touching the child.
	 *
	 * A signal is neither an explicit stop request nor evidence that a shell is finished:
	 * it says nothing about the child's process tree, and this broker is not authorized to
	 * end a session because someone asked its process to die. So nothing here calls the
	 * stop path — no `child.kill()`, no pseudo-console close — and the record is preserved
	 * as recovery metadata.
	 *
	 * What the child's fate is after this process exits is not something this code
	 * decides or claims: the pseudo console is held by handles this process owns, so the
	 * operating system may end the child's session when those handles go away. That is an
	 * unavoidable consequence of process death, not an authorized stop, and it is reported
	 * as such — the log says the child was not intentionally stopped, so nothing later can
	 * read this exit as a confirmed stop.
	 */
	async stopAndExitFromSignal(signal: string): Promise<void> {
		await this.log(
			this.child === null
				? `signal ${signal}: no child was ever started, so nothing is stopped`
				: `signal ${signal}: the child is NOT intentionally stopped by this broker (a signal is not an authorized stop); its record is preserved`,
		);
		await this.finish(`signal ${signal}`, PTY_BROKER_EXIT.ok, false);
	}

	/**
	 * Close this broker's endpoint, and retire its record only when there is nothing left
	 * to remember.
	 *
	 * `retire` is true for exactly one case: a child that was never spawned, so no process
	 * and no tree ever existed to keep recovery metadata about. Every other path — an
	 * explicit shutdown, a signal, the retention timer — leaves the record in place, even
	 * though this broker is leaving: the record is how a later window learns which slot was
	 * held, by which broker, and that its outcome is uncertain. Broker absence
	 * alone never retires an unknown record or frees its slot.
	 */
	private async finish(reason: string, code: number, retire: boolean): Promise<void> {
		if (this.exiting) {
			await this.done.promise;
			return;
		}
		this.exiting = true;
		await this.log(`exiting: ${reason}`);
		if (this.record !== null && retire) {
			await retirePtyRecord(this.options.storageDir, this.options.slot, this.options.brokerId).catch(() => undefined);
			this.record = null;
		} else if (this.record !== null) {
			// The record is the only recovery metadata a later window has: which slot
			// is held, by which broker, on which port. Broker absence does not free it.
			await this.log("the record is retained as recovery metadata");
		}
		if (this.retentionTimer !== null) {
			clearTimeout(this.retentionTimer);
			this.retentionTimer = null;
		}
		// The helper holds handles on other processes; it must not outlive this broker.
		await this.ownerMonitor.close().catch(() => undefined);
		for (const connection of this.pending.splice(0)) connection.close("the broker is shutting down");
		this.screen?.dispose();
		await this.server?.close().catch(() => undefined);
		this.done.resolve(code);
		await this.log("stopped");
		await this.done.promise;
	}

	private async log(line: string): Promise<void> {
		const path = this.options.logPath;
		if (path === null) return;
		try {
			await mkdir(dirname(path), { recursive: true });
			await appendFile(path, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 });
		} catch {
			// A log that cannot be written is not a reason to stop owning a terminal.
		}
	}
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Prove this runtime, from inside it.
 *
 * Asked for with `--self-check` (which `src/host/pty-runtime.ts` runs once per staged
 * tree before it enables the PTY surface). It reports one JSON line and never starts
 * an OMP session: the point is to load the native addon, load the bundled
 * `conpty.dll`/`OpenConsole.exe` beside it, and run a real child through a real
 * pseudo console — one that prints its own proof through that console and exits. A
 * tree whose ABI does not match this runtime, or whose ConPTY backend cannot start a
 * child or carry its output, fails here — before a user's session does.
 *
 * The proof is the child's own markers plus the backend's exit report, not the exit
 * code (`src/broker/pty-self-check.ts` explains why: the Windows ConPTY backend does
 * not always report one). The child is a plain console client rather than this
 * runtime's own executable, for the measurement `selfCheckChild` records.
 */
async function runSelfCheck(): Promise<number> {
	const started = Date.now();
	const plan = selfCheckPlan(randomBytes(8).toString("hex"));
	const childCommand = selfCheckChild({
		plan,
		tools: selfCheckTools(process.platform, process.env),
		execPath: process.execPath,
	});
	const report: Record<string, unknown> = {
		runtimeVersion: PTY_RUNTIME_VERSION,
		platform: process.platform,
		arch: process.arch,
		node: process.versions.node,
		electron: process.versions.electron ?? null,
		conptyDll: process.platform === "win32",
		nodePty: null,
		childPid: 0,
		childExitCode: null,
		childOutput: false,
		durationMs: 0,
	};
	report.pipeChild = false;
	try {
		// Loaded here and not at the top: a `managed-rpc` broker must never load node-pty.
		const pty = await import("node-pty");
		if (typeof pty.spawn !== "function") throw new Error("the staged node-pty package exposes no spawn");
		report.nodePty = "spawn-available";
		const child = pty.spawn(childCommand.file, [...childCommand.args], {
			name: "xterm-256color",
			cols: 40,
			rows: 10,
			cwd: process.cwd(),
			env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
			useConpty: process.platform === "win32",
			useConptyDll: process.platform === "win32",
		});
		report.childPid = child.pid;
		// The child's own markers are half of the proof, so the data path is read while
		// the child runs and bounded so a noisy child cannot grow this answer.
		let output = "";
		let exitReported = false;
		let exitCode: number | undefined;
		const proof = Promise.withResolvers<void>();
		const seen = (): void => {
			if (exitReported && output.includes(plan.markers.start) && output.includes(plan.markers.end)) proof.resolve();
		};
		child.onData(data => {
			if (output.length >= SELF_CHECK_OUTPUT_LIMIT) return;
			output += data;
			seen();
		});
		child.onExit(event => {
			exitReported = true;
			exitCode = event.exitCode;
			seen();
		});
		// One deadline covers both halves: this backend's first flush of child output was
		// measured about three seconds after the spawn and its exit report can arrive
		// before that flush, so nothing here samples a moment after the exit. A child that
		// never reports its exit, or never prints its markers, reaches this bound.
		const deadline = setTimeout(proof.resolve, SELF_CHECK_DEADLINE_MS);
		await proof.promise;
		clearTimeout(deadline);
		// Whatever the verdict is, the answer carries what this backend actually reported:
		// a refusal that says only "it did not prove itself" is harder to act on than one
		// that also names the exit code the backend gave.
		report.childExitCode = exitCode ?? null;
		if (!exitReported) throw new Error("the self-check child did not report its exit within the self-check deadline");
		const verdict = selfCheckVerdict({ output, markers: plan.markers, exitCode });
		if (!verdict.ok) throw new Error(verdict.detail);
		report.childOutput = true;
		await proveRpcPipeChild();
		report.pipeChild = true;
	} catch (error) {
		report.ok = false;
		report.detail = messageOf(error);
		report.durationMs = Date.now() - started;
		process.stdout.write(`${JSON.stringify(report)}\n`);
		return PTY_BROKER_EXIT.selfCheckFailed;
	}
	report.ok = true;
	report.durationMs = Date.now() - started;
	process.stdout.write(`${JSON.stringify(report)}\n`);
	return PTY_BROKER_EXIT.ok;
}

/**
 * The pipe-child case of the self-check
 * ([ADR-0032](../../docs/decisions/0032-prove-the-pty-runtime-with-a-console-child.md)).
 *
 * A `managed-rpc` slot runs its child on plain pipes, so the staged tree also has to prove
 * that: the broker entry itself is started as an echo child (`--pipe-echo`) with stdin,
 * stdout and stderr on pipes, one JSONL line is written to it, the same line must come
 * back, and closing stdin must end the child. It uses the entry that is already staged,
 * so the staged tree gains no file — a changed tree would be gated at attach by its
 * runtime version, which is deliberately not bumped for this kind.
 */
async function proveRpcPipeChild(): Promise<void> {
	const entry = process.argv[1];
	if (entry === undefined) throw new Error("the broker entry is unknown, so the pipe child cannot be started");
	const line = JSON.stringify({ type: "pipe-check", token: randomBytes(8).toString("hex") });
	const child = spawn(process.execPath, [entry, "--pipe-echo"], {
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
		env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
	});
	const outcome = Promise.withResolvers<void>();
	let echoed = "";
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		echoed += chunk;
		if (echoed.includes("\n")) child.stdin.end();
	});
	child.once("error", error => outcome.reject(error));
	child.once("close", code => {
		if (echoed.trim() !== line) outcome.reject(new Error("the pipe child did not echo the line it was given"));
		else if (code !== 0) outcome.reject(new Error(`the pipe child did not exit cleanly after its stdin closed (${String(code)})`));
		else outcome.resolve();
	});
	child.stdin.on("error", () => undefined);
	child.stdin.write(`${line}\n`);
	const deadline = setTimeout(() => {
		child.kill();
		outcome.reject(new Error("the pipe child did not finish within the self-check deadline"));
	}, SELF_CHECK_DEADLINE_MS);
	try {
		await outcome.promise;
	} finally {
		clearTimeout(deadline);
	}
}

/** The echo child the self-check's pipe case starts: every stdin line is written back until stdin ends. */
async function runPipeEcho(): Promise<number> {
	process.stdin.setEncoding("utf8");
	let buffer = "";
	for await (const chunk of process.stdin) {
		buffer += chunk;
		for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
			process.stdout.write(buffer.slice(0, newline + 1));
			buffer = buffer.slice(newline + 1);
		}
	}
	return PTY_BROKER_EXIT.ok;
}

async function main(): Promise<number> {
	if (process.argv.slice(2).includes("--self-check")) return await runSelfCheck();
	if (process.argv.slice(2).includes("--pipe-echo")) return await runPipeEcho();
	const parsed = parsePtyBrokerArgs(process.argv.slice(2));
	if (typeof parsed === "string") {
		process.stderr.write(`pty-broker: ${parsed}\n`);
		return PTY_BROKER_EXIT.arguments;
	}
	const broker = new PtyBroker(parsed);
	for (const signal of ["SIGTERM", "SIGINT"] as const) {
		process.on(signal, () => {
			void broker.stopAndExitFromSignal(signal);
		});
	}
	return await broker.run();
}

// Only start when this file is the entry point: tests import `PtyBroker` directly.
if (process.argv[1] !== undefined && /[\\/]pty-broker\.(js|ts)$/.test(process.argv[1])) {
	void main().then(code => {
		// node-pty holds its own resources open — a pseudoconsole, a worker thread, its
		// sockets — so a broker that has finished would otherwise keep running with
		// nothing left to serve. The exit is explicit, after a bounded flush window.
		process.exitCode = code;
		const timer = setTimeout(() => process.exit(code), 250);
		timer.unref();
	});
}

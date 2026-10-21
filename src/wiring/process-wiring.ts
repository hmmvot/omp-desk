/**
 * The Sessions view's connection to the background processes of this profile.
 *
 * Everything policy-bearing lives in `broker-processes.ts`, `broker-process-stop.ts` and
 * `broker-process-controller.ts`; this module only builds their ports from the extension's
 * own state, owns the one serialized reader behind every read and its visible-only poll, and
 * registers the commands. It reads session rows, broker-slot mappings and shell slots, and stops
 * only through those modules or through the row stop flows the caller hands in; it never signals a
 * process id. The Sessions provider receives every snapshot through `publish`.
 */

import * as vscode from "vscode";
import { brokerStopAttachFor, stopBrokerThroughBroker } from "../host/broker-process-stop.ts";
import type { BrokerStopPorts, BrokerStopTarget, BrokerStopOutcome } from "../host/broker-process-stop.ts";
import { killAll, stopOrphanedAndIdle, stopProcess, stopRowsOnRequest } from "../host/broker-process-controller.ts";
import type { CapturedRowStop, ProcessControllerPorts, StopCaptureOptions } from "../host/broker-process-controller.ts";
import { createBrokerRecordLister } from "../host/broker-process-records.ts";
import { buildBrokerProcessCatalog, createBrokerProcessReader, sessionRowWindow } from "../host/broker-processes.ts";
import type {
	BrokerCatalogRow,
	BrokerCatalogShell,
	BrokerCatalogSources,
	BrokerLocalRuntime,
	BrokerProcessChild,
	BrokerProcessReader,
	BrokerProcessReadOptions,
	BrokerProcessRow,
	BrokerProcessSnapshot,
	BrokerRecordFacts,
	RowIdentity,
} from "../host/broker-processes.ts";
import type { PeerRowAnswer, StopRowAnswer } from "../host/window-requests.ts";
import type { BrokerSlotStore } from "../host/broker-slots.ts";
import { isPtyProcessAlive, queryPtyProcessIdentity, waitForPtyProcessGone } from "../host/pty-identity.ts";
import { identifyPeerExecutor, proveExecutorGone } from "../host/peer-executor.ts";
import type { PeerExecutorProbe } from "../host/peer-executor.ts";
import type { PtyBrokerClient } from "../host/pty-client.ts";
import type { Logger } from "../shared/logger.ts";
import type { ShellSlotStore } from "../host/shell-slots.ts";
import { ProcessTreeItem } from "../views/process-rows";
import type { SessionsGrouping } from "../views/session-order";

/** How often a visible Sessions view in the Terminals layout re-reads the cheap facts. A hidden view does nothing. */
export const TERMINALS_POLL_MS = 5_000;
/** How often a visible Sessions view in another layout re-reads them: only the row marks and the Terminals group depend on it. */
export const SESSIONS_POLL_MS = 30_000;
/** How long after a launcher refresh a visible view reads again, so a row that just started or stopped shows its process. */
export const LAUNCHER_REFRESH_DELAY_MS = 2_000;

/** The session index's facts about one row that matter to slot classification. */
export interface ProcessWiringSessionRow {
	readonly tabId: string;
	readonly title: string;
	readonly folder: string;
	/** Slot of the row's recorded host (its rpc slot, or its broker-slot mapping), or `null` when it records none. */
	readonly hostSlot: string | null;
	readonly open: boolean;
	readonly running: boolean;
	readonly heldElsewhere: boolean;
}

export interface ProcessWiringDeps {
	readonly storageDir: string;
	readonly predecessorStorageDir: string;
	/** The broker client, or `null` when brokers are unavailable in this window. */
	client(): Promise<PtyBrokerClient | null>;
	sessionRows(): readonly ProcessWiringSessionRow[];
	brokerSlots(): BrokerSlotStore | undefined;
	shellSlots(): ShellSlotStore | undefined;
	/** An editor of this window carries the folder shell. */
	shellOpenHere(slot: string): boolean;
	/** Every runtime this window holds, by exact broker identity, whether or not a session row exists for it. */
	localRuntimes(): readonly BrokerLocalRuntime[];
	/** `null` when the session index loaded cleanly. */
	indexLoadError(): string | null;
	/** The profile catalog has been read in this window. */
	catalogLoaded(): boolean;
	/**
	 * `null` once the window's startup restore is over, otherwise a promise that settles when it is. The background
	 * reads of the list (its poll, a visibility read, the read after a launcher refresh) wait for it: they read process
	 * identities and the catalog, which would compete with the restore. An explicit action
	 * (Refresh, Stop, Kill All) never waits.
	 */
	startupRestoreOver(): Promise<void> | null;
	/** Re-read the shared catalog (index, broker slots, shell slots, folders). */
	refreshCatalog(): Promise<void>;
	refreshLauncher(): void;
	captureDrivenStop(row: BrokerProcessRow, options: StopCaptureOptions): Promise<CapturedRowStop | null>;
	captureRecordedStop(row: BrokerProcessRow, options: StopCaptureOptions): Promise<CapturedRowStop | null>;
	/** Hold the owning shell lifecycle for the whole authenticated stop/shutdown sequence. */
	runBrokerStop(target: BrokerStopTarget, operation: () => Promise<BrokerStopOutcome>): Promise<BrokerStopOutcome>;
	log: Logger;
}

/** Another live window as the window registry names it, with the extension host that serves its requests. */
export interface WindowPeer {
	readonly holderId: string;
	readonly label: string;
	/** The host's process id from the window's live registry record, or `null` when it names none. */
	readonly hostPid: number | null;
}

export interface SessionProcessesDeps extends ProcessWiringDeps {
	/** Serve a snapshot to the Sessions view. */
	publish(snapshot: BrokerProcessSnapshot): void;
	/** The Sessions view is on screen. A hidden view is never polled; an explicit action always reads. */
	visible(): boolean;
	layout(): SessionsGrouping;
	/** The other live windows of this profile, from the window registry read now. Rejects when the registry could not be read: that is not "no other window". */
	peers(): Promise<readonly WindowPeer[]>;
	/** Ask a window to stop the rows it runs among `rows` through its own lifecycle, one answer per row. Never throws. */
	askWindowToStop(holderId: string, rows: readonly RowIdentity[]): Promise<readonly PeerRowAnswer[]>;
	/** This window as the log names it (workspace name and holder id prefix), so an explicit stop is attributable to the window that asked. */
	requester(): string;
}

/** What the extension calls into the registered processes: view or layout changes and launcher refreshes. */
export interface SessionProcesses {
	/** The view's visibility or the layout changed: reschedule the poll, and read now when the view is shown. */
	sync(): void;
	/** The launcher was refreshed: read once more shortly, when the view is shown. */
	touch(): void;
	/** An explicit fresh read. */
	refresh(): Promise<BrokerProcessSnapshot>;
	/**
	 * Serve another window's Kill All: stop, through this window's own lifecycle, the rows among `identities` that this
	 * window provably runs, and answer per row in order. Never offers a Force Stop on the requester's behalf.
	 */
	serveStopRequest(identities: readonly RowIdentity[], progress: (done: number) => Promise<void>): Promise<readonly StopRowAnswer[]>;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Session rows and slot tables as the model's catalog sources. */
export function catalogSourcesFrom(deps: ProcessWiringDeps): BrokerCatalogSources {
	const rows: BrokerCatalogRow[] = deps.sessionRows().map(row => ({
		tabId: row.tabId,
		title: row.title,
		folder: row.folder,
		hostSlot: row.hostSlot,
		window: sessionRowWindow(row),
	}));
	const brokerRefs = deps.brokerSlots()?.references() ?? null;
	const shellRefs = deps.shellSlots()?.references() ?? null;
	const byConversation = new Map<string, string>();
	for (const [tabId, slot] of Object.entries(brokerRefs?.byConversation ?? {})) byConversation.set(slot, tabId);
	const shells: BrokerCatalogShell[] = (shellRefs?.records ?? []).map(record => ({
		slot: record.slot,
		folder: record.cwd,
		label: record.label,
		window: deps.shellOpenHere(record.slot) ? "this-window" : record.detachedAt === null ? "other-window" : "none",
		generation: record.lastGeneration,
	}));
	return {
		ready: deps.catalogLoaded(),
		rows,
		byConversation,
		byEditor: new Set(Object.values(brokerRefs?.byEditor ?? {})),
		localRuntimes: deps.localRuntimes(),
		brokerSlotsComplete: brokerRefs !== null && brokerRefs.complete && deps.indexLoadError() === null,
		shells,
		shellSlotsComplete: shellRefs !== null && shellRefs.complete,
	};
}

/** One read-only, owner-hint-free attach to learn whether the broker's child still runs. */
async function readChildState(client: PtyBrokerClient, facts: BrokerRecordFacts): Promise<BrokerProcessChild> {
	try {
		const lookup = await client.readRecord(facts.slot);
		if (lookup.kind !== "ok" || lookup.record.brokerId !== facts.brokerId || lookup.record.generation !== facts.generation) {
			return "unknown";
		}
		const outcome =
			lookup.record.kind === "managed-rpc"
				? await client.attachRpcRecord(lookup.record, { adopted: true })
				: await client.attachRecord(lookup.record, { adopted: true });
		const handle = outcome.handle;
		if (handle === null) return "unknown";
		try {
			if (handle.record.brokerId !== facts.brokerId || handle.record.generation !== facts.generation) return "unknown";
			return handle.state === "running" ? "running" : handle.state === "exited" ? "exited" : "unknown";
		} finally {
			handle.disconnect();
		}
	} catch {
		return "unknown";
	}
}

export function createBrokerProcessReaderFor(deps: ProcessWiringDeps): BrokerProcessReader {
	const list = createBrokerRecordLister({ storageDir: deps.storageDir, predecessorStorageDir: deps.predecessorStorageDir });
	return createBrokerProcessReader({
		listRecords: list,
		async catalog(fresh) {
			if (fresh) await deps.refreshCatalog().catch(error => deps.log.warn(`processes: the catalog could not be refreshed: ${messageOf(error)}`));
			return buildBrokerProcessCatalog(catalogSourcesFrom(deps));
		},
		isAlive: isPtyProcessAlive,
		readCreationTime: queryPtyProcessIdentity,
		async readChild(facts) {
			const client = await deps.client();
			return client === null ? "unknown" : await readChildState(client, facts);
		},
		async buildDigest() {
			const client = await deps.client();
			return client === null ? null : (await client.attachIdentity()).treeDigest;
		},
		now: Date.now,
	});
}

/** Own the reader, its poll and the commands of the processes the Sessions view lists. */
export function registerSessionProcesses(context: vscode.ExtensionContext, deps: SessionProcessesDeps): SessionProcesses {
	const reader = createBrokerProcessReaderFor(deps);
	let disposed = false;
	let loaded = false;
	let chain: Promise<unknown> = Promise.resolve();
	let pollTimer: NodeJS.Timeout | undefined;
	let touchTimer: NodeJS.Timeout | undefined;
	let tickQueued = false;

	/**
	 * The one owner of the reader: every read, the poll's and every controller's, runs one after
	 * another, and every answer is served to the view, so the list never shows an older read than the
	 * one an action just made.
	 */
	const read = (options?: BrokerProcessReadOptions): Promise<BrokerProcessSnapshot> => {
		const run = chain.then(async () => {
			const snapshot = await reader.read(options);
			if (!disposed) {
				deps.publish(snapshot);
				if (!loaded) {
					loaded = true;
					void vscode.commands.executeCommand("setContext", "ompDesk.processesLoaded", true);
				}
			}
			return snapshot;
		});
		chain = run.catch(() => undefined);
		return run;
	};

	/** Background read: the cheap facts, and the child state of a row that has none yet. Never for a hidden view, never during the startup restore. */
	const tick = async (): Promise<void> => {
		if (disposed || tickQueued || !deps.visible()) return;
		tickQueued = true;
		try {
			await deps.startupRestoreOver();
			if (disposed || !deps.visible()) return;
			await read({ fresh: false, unreadChildren: true });
		} catch (error) {
			deps.log.warn(`processes: the list could not be read: ${messageOf(error)}`);
		} finally {
			tickQueued = false;
		}
	};

	/** A read the view asked for by being shown: it waits for the startup restore like the poll and re-checks the view afterwards. */
	const backgroundRead = async (options: BrokerProcessReadOptions): Promise<void> => {
		try {
			await deps.startupRestoreOver();
			if (disposed || !deps.visible()) return;
			await read(options);
		} catch (error) {
			deps.log.warn(`processes: the list could not be read: ${messageOf(error)}`);
		}
	};

	const schedule = (): void => {
		clearTimeout(pollTimer);
		pollTimer = undefined;
		if (disposed || !deps.visible()) return;
		pollTimer = setTimeout(() => {
			pollTimer = undefined;
			void tick().finally(schedule);
		}, deps.layout() === "terminals" ? TERMINALS_POLL_MS : SESSIONS_POLL_MS);
	};

	const confirm: ProcessControllerPorts["confirm"] = async request =>
		(await vscode.window.showWarningMessage(request.message, { modal: true, detail: request.detail }, request.label)) === request.label;

	const stopPorts: BrokerStopPorts = {
		log: deps.log,
		async attach(target) {
			const client = await deps.client();
			if (client === null) return { ok: false, reason: "Background process support is unavailable. Reload the window and try Stop again." };
			return await brokerStopAttachFor(client, deps.log)(target);
		},
		waitBrokerGone: (target, timeoutMs) => waitForPtyProcessGone(target.brokerPid, target.brokerCreationTime, timeoutMs),
	};
	/** The kernel probes behind a peer's executor identity. */
	const peerProbe: PeerExecutorProbe = { read: queryPtyProcessIdentity, waitGone: waitForPtyProcessGone };

	const controllerPorts: ProcessControllerPorts = {
		read,
		confirm,
		async choose(request) {
			const picked = await vscode.window.showWarningMessage(
				request.message,
				{ modal: true, detail: request.detail },
				...request.options.map(option => option.label),
			);
			return request.options.find(option => option.label === picked)?.id ?? null;
		},
		async withProgress(title, work) {
			await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `OMP Desk: ${title}` }, work);
		},
		info: message => void vscode.window.showInformationMessage(`OMP Desk: ${message}`),
		log: message => deps.log.info(message),
		warn: message => void vscode.window.showWarningMessage(`OMP Desk: ${message}`),
		captureDrivenStop: (row, options) => deps.captureDrivenStop(row, options),
		captureRecordedStop: (row, options) => deps.captureRecordedStop(row, options),
		stopThroughBroker: (target, mode) => deps.runBrokerStop(target, () => stopBrokerThroughBroker(target, mode, stopPorts)),
		async forgetStoppedSlot(slot) {
			const shells = deps.shellSlots();
			if (shells?.get(slot) != null) await shells.remove(slot);
			await deps.brokerSlots()?.forget(slot);
		},
		waitBrokerGone: (target, timeoutMs) => stopPorts.waitBrokerGone(target, timeoutMs),
		async peers() {
			const windows = await deps.peers();
			return await Promise.all(windows.map(async window => ({ holderId: window.holderId, label: window.label, executor: await identifyPeerExecutor(window.hostPid, peerProbe) })));
		},
		async peerExecutorGone(peer) {
			return await proveExecutorGone(peer, peerProbe);
		},
		askWindowToStop: (holderId, rows) => deps.askWindowToStop(holderId, rows),
		async refresh() {
			deps.refreshLauncher();
			await read({ fresh: true }).catch(error => deps.log.warn(`processes: the list could not be read: ${messageOf(error)}`));
		},
	};

	const rowIdOf = (argument: unknown): string | null => {
		if (argument instanceof ProcessTreeItem) return argument.row.id;
		if (typeof argument === "string" && argument.length > 0) return argument;
		return null;
	};

	context.subscriptions.push(
		{
			dispose: () => {
				disposed = true;
				clearTimeout(pollTimer);
				clearTimeout(touchTimer);
			},
		},
		vscode.commands.registerCommand("ompDesk.refreshProcesses", () => read({ fresh: true }).catch(error => deps.log.error(`processes: the list could not be read: ${messageOf(error)}`))),
		vscode.commands.registerCommand("ompDesk.stopProcess", async (argument: unknown) => {
			const id = rowIdOf(argument);
			if (id === null) {
				void vscode.window.showWarningMessage("OMP Desk: Select a process in the Sessions view to stop.");
				return;
			}
			deps.log.info(`processes: Stop asked for process row ${id} from the Processes view of ${deps.requester()}`);
			await stopProcess(id, controllerPorts);
		}),
		vscode.commands.registerCommand("ompDesk.stopOrphanedProcesses", () => {
			deps.log.info(`processes: Stop Orphaned and Idle asked from the Processes view of ${deps.requester()}`);
			return stopOrphanedAndIdle(controllerPorts);
		}),
		vscode.commands.registerCommand("ompDesk.killAll", () => {
			deps.log.info(`processes: Kill All asked from the Processes view of ${deps.requester()}`);
			return killAll(controllerPorts);
		}),
	);

	return {
		sync() {
			schedule();
			if (!disposed && deps.visible()) void backgroundRead({ fresh: true });
		},
		touch() {
			if (disposed || touchTimer !== undefined || !deps.visible()) return;
			touchTimer = setTimeout(() => {
				touchTimer = undefined;
				void tick();
			}, LAUNCHER_REFRESH_DELAY_MS);
		},
		refresh: () => read({ fresh: true }),
		async serveStopRequest(identities, progress) {
			const answers = await stopRowsOnRequest(identities, controllerPorts, progress);
			// One line per row: which row another window's Kill All asked this window to stop, and what became of it (the `stop request` line before this names the window).
			for (const [position, identity] of identities.entries()) {
				const answer = answers[position];
				deps.log.info(`processes: another window's Kill All asked for ${identity.ptyKind} ${identity.slot}${identity.tabId === null ? "" : ` (conversation ${identity.tabId})`}: ${answer?.state ?? "no answer"}${answer === undefined || answer.reason === "" ? "" : ` (${answer.reason})`}`);
			}
			// The requester is another window of this profile: this window says what it did on its behalf, so a stop it did not start is never silent.
			const acted = answers.filter(answer => answer.state === "stopped" || answer.state === "unconfirmed");
			if (acted.length > 0) {
				const stopped = acted.filter(answer => answer.state === "stopped").length;
				deps.log.info(`processes: a stop requested by another window: ${stopped} of ${acted.length} stopped here`);
				void vscode.window.showInformationMessage(`OMP Desk: Another window ran Kill All. ${stopped} of ${acted.length} of this window's OMP ${acted.length === 1 ? "process was" : "processes were"} stopped.`);
			}
			return answers;
		},
	};
}

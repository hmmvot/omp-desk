/**
 * The Processes view's connection to the running extension.
 *
 * Everything policy-bearing lives in `broker-processes.ts`, `broker-process-stop.ts` and
 * `broker-process-controller.ts`; this module only builds their ports from the extension's
 * own state, owns the view and its visible-only poll, and registers the commands. It
 * reads session rows, broker-slot mappings and shell slots, and stops only through those
 * modules or through the row stop flows the caller hands in; it never signals a process id.
 */

import * as vscode from "vscode";
import { brokerStopAttachFor, stopBrokerThroughBroker } from "./broker-process-stop.ts";
import type { BrokerStopPorts, BrokerStopTarget, BrokerStopOutcome } from "./broker-process-stop.ts";
import { stopOrphanedAndIdle, stopProcess } from "./broker-process-controller.ts";
import type { CapturedRowStop, ProcessControllerPorts } from "./broker-process-controller.ts";
import { createBrokerRecordLister } from "./broker-process-records.ts";
import { buildBrokerProcessCatalog, createBrokerProcessReader } from "./broker-processes.ts";
import type {
	BrokerCatalogRow,
	BrokerCatalogShell,
	BrokerCatalogSources,
	BrokerProcessChild,
	BrokerProcessReader,
	BrokerProcessRow,
	BrokerProcessSnapshot,
	BrokerProcessWindow,
	BrokerRecordFacts,
} from "./broker-processes.ts";
import type { BrokerSlotStore } from "./broker-slots.ts";
import { isPtyProcessAlive, queryPtyProcessIdentity, waitForPtyProcessGone } from "./pty-identity.ts";
import type { PtyBrokerClient } from "./pty-client.ts";
import type { ShellSlotStore } from "./shell-slots.ts";
import { ProcessTreeItem, ProcessTreeProvider } from "../views/process-tree";

export const PROCESSES_VIEW_ID = "omp.processes";

/** How often a visible view re-reads the cheap facts. A hidden view does nothing. */
export const PROCESSES_POLL_MS = 5_000;

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
	/** Slot of the runtime this window drives for the row, or `null`. */
	readonly drivenSlot: string | null;
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
	/** `null` when the session index loaded cleanly. */
	indexLoadError(): string | null;
	/** The profile catalog has been read in this window. */
	catalogLoaded(): boolean;
	/** Re-read the shared catalog (index, broker slots, shell slots, folders). */
	refreshCatalog(): Promise<void>;
	refreshLauncher(): void;
	captureDrivenStop(row: BrokerProcessRow): Promise<CapturedRowStop | null>;
	captureRecordedStop(row: BrokerProcessRow): Promise<CapturedRowStop | null>;
	/** Hold the owning shell lifecycle for the whole authenticated stop/shutdown sequence. */
	runBrokerStop(target: BrokerStopTarget, operation: () => Promise<BrokerStopOutcome>): Promise<BrokerStopOutcome>;
	log(message: string): void;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Session rows and slot tables as the model's catalog sources. */
export function catalogSourcesFrom(deps: ProcessWiringDeps): BrokerCatalogSources {
	const windowOf = (row: ProcessWiringSessionRow): BrokerProcessWindow =>
		row.open || row.running ? "this-window" : row.heldElsewhere ? "other-window" : "none";
	const rows: BrokerCatalogRow[] = deps.sessionRows().map(row => ({
		tabId: row.tabId,
		title: row.title,
		folder: row.folder,
		hostSlot: row.hostSlot,
		window: windowOf(row),
		drivenSlot: row.drivenSlot,
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
	}));
	return {
		ready: deps.catalogLoaded(),
		rows,
		byConversation,
		byEditor: new Set(Object.values(brokerRefs?.byEditor ?? {})),
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
			if (fresh) await deps.refreshCatalog().catch(error => deps.log(`processes: the catalog could not be refreshed: ${messageOf(error)}`));
			return buildBrokerProcessCatalog(catalogSourcesFrom(deps));
		},
		isAlive: isPtyProcessAlive,
		async readCreationTime(pid) {
			const client = await deps.client();
			const ready = client === null ? null : await client.attachReady().catch(() => null);
			if (ready === null || ready.helper === null) return { kind: "unknown", detail: "the process probe is not available" };
			return await queryPtyProcessIdentity(ready.helper, pid);
		},
		async readChild(facts) {
			const client = await deps.client();
			return client === null ? "unknown" : await readChildState(client, facts);
		},
		async buildDigest() {
			const client = await deps.client();
			const ready = client === null ? null : await client.attachReady().catch(() => null);
			return ready?.treeDigest ?? null;
		},
		now: Date.now,
	});
}

/** Create the view, its poll, its commands and the controller ports. */
export function registerProcessesView(context: vscode.ExtensionContext, deps: ProcessWiringDeps): void {
	const reader = createBrokerProcessReaderFor(deps);
	const provider = new ProcessTreeProvider();
	const view = vscode.window.createTreeView(PROCESSES_VIEW_ID, { treeDataProvider: provider });
	view.message = "Reading background processes…";
	let snapshot: BrokerProcessSnapshot | null = null;
	let inFlight: Promise<BrokerProcessSnapshot | null> | null = null;
	let fresherWanted = false;
	let timer: NodeJS.Timeout | undefined;
	let disposed = false;

	const publish = (next: BrokerProcessSnapshot): void => {
		snapshot = next;
		provider.setSnapshot(next);
		view.message =
			next.unreadable > 0
				? `${next.unreadable} broker record ${next.unreadable === 1 ? "file" : "files"} could not be read and ${next.unreadable === 1 ? "is" : "are"} not listed.`
				: undefined;
		view.description = next.rows.length === 0 ? undefined : String(next.rows.length);
		void vscode.commands.executeCommand("setContext", "omp.processesLoaded", true);
	};

	/** One read at a time; an explicit read that arrives mid-flight runs once more afterwards. */
	const refresh = (fresh: boolean): Promise<BrokerProcessSnapshot | null> => {
		if (inFlight !== null) {
			if (fresh) fresherWanted = true;
			return inFlight;
		}
		inFlight = (async () => {
			try {
				let result: BrokerProcessSnapshot | null = null;
				let explicit = fresh;
				do {
					fresherWanted = false;
					result = await reader.read({ fresh: explicit });
					if (!disposed) publish(result);
					explicit = true;
				} while (fresherWanted && !disposed);
				return result;
			} catch (error) {
				deps.log(`processes: the list could not be read: ${messageOf(error)}`);
				return snapshot;
			} finally {
				inFlight = null;
			}
		})();
		return inFlight;
	};

	const startPolling = (): void => {
		if (timer !== undefined) return;
		timer = setInterval(() => void refresh(false), PROCESSES_POLL_MS);
	};
	const stopPolling = (): void => {
		clearInterval(timer);
		timer = undefined;
	};

	const confirm: ProcessControllerPorts["confirm"] = async request =>
		(await vscode.window.showWarningMessage(request.message, { modal: true, detail: request.detail }, request.label)) === request.label;

	const stopPorts: BrokerStopPorts = {
		log: message => deps.log(message),
		async attach(target) {
			const client = await deps.client();
			if (client === null) return { ok: false, reason: "Background process support is unavailable. Reload the window and try Stop again." };
			return await brokerStopAttachFor(client, message => deps.log(message))(target);
		},
		async waitBrokerGone(target, timeoutMs) {
			const client = await deps.client();
			const ready = client === null ? null : await client.attachReady().catch(() => null);
			if (ready === null || ready.helper === null) return { gone: false, detail: "the process probe is not available" };
			return await waitForPtyProcessGone(ready.helper, target.brokerPid, target.brokerCreationTime, timeoutMs);
		},
	};

	const controllerPorts: ProcessControllerPorts = {
		read: options => reader.read(options),
		confirm,
		info: message => void vscode.window.showInformationMessage(`OMP: ${message}`),
		warn: message => void vscode.window.showWarningMessage(`OMP: ${message}`),
		captureDrivenStop: row => deps.captureDrivenStop(row),
		captureRecordedStop: row => deps.captureRecordedStop(row),
		stopThroughBroker: (target, mode) => deps.runBrokerStop(target, () => stopBrokerThroughBroker(target, mode, stopPorts)),
		async forgetStoppedSlot(slot) {
			const shells = deps.shellSlots();
			if (shells?.get(slot) != null) await shells.remove(slot);
			await deps.brokerSlots()?.forget(slot);
		},
		async refresh() {
			deps.refreshLauncher();
			await refresh(true);
		},
	};

	const rowIdOf = (argument: unknown): string | null => {
		if (argument instanceof ProcessTreeItem) return argument.row.id;
		if (typeof argument === "string" && argument.length > 0) return argument;
		return null;
	};

	context.subscriptions.push(
		view,
		provider,
		{
			dispose: () => {
				disposed = true;
				stopPolling();
			},
		},
		view.onDidChangeVisibility(event => {
			if (event.visible) {
				startPolling();
				void refresh(true);
			} else {
				stopPolling();
			}
		}),
		vscode.commands.registerCommand("omp.refreshProcesses", () => refresh(true)),
		vscode.commands.registerCommand("omp.stopProcess", async (argument: unknown) => {
			const id = rowIdOf(argument);
			if (id === null) {
				void vscode.window.showWarningMessage("OMP: Select a process in the Processes view to stop.");
				return;
			}
			await stopProcess(id, controllerPorts);
		}),
		vscode.commands.registerCommand("omp.stopOrphanedProcesses", () => stopOrphanedAndIdle(controllerPorts)),
	);
	if (view.visible) {
		startPolling();
		void refresh(true);
	}
}

/**
 * Opens the profile catalog with its private backup and recovery
 * ([ADR-0081](../../docs/decisions/0081-keep-a-private-backup-of-the-catalog-and-broker-records-outside-vs-codes-storage-and-restore-it-over-a-missing-catalog.md)).
 *
 * The host modules own the rules; this module is the window's side of them: it builds the recovery source and the writer for this
 * storage, runs the recovery before any consumer reads, gathers the evidence of a loss from what VS Code's own state still names,
 * and turns the decided notices into VS Code messages.
 */

import * as vscode from "vscode";
import {
	CatalogBackupWriter,
	cachedVerdict,
	claimNotice,
	createRecoverySource,
	locateRecovery,
	restoreInfoOf,
	restrictRecoveryFolder,
} from "../host/catalog-backup.ts";
import type { CatalogContentKeys, RecoveryLocation } from "../host/catalog-backup.ts";
import { CatalogLossReporter, regressedNotice, restoredNotice } from "../host/catalog-loss.ts";
import type { LossEvidence, LossNotice, LossNoticeAction } from "../host/catalog-loss.ts";
import { catalogPaths, createCatalogStore } from "../host/profile-catalog.ts";
import type { CatalogRecordMerger, CatalogStore } from "../host/profile-catalog.ts";
import { listPtyRecords } from "../host/pty-registry.ts";
import { SESSION_INDEX_LOCAL_KEY } from "../host/session-index.ts";
import { createUnmanagedBrokerScanner, nativeScanPorts, processKey } from "../host/unmanaged-brokers.ts";
import { win32Native } from "../host/win32-native.ts";
import type { Logger } from "../shared/logger.ts";

/** What the window keeps of the recovery after the catalog is open. */
export interface CatalogRecoveryHandle {
	/** Evidence of a loss that arrived later (a restored editor that names a missing tab). */
	addEvidence(more: Partial<LossEvidence>): void;
	/** Start the backup writer; called once the startup restore is over. The first copy is seeded a few seconds later. */
	startBackup(): void;
	dispose(): void;
}

export interface OpenCatalogInput {
	readonly context: vscode.ExtensionContext;
	readonly log: Logger;
	readonly mergers: Readonly<Record<string, CatalogRecordMerger>>;
	readonly keys: CatalogContentKeys;
	readonly onUnavailable: (reason: string) => void;
	/** Reveal the extension's output channel. */
	readonly showLog: () => void;
}

export interface OpenedCatalog {
	readonly store: CatalogStore;
	readonly recovery: CatalogRecoveryHandle;
}

/** How many broker processes of this storage run with no record naming them. */
async function countUnmanagedBrokers(storageDir: string): Promise<number> {
	const native = await win32Native();
	if (native === null) return 0;
	const listing = await listPtyRecords(storageDir).catch(() => null);
	const known = new Set<string>();
	for (const record of listing?.records ?? []) if (record.brokerCreationTime !== null) known.add(processKey(record.brokerPid, record.brokerCreationTime));
	return createUnmanagedBrokerScanner(nativeScanPorts(native)).scan(storageDir, known)?.length ?? 0;
}

/** Tab ids this window's own observations name. */
function observedTabCount(context: vscode.ExtensionContext): number {
	let raw: unknown;
	try {
		raw = context.workspaceState.get(SESSION_INDEX_LOCAL_KEY);
	} catch {
		return 0;
	}
	if (typeof raw !== "object" || raw === null || !("observations" in raw)) return 0;
	const observations = raw.observations;
	return typeof observations === "object" && observations !== null && !Array.isArray(observations) ? Object.keys(observations).length : 0;
}

const ACTION_LABELS: Readonly<Record<LossNoticeAction, string>> = {
	"show-log": "Show Log",
	"show-sessions": "Show Sessions",
	"show-backup-folder": "Show Backup Folder",
};

export async function openProfileCatalog(input: OpenCatalogInput): Promise<OpenedCatalog> {
	const { context, log, keys } = input;
	const storageDir = context.globalStorageUri.fsPath;
	const paths = catalogPaths(storageDir);
	const location: RecoveryLocation | null = locateRecovery(storageDir);
	if (location === null) log.warn("catalog: no folder for a private backup could be resolved, so the catalog has no copy outside VS Code's storage");
	const logAt = (level: "info" | "warn", message: string): void => (level === "info" ? log.info(message) : log.warn(message));

	const show = (notice: LossNotice): void => {
		const labels = notice.actions.map(action => ACTION_LABELS[action]);
		const shown = notice.kind === "restored" ? vscode.window.showInformationMessage(notice.message, ...labels) : vscode.window.showWarningMessage(notice.message, ...labels);
		void shown.then(choice => {
			if (choice === ACTION_LABELS["show-log"]) input.showLog();
			else if (choice === ACTION_LABELS["show-sessions"]) void vscode.commands.executeCommand("ompDesk.sessions.focus");
			else if (choice === ACTION_LABELS["show-backup-folder"] && location !== null) void vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(location.catalogDirectory));
		});
	};

	if (location === null) {
		const store = await createCatalogStore({ paths, mergers: input.mergers, onUnavailable: input.onUnavailable });
		return { store, recovery: { addEvidence: () => undefined, startBackup: () => undefined, dispose: () => undefined } };
	}

	const ensurePrivate = cachedVerdict(restrictRecoveryFolder(location));
	const source = createRecoverySource({ location, storageDir, keys, ensurePrivate, log: logAt });
	const reporter = new CatalogLossReporter({
		inspectBackup: () => source.inspect(),
		claimNotice: kind => claimNotice(location, kind),
		show,
		log: logAt,
	});
	const writer = new CatalogBackupWriter({
		location,
		storageDir,
		documentPath: paths.document,
		keys,
		ensurePrivate,
		log: logAt,
		onRegressed: regression => {
			logAt("warn", `catalog: the saved sessions regressed to ${regression.now.rows} session(s) and ${regression.now.folders} folder(s) from ${regression.before.rows} and ${regression.before.folders}; the previous catalog is kept in ${location.catalogDirectory}`);
			void claimNotice(location, "regressed").then(first => {
				if (first) show(regressedNotice(regression.before, regression.now));
			});
		},
	});

	const store = await createCatalogStore({
		paths,
		mergers: input.mergers,
		onUnavailable: input.onUnavailable,
		recover: source.recover,
		isReset: source.isReset,
		prepareRecovery: source.prepare,
		onRecovered: (recovery, committed) => {
			const info = restoreInfoOf(recovery);
			if (info === null) {
				logAt("info", `catalog: the profile catalog file was missing and was put back from this window's last read (revision ${committed.revision})`);
				return;
			}
			const ageMs = Date.now() - info.copy.mtimeMs;
			logAt(
				"info",
				`catalog: the profile catalog was missing or reset; restored revision ${committed.revision} (${info.content.rows} session(s), ${info.content.folders} folder(s)) from ${recovery.label}, made ${Math.round(ageMs / 60_000)} minute(s) ago; ` +
					`${info.brokers.restored} of ${info.brokers.considered} broker record(s) restored` +
					(info.brokers.skipped.length > 0 ? ` (${info.brokers.skipped.join("; ")})` : "") +
					(info.refused.length > 0 ? `; newer copies refused: ${info.refused.join("; ")}` : ""),
			);
			void countUnmanagedBrokers(storageDir).catch(() => 0).then(unmanagedBrokers => {
				show(restoredNotice({ rows: info.content.rows, folders: info.content.folders, ageMs, brokersRestored: info.brokers.restored, unmanagedBrokers }));
			});
		},
	});

	// Before any consumer builds a view from the catalog: a missing or reset document is repaired from the backup.
	const restored = await store.recoverIfNeeded().catch(error => {
		log.warn(`catalog: the recovery from the backup failed: ${error instanceof Error ? error.message : String(error)}`);
		return false;
	});
	if (store.openedWithoutDocument() && !restored && store.revision() === 0) {
		// Nothing could be restored. Whether that is a first install or a loss is told by what VS Code's own state still names.
		reporter.arm();
		reporter.add({ observations: observedTabCount(context) });
		void listPtyRecords(storageDir).then(
			listing => reporter.add({ recordFiles: listing.records.length + listing.invalid.length }),
			() => undefined,
		);
		void countUnmanagedBrokers(storageDir).then(unmanagedBrokers => reporter.add({ unmanagedBrokers }), () => undefined);
	}

	let unsubscribe: (() => void) | null = null;
	return {
		store,
		recovery: {
			addEvidence: more => reporter.add(more),
			startBackup: () => {
				if (unsubscribe !== null) return;
				unsubscribe = store.onChange(() => writer.notifyChange());
				writer.start();
			},
			dispose: () => {
				unsubscribe?.();
				unsubscribe = null;
				writer.dispose();
				reporter.dispose();
			},
		},
	};
}

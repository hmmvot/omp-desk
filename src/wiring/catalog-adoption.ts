/**
 * How this window follows the profile catalog: reading it once at activation, adopting what other windows (and this
 * window's own commits) change in it, and the startup restore pass with the cohort of rows it is responsible for.
 *
 * The catalog layer decides what is committed (`host/profile-catalog.ts`), the stores decide how a record is read back
 * (`SessionIndex.refreshFromStore`, the slot stores, `LauncherFolders.reload`) and the restore pass is the runtime's
 * (`restoreTabs`, reached through {@link CatalogAdoptionDeps}); this module sequences them. It owns the startup restore's
 * own state (the pending flag, the pass and its kept broker connections, the deferral display-only reads wait on), the
 * adoption runner and the readiness of the catalog; the window's stores and the launcher arrive as getters and callbacks.
 *
 * ## Key-aware adoption
 *
 * Every catalog change reaches this module as the set of record keys it changed, whether the change is another window's
 * (a refresh the watcher caused) or this window's own commit. A run adopts only what depends on the keys that changed:
 * the broker and shell slot stores reload only when their own record changed, the folder list only when its record did, and
 * the session rows only when the session record did — and then only the rows whose committed copy differs from the one this
 * window last adopted (`SessionIndex.refreshFromStore({ changedOnly })`). A reply-marker-only commit therefore re-reads one
 * row and repaints the launcher; it reloads no store and reads no other row. An explicit request (a focus, a refresh
 * command, activation) reads the document again and adopts everything, as a missed notification costs a refresh and never
 * correctness. A change that failed to adopt is kept and adopted again by the next run.
 */

import { CoalescedRun } from "../host/coalesced-run.ts";
import { setImmediate as yieldToIo } from "node:timers/promises";
import { BROKER_SLOTS_KEY } from "../host/broker-slots.ts";
import { trackOperation } from "../host/loop-lag.ts";
import type { CatalogPaths, CatalogRefresh, CatalogStore } from "../host/profile-catalog.ts";
import { ParkedRpcConnections } from "../host/rpc-parked.ts";
import type { OwnerReconciler } from "../host/session-availability.ts";
import { SESSION_INDEX_STORAGE_KEY, homeAllows } from "../host/session-index.ts";
import type { SessionIndex } from "../host/session-index.ts";
import type { SessionIndexEntry } from "../host/session-model.ts";
import { describeRestorePhases } from "../host/session-restore-trace.ts";
import type { RestorePassPhases } from "../host/session-restore-trace.ts";
import { SHELL_SLOTS_KEY } from "../host/shell-slots.ts";
import type { Logger } from "../shared/logger.ts";
import type { LauncherFolders } from "../views/launcher-folders.ts";
import { WORKSPACE_FOLDERS_STORAGE_KEY } from "../views/workspace-folders.ts";

/** How long display-only reads wait for the startup restore before they run anyway. */
const STARTUP_DEFER_CAP_MS = 120_000;

/** How long after the startup restore the records of ended processes no window holds are settled. */
const GONE_RECORD_SWEEP_DELAY_MS = 20_000;

/** The parts of the session index this module reads and drives. */
export type AdoptionIndex = Pick<SessionIndex, "refreshFromStore" | "hasLiveHost" | "get" | "list" | "sweepGoneRecords">;

/** The catalog store of this window. */
export type AdoptionCatalog = CatalogStore;

/** A store that caches its own projection of a catalog record. */
export interface ReloadableSlots {
	reload(): void;
}

/** What the module needs of the extension. */
export interface CatalogAdoptionDeps {
	readonly log: Logger;
	/** When this window's activation began; the startup timeline is relative to it. */
	readonly activatedAt: number;
	// The window's stores
	catalog(): AdoptionCatalog | undefined;
	brokerSlots(): ReloadableSlots | undefined;
	shellSlots(): ReloadableSlots | undefined;
	/** Forget the claim file names resolved per row target. */
	dropClaimFileNames(): void;
	/** Re-register the local editors with the roles the committed bindings record. */
	reconcileLocalRoles(index: AdoptionIndex): void;
	/** Repaint the launcher. */
	refreshLauncher(): void;
	// Activation
	/** Import the predecessor build's folder list once. Never throws on its own failure's account. */
	importPredecessorFolders(catalog: AdoptionCatalog): Promise<void>;
	/** The sidebar stops saying the catalog is being read. */
	catalogRead(): void | PromiseLike<unknown>;
	/** Watch the catalog's files; the signal is a hint. Returns the disposer. */
	watchCatalog(paths: CatalogPaths, onSignal: () => void): () => void;
	/** Keep a disposable for the life of the window. */
	subscribe(disposable: { dispose(): void }): void;
	/** Start the private backup of the catalog. */
	startBackup(): void;
	// The startup restore
	/** The restore pass over the cohort, projected into the editors VS Code restored. */
	restoreTabs(index: AdoptionIndex, cohort: ReadonlySet<string>, phases: RestorePassPhases): Promise<void>;
	/** Whether this window currently has an editor showing that conversation. */
	hasLocalEditorFor(tabId: string): boolean;
	/** The URI of the window that owns this one's workspace, as the rows' `home` records it. */
	owningWindow(): string | null;
	/** Start the full runtime proof once the attach work is done. */
	startRuntimeProof(): void;
	reconciler(): OwnerReconciler;
	/** One line of the window timeline. */
	timing(event: string, detail?: string, level?: "debug" | "info"): void;
}

/** The pass of the startup restore while it runs. */
export interface StartupRestore {
	/** Resolves once the pass has restored the cohort and published every panel and the final focus. */
	readonly settled: Promise<void>;
	/** The rows the activation is responsible for, captured before the pass started. */
	readonly cohort: ReadonlySet<string>;
}

/** What outside callers do with the catalog adoption and the startup restore. */
export interface CatalogAdoption {
	/**
	 * Read the catalog this window starts from, then restore. Imports the predecessor's folders, adopts the committed
	 * records, starts the restore pass and the catalog watch.
	 */
	activate(index: AdoptionIndex, folders: Pick<LauncherFolders, "reload">, catalog: AdoptionCatalog): void;
	/**
	 * Adopt everything the newest committed catalog revision holds: the document is read again and every dependent store is
	 * brought up to it. The returned promise covers a read made after this call.
	 */
	adopt(index: AdoptionIndex, folders: Pick<LauncherFolders, "reload">, options?: { readonly startup?: boolean }): Promise<void>;
	/** Resolves once the catalog was read and the predecessor import settled, so a row resolved during activation sees all that can be recovered. */
	ready(): Promise<void>;
	/** Resolves once every adoption requested so far has run, whether it succeeded or failed. */
	idle(): Promise<void>;
	/** Start the restore pass over the rows this window is responsible for. `activate` calls it after the first adoption. */
	startRestore(index: AdoptionIndex): void;
	/** The restore pass while it runs, or `null` before it starts and after it is over. */
	startupRestore(): StartupRestore | null;
	/** Whether the pass covers the tab: it runs, and the tab is in its cohort. */
	restoreCovers(tabId: string): boolean;
	/** Whether the pass has not yet started or has ended: `true` once the restore is over for good. */
	startupRestoreSettled(): boolean;
	/**
	 * `null` when the startup restore is over; otherwise a promise that settles when it is. Reads that only paint the Sessions
	 * view (a row's ownership observation, the Processes poll, the session-lease probe) wait for it; an explicit action never does.
	 */
	startupRestoreOver(): Promise<void> | null;
	/** Settles when the startup restore is over or after the deferral cap, whichever is first; for the work that only paints and the helpers' background class. */
	readonly startupOver: Promise<void>;
	/** Start the clock that ends the deferral even if the pass never settles; the disposer cancels it. */
	armDeferralCap(): { dispose(): void };
	/** The pass's kept broker connections while it runs; `null` outside the pass. */
	restoreParking(): ParkedRpcConnections | null;
	/** Whether the pass covers this row: while it runs, its cohort; before it starts, the rows it will take. */
	startupCovers(index: AdoptionIndex | null, tabId: string): boolean;
	/** Whether one row is this window's responsibility at activation. */
	inLocalRecoveryCohort(index: AdoptionIndex, tabId: string): boolean;
}

/** One request for a run; requests folded into one run are merged. */
interface AdoptionRequest {
	readonly index: AdoptionIndex;
	readonly folders: Pick<LauncherFolders, "reload">;
	readonly startup: boolean;
	/** Adopt everything, whatever the notified keys say. */
	readonly full: boolean;
	/** Read the document again first. */
	readonly read: boolean;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function registerCatalogAdoption(deps: CatalogAdoptionDeps): CatalogAdoption {
	const { log } = deps;
	let adoption: CoalescedRun<AdoptionRequest> | undefined;
	/** The record keys changed since a run last adopted; filled by the catalog's own notifications, drained by a run. */
	const queuedKeys = new Set<string>();
	let ready: Promise<void> = Promise.resolve();
	let adoptedAt: number | null = null;
	/** The newest request, settled once it ran (failed or not). */
	let lastRequest: Promise<void> = Promise.resolve();

	// The startup restore
	let startup: StartupRestore | null = null;
	let parking: ParkedRpcConnections | null = null;
	/** `true` from activation until the startup pass has captured its cohort (see `startupCovers`). */
	let pending = true;
	const over = Promise.withResolvers<void>();

	/** Adopt what a run covers; returns nothing, throws on a failure of any step. */
	async function adoptRun(request: AdoptionRequest): Promise<void> {
		const catalog = deps.catalog();
		if (catalog === undefined) return;
		const { index, folders } = request;
		// A foreign revision is read from disk; this window's *own* commit already advanced the
		// projection, and its consumers may still hold the snapshot their change was derived
		// from. Adopting either way is what keeps a derived delta honest: a merged-in record
		// must reach the consumer before that consumer's next write, or its next delta would
		// read as a deliberate removal of the other window's row.
		if (request.read) await catalog.refresh();
		// A notification is raised inside the commit it reports, before the committing store has taken the commit as its own
		// view (`BrokerSlotStore` sets its cache after its `update` returns): adopting on the spot would be overwritten by
		// that, so the run waits until what the commit left in flight has run.
		else await yieldToIo();
		// Drained after the read: the keys the read itself published are adopted by this run, so the follow-up its
		// notification asked for finds nothing left to do.
		const keys = new Set(queuedKeys);
		queuedKeys.clear();
		const all = request.full;
		if (!all && keys.size === 0) return;
		try {
			const sessions = all || keys.has(SESSION_INDEX_STORAGE_KEY);
			const brokers = all || keys.has(BROKER_SLOTS_KEY);
			const shells = all || keys.has(SHELL_SLOTS_KEY);
			const folderList = all || keys.has(WORKSPACE_FOLDERS_STORAGE_KEY);
			// The small stores cache their own projection, so a changed record must drop it
			// before the next read: a stale broker table would send an attach to a transport
			// another window has already moved.
			if (brokers) deps.brokerSlots()?.reload();
			if (shells) deps.shellSlots()?.reload();
			const adopted = sessions ? await index.refreshFromStore(all ? {} : { changedOnly: true }) : null;
			if (adopted !== null && (all || adopted.adopted.length > 0 || adopted.removed.length > 0)) deps.dropClaimFileNames();
			// A durable role is what authorizes this window's editor, so a demotion another window
			// committed (or this window recorded for another slot) must reach the local registry
			// and therefore the bridge/pipeline eligibility of the affected editor.
			if (adopted !== null && adopted.bindingsChanged) deps.reconcileLocalRoles(index);
			const foldersChanged = folderList ? await folders.reload() : false;
			if (adopted !== null && (adopted.adopted.length > 0 || adopted.removed.length > 0) || foldersChanged || request.startup) {
				log.info(
					`catalog: adopted ${adopted?.adopted.length ?? 0} new row(s), dropped ${adopted?.removed.length ?? 0}, ` +
						`kept ${adopted?.kept.length ?? 0} in use${foldersChanged ? ", and the folder list changed" : ""}`,
				);
			}
			// Repainting is for what a change can show: a row that moved, a folder list or a slot table that changed.
			if (all || brokers || shells || foldersChanged || (adopted?.touched.length ?? 0) > 0 || adopted?.bindingsChanged === true) deps.refreshLauncher();
		} catch (error) {
			// What failed is adopted again by the next run, whatever asks for it.
			for (const key of keys) queuedKeys.add(key);
			throw error;
		}
	}

	function request(next: AdoptionRequest): Promise<void> {
		adoption ??= new CoalescedRun<AdoptionRequest>(
			run => trackOperation("catalog adoption", () => adoptRun(run)),
			(pendingRequest, later) => ({
				index: later.index,
				folders: later.folders,
				startup: pendingRequest.startup || later.startup,
				full: pendingRequest.full || later.full,
				read: pendingRequest.read || later.read,
			}),
		);
		const requested = adoption.request(next);
		lastRequest = requested.then(() => undefined, () => undefined);
		return requested;
	}

	/** Which window rows this window restores at activation: see {@link CatalogAdoption.startupCovers}. */
	function inLocalRecoveryCohort(index: AdoptionIndex, tabId: string): boolean {
		if (index.hasLiveHost(tabId)) return true;
		if (!deps.hasLocalEditorFor(tabId)) return false;
		const entry: SessionIndexEntry | null = index.get(tabId);
		return entry === null || homeAllows(entry, deps.owningWindow());
	}

	/**
	 * The rows this window is responsible for restoring at activation.
	 *
	 * A row qualifies when this window already runs a host for it, or when VS Code handed this window an editor for its
	 * conversation (`editorMembership`/the serializer path bound a panel for it) and the window is home for the row: a `running`
	 * row returns to the window that last drove it, so a session moved to another window is not brought back here by the editor
	 * the move left behind (ADR-0080, amendment of 2026-10-21). Everything else in the profile-wide index is another window's
	 * or another workspace's row: visible, and deliberately inert until the user opens it.
	 */
	function localRecoveryCohort(index: AdoptionIndex): ReadonlySet<string> {
		const cohort = new Set<string>();
		for (const entry of index.list()) {
			if (inLocalRecoveryCohort(index, entry.tabId)) cohort.add(entry.tabId);
		}
		return cohort;
	}

	/**
	 * Run the activation restore pass as a handoff the launcher's clicks wait on.
	 *
	 * The rows activation is responsible for are captured before the pass starts, and
	 * its completion is retained over the whole pass — every reconcile, launch and
	 * attach, plus the result it projects into the editors VS Code restored. A pass
	 * that threw would otherwise leave a promise nobody could settle and an unhandled
	 * rejection behind, so an escaped failure is logged and settles the handoff:
	 * clicks then re-read the rows and panels the pass left and open normally, and a
	 * startup failure is never read as evidence about ownership.
	 *
	 * ## The local recovery cohort
	 *
	 * The index is profile-wide now, so a row in it may belong to another workspace this
	 * window has nothing to do with. Activation therefore restores only the rows *this*
	 * window is responsible for: the conversations whose editor VS Code restored here,
	 * and the rows this window already runs. Every other row stays visible in the
	 * launcher and inert — the user opens it explicitly, which is the one action that
	 * starts or adopts it. A stopped or explicitly released row keeps its own refusal
	 * either way: the cohort decides *whose* row may be restored, never whether a
	 * stopped row may start.
	 *
	 * A restored editor whose tab was not in the cohort when the pass started is not
	 * abandoned: its own serializer path opens that tab, so it is re-derived from
	 * current facts exactly as an explicit click is.
	 */
	function startRestore(index: AdoptionIndex): void {
		const cohort = localRecoveryCohort(index);
		pending = false;
		const restoreStartedAt = Date.now();
		const phases: RestorePassPhases = {};
		// Connections the pass's reconciles keep for its attaches (`ParkedRpcConnections`); closed when the pass ends whatever happened.
		const kept = new ParkedRpcConnections();
		parking = kept;
		const settled = (async () => {
			try {
				await deps.restoreTabs(index, cohort, phases);
			} catch (error) {
				log.error(`restore: the startup pass failed: ${messageOf(error)}`);
			} finally {
				kept.release();
				if (parking === kept) parking = null;
			}
		})();
		startup = { settled, cohort };
		// Rows the catalog adoption just published were derived before this pass existed, so a live
		// row of this window's cohort would keep saying "Blocked" until some later event: re-derive
		// them now, as "Restoring" for the length of the pass.
		deps.refreshLauncher();
		void settled.then(() => {
			const since = (at: number): string => `+${at - deps.activatedAt} ms`;
			const finishedAt = Date.now();
			const phasesText = describeRestorePhases(phases, finishedAt);
			deps.timing(
				"startup restore timeline",
				`activation → catalog adopted ${adoptedAt === null ? "unknown" : since(adoptedAt)} → restore started ${since(restoreStartedAt)} → restore finished ${since(finishedAt)} (${cohort.size} rows${phasesText === "" ? "" : `; ${phasesText}`})`,
				"info",
			);
			// The pass can no longer publish anything, so a later click only has to read
			// the panels it left behind.
			if (startup?.settled === settled) startup = null;
			// What only paints Sessions has been waiting for this moment (`startupRestoreOver`); its reads start now, after the
			// restore's own PowerShell and not in competition with it.
			over.resolve();
			// Rows that said "Restoring" for the length of the pass are re-derived now.
			deps.refreshLauncher();
			// Start the full runtime proof now that the attach work is done, so the first terminal or fallback launch
			// finds it ready (a Chat on Bun does not wait for it). It is a readiness check only: no broker, host or session starts.
			deps.startRuntimeProof();
			// Records a window that is gone left behind for rows no window here holds are settled once, after the restore and
			// off its critical path: it starts nothing and never changes a run intent (`SessionIndex.sweepGoneRecords`).
			const sweep = setTimeout(() => {
				void index.sweepGoneRecords({
					reconciler: deps.reconciler(),
					ownedHere: tabId => cohort.has(tabId) || inLocalRecoveryCohort(index, tabId),
				}).then(report => {
					if (report.cleared.length > 0 || report.orphanClaims > 0) {
						log.info(`records of ended processes: cleared the recorded process of ${report.cleared.length} row(s), deleted ${report.orphanClaims} unclaimed claim file(s)`);
						if (report.cleared.length > 0) deps.refreshLauncher();
					}
				}).catch(error => log.warn(`records of ended processes: the pass failed: ${messageOf(error)}`));
			}, GONE_RECORD_SWEEP_DELAY_MS);
			sweep.unref();
		});
	}

	/**
	 * Watch the catalog so another window's write is visible here without a restart.
	 *
	 * The watcher is a hint: it never restores, launches, claims or stops anything, and a
	 * failure to watch only costs a refresh on the next focus or explicit refresh.
	 */
	function watchCatalog(index: AdoptionIndex, folders: Pick<LauncherFolders, "reload">, catalog: AdoptionCatalog): void {
		// This window's own commits publish through the store as well as another window's change a refresh read: every one
		// carries the record keys it changed, queued for the run it asks for. A record another window's change was merged into
		// therefore reaches the consumer that owns it before that consumer writes again.
		const unsubscribe = catalog.onChange((change: CatalogRefresh) => {
			for (const key of change.keys) queuedKeys.add(key);
			void request({ index, folders, startup: false, full: false, read: false })
				.catch(error => log.warn(`catalog: a change could not be adopted: ${messageOf(error)}`));
		});
		deps.subscribe({ dispose: unsubscribe });
		// A signal of the files is a hint that another window may have committed: the read finds out, and publishes the keys
		// it changed through the notification above.
		const dispose = deps.watchCatalog(catalog.paths, () => {
			void catalog.refresh().catch(error => log.warn(`catalog: another window's change could not be read: ${messageOf(error)}`));
		});
		deps.subscribe({ dispose });
	}

	/**
	 * Adopt whichever records another window committed since this window last read.
	 *
	 * The catalog's revision — not this window's cached projection — decides what
	 * changed, so a missed watcher event costs a refresh rather than correctness. This
	 * restores nothing and launches nothing: adopting another window's rows only makes
	 * them visible here, and their ownership is proven exactly as before when the user
	 * opens one.
	 *
	 * Adoptions never overlap: a request that arrives while one runs waits for a single follow-up that starts after it, so
	 * the promise this returns always covers a read made after the call.
	 */
	function adopt(index: AdoptionIndex, folders: Pick<LauncherFolders, "reload">, options: { readonly startup?: boolean } = {}): Promise<void> {
		return request({ index, folders, startup: options.startup === true, full: true, read: true });
	}

	return {
		/**
		 * Import the predecessor build's folder list once, then let the shared catalog drive this window.
		 *
		 * The import runs before any startup restoration and before commands resolve their rows.
		 * It reads the predecessor's catalog without touching it and commits only the registered
		 * folder list together with a ledger entry.
		 */
		activate(index, folders, catalog) {
			const settled = (async () => {
				try {
					await deps.importPredecessorFolders(catalog);
				} catch (error) {
					log.warn(`predecessor import: the pass failed and nothing was changed by it: ${messageOf(error)}`);
				}
				try {
					await adopt(index, folders, { startup: true });
				} catch (error) {
					log.warn(`catalog: the recovered records could not be adopted: ${messageOf(error)}`);
				}
				await deps.catalogRead();
				// Staging is not awaited here. The restore re-adopts running sessions, and only the step that proves a Chat's
				// host control needs the staged pipe helper: `LocalHostControl` waits for it itself (`stagedHelper`), so the
				// catalog adoption, the restore start, the broker attach and the panel binding never queue behind the security
				// reads staging performs.
				// Only now is the index complete: the pass restores exactly the rows this window
				// is responsible for, and a click on any other row is an explicit open.
				adoptedAt = Date.now();
				startRestore(index);
				// The private backup of the catalog starts with the restore: its first copy is seeded a few seconds later, after the restore.
				deps.startBackup();
				watchCatalog(index, folders, catalog);
			})();
			ready = settled.then(
				() => undefined,
				() => undefined,
			);
		},
		adopt,
		ready: () => ready,
		idle: () => lastRequest,
		startRestore,
		startupRestore: () => startup,
		restoreCovers: tabId => startup !== null && startup.cohort.has(tabId),
		startupRestoreSettled: () => startup === null && !pending,
		startupRestoreOver: () => (pending || startup !== null ? over.promise : null),
		startupOver: over.promise,
		armDeferralCap() {
			const timer = setTimeout(() => over.resolve(), STARTUP_DEFER_CAP_MS);
			timer.unref();
			return { dispose: () => clearTimeout(timer) };
		},
		restoreParking: () => parking,
		startupCovers: (index, tabId) => (startup !== null ? startup.cohort.has(tabId) : pending && index !== null && inLocalRecoveryCohort(index, tabId)),
		inLocalRecoveryCohort,
	};
}

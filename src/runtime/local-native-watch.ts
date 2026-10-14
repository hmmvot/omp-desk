/**
 * The native terminal's watch for the in-process runtime (ADR-0066, cut 5): control polling, the
 * observed handover of a running native process to another conversation (`/resume`, `/new`), and
 * the exit of the process.
 *
 * The watch polls the exact process's broker status and its verified control channel. What the
 * poll finds is applied by the runtime (the conversation's identity, its title, the handover
 * transaction under the two-session lock); what the window shows (completion notices, turn
 * activity, the editor's document and panel) is its hooks, run after the state they describe is
 * committed. The watch never launches anything: an exit is recorded by the exit operations.
 */
import type { Logger } from "../shared/logger.ts";
import { isOpenControlClient } from "../host/control-attempt.ts";
import type { HostControlClient } from "../host/control-client.ts";
import { BROKER_SLOTS_KEY } from "../host/broker-slots.ts";
import type { BrokerSlotStore } from "../host/broker-slots.ts";
import { controlPathEquals } from "../host/control-protocol.ts";
import type { ControlNativeActivity, ControlNativeState } from "../host/control-protocol.ts";
import type { NativeHostRuntime } from "../host/native-session.ts";
import type { OwnerReconciler } from "../host/session-availability.ts";
import { readSessionFileHeader } from "../host/session-files.ts";
import type { SessionIndex } from "../host/session-index.ts";
import type { EditorSlotBinding, SessionIndexEntry } from "../host/session-model.ts";
import type { LocalHostControl } from "./local-control.ts";
import type { LocalExitOperations } from "./local-exit.ts";
import type { LocalIdentity } from "./local-identity.ts";
import type { RuntimeRecord, RuntimeRecords } from "./runtime-record.ts";

const POLL_INTERVAL_MS = 750;
const FIRST_CONNECTION_DELAY_MS = 5_000;
const MAX_CONNECTION_BACKOFF_MS = 60_000;

/** What the window shows of one poll of a watch's verified channel (completion notices, turn activity). */
export interface NativeObserver {
	/** `journal` is `null` for a host that predates the completion journal. Never waits for the user. */
	observe(client: HostControlClient, journal: ControlNativeActivity | null, facts: ControlNativeState): void;
}

/** What the native watch asks of its window; in-process only (design §2.5). */
export interface NativeWatchWindow {
	/** One observer per watch; it owns the per-watch ledger of what was already announced. */
	observer(record: RuntimeRecord, runtime: NativeHostRuntime): NativeObserver;
	/** Whether the window has been activated; before that no control connection can be attempted. */
	activated(): boolean;
	/** The window's projection of the record changed. */
	view(record: RuntimeRecord): void;
	/** The conversation's title changed: refresh its tab appearance. */
	titled(conversation: string): void;
	/** Commit the conversation's bridge document and refresh its readiness. */
	committed(conversation: string): Promise<void>;
	/** The editor lost the conversation to a verified rival: keep it, passive, with the reason. */
	passive(record: RuntimeRecord, conversation: string, detail: string): void;
	/**
	 * The index moved the running process from one conversation to another under the editor's slot:
	 * rebind the editor's resources (terminal frontend, drafts, activity, bridge winner) to `to`.
	 * Runs before `to` is bound to its identity; `stateOf(to)` resolves to the record from here on.
	 */
	rebound(record: RuntimeRecord, from: string, to: string, binding: EditorSlotBinding): void;
	/** Re-render the editor's document and pipeline for `to` and commit it. Runs after `to`'s identity was bound. */
	presented(record: RuntimeRecord, runtime: NativeHostRuntime, to: string): Promise<void>;
	/** The handover is complete and `to` is the active conversation. */
	settled(to: string): void;
}

export interface LocalNativeWatchDeps {
	readonly index: SessionIndex;
	readonly window: NativeWatchWindow;
	readonly records: RuntimeRecords;
	readonly control: LocalHostControl;
	readonly exit: Pick<LocalExitOperations, "nativeExited">;
	readonly identity: LocalIdentity;
	readonly reconciler: () => OwnerReconciler;
	/** The durable broker slot table, `undefined` before activation created it. */
	readonly brokerSlots: () => BrokerSlotStore | undefined;
	readonly log: Logger;
}

type SignalState = "available" | "control-unavailable" | "native-not-ready" | "older-host";

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class LocalNativeWatch {
	readonly #deps: LocalNativeWatchDeps;
	/** The native-host observations of one runtime, applied one after another. */
	readonly #observations = new WeakMap<NativeHostRuntime, Promise<void>>();

	constructor(deps: LocalNativeWatchDeps) {
		this.#deps = deps;
	}

	/**
	 * Fresh and best effort: whether an authenticated native process of this window currently serves
	 * this exact file. SDK readback is never a global writer ledger, so a failure only skips a record.
	 */
	async servesFile(sessionFile: string): Promise<boolean> {
		for (const state of this.#deps.records.all()) {
			const native = state.runtime;
			const control = state.control?.client;
			if (native?.kind !== "terminal" || control === undefined || !isOpenControlClient(control)) continue;
			try {
				const facts = await control.nativeState();
				if (state.runtime !== native || !facts.available) continue;
				native.observed = facts;
				if (facts.sessionFile !== null && controlPathEquals(facts.sessionFile, sessionFile)) return true;
			} catch { /* best effort */ }
		}
		return false;
	}

	/** Watch one native runtime of a record; a previous watch of the record ends. */
	start(state: RuntimeRecord, runtime: NativeHostRuntime): void {
		const { window, control, exit, log } = this.#deps;
		state.nativeWatch?.();
		let cancelled = false;
		let timer: NodeJS.Timeout | null = null;
		const observer = window.observer(state, runtime);
		let nextConnectionAttemptAt = Date.now() + FIRST_CONNECTION_DELAY_MS;
		let consecutiveControlFailures = 0;
		let signalState: SignalState | null = null;
		const reportSignals = (next: SignalState): void => {
			if (signalState === next || state.tabId === null) return;
			signalState = next;
			log.info(`tab ${state.tabId}: native completion signals ${next === "available" ? "available — sealed activity journal" : next === "older-host" ? "unavailable — this native host predates the completion journal; state observation continues" : next === "native-not-ready" ? "unavailable — verified host has not reported native session readiness yet" : "unavailable — waiting for verified host control; connection will retry"}`);
		};
		const unsubscribe = runtime.handle.subscribe(event => {
			if (event.type === "state" && event.status.state === "exited" && state.tabId !== null) {
				void exit.nativeExited(state, runtime);
			}
		});
		const tick = async (): Promise<void> => {
			if (cancelled || state.runtime !== runtime || state.tabId === null) return;
			let polledClient: HostControlClient | undefined;
			try {
				await runtime.handle.refreshStatus();
				if (runtime.handle.state === "exited") {
					await exit.nativeExited(state, runtime);
					return;
				}
				const client = state.control?.client;
				if (!isOpenControlClient(client)) {
					reportSignals("control-unavailable");
					if (!state.transitioning && !runtime.stopping && window.activated() &&
						Date.now() >= nextConnectionAttemptAt && control.attempt(runtime) === undefined) {
						nextConnectionAttemptAt = Date.now() + FIRST_CONNECTION_DELAY_MS;
						void control.reconnect(state.tabId, this.#deps.index.get(state.tabId)?.ownership?.ownerGeneration ?? "", runtime)
							.catch(error => {
								if (!cancelled && state.runtime === runtime && !state.transitioning && !runtime.stopping &&
									!isOpenControlClient(state.control?.client)) control.reportFailure(state.tabId!, error);
							})
							.finally(() => {
								// Every attempt dials the slot's pipes through a PowerShell peer proof, so a host
								// that cannot be verified is retried less and less often: 5 s, doubling to 60 s.
								consecutiveControlFailures = isOpenControlClient(state.control?.client) ? 0 : consecutiveControlFailures + 1;
								nextConnectionAttemptAt = Date.now() + Math.min(MAX_CONNECTION_BACKOFF_MS, FIRST_CONNECTION_DELAY_MS * 2 ** Math.min(consecutiveControlFailures, 4));
							});
					}
				}
				if (client !== undefined && isOpenControlClient(client) && !state.transitioning) {
					polledClient = client;
					const journal = state.control?.activity === true
						? await client.nativeActivity(state.control.work === true ? { work: true } : {}) : null;
					const facts = journal === null ? await client.nativeState() : journal.state;
					if (state.runtime !== runtime || state.transitioning) return;
					if (state.control?.client !== client) return;
					reportSignals(journal === null ? "older-host" : facts.available ? "available" : "native-not-ready");
					runtime.observed = facts;
					if (facts.available) await this.observe(state, runtime, facts);
					if (state.tabId !== null) observer.observe(client, journal, facts);
				}
				window.view(state);
			} catch (error) {
				if (state.runtime === runtime && !state.transitioning && !runtime.stopping) {
					if (polledClient !== undefined && state.control?.client === polledClient) {
						control.reportFailure(state.tabId!, error);
						reportSignals("control-unavailable");
					} else {
						state.controlFailure = `Native control is unavailable (${messageOf(error)}). After /restart, use native /exit or explicit force Stop; no automatic replacement is safe.`;
					}
				}
				window.view(state);
			} finally {
				if (!cancelled && state.runtime === runtime) {
					timer = setTimeout(() => void tick(), POLL_INTERVAL_MS);
					timer.unref?.();
				}
			}
		};
		state.nativeWatch = () => { cancelled = true; clearTimeout(timer ?? undefined); unsubscribe(); };
		void tick();
	}

	/** Apply what a native process reported, one observation after another for the same runtime. */
	async observe(state: RuntimeRecord, runtime: NativeHostRuntime, facts: ControlNativeState): Promise<void> {
		const previous = this.#observations.get(runtime) ?? Promise.resolve();
		const next = previous.then(async () => {
			if (state.runtime !== runtime) return;
			runtime.observed = facts;
			await this.#apply(state, runtime, facts);
		});
		this.#observations.set(runtime, next.catch(() => undefined));
		await next;
	}

	/**
	 * Apply what the native process reported about the conversation it serves: the same one (record
	 * its id and file, its title), or another one (`/resume`, `/new`), in which case the running
	 * process is handed over to that conversation's row under the two-session lock. Never imports
	 * or materialises a file OMP has not written.
	 */
	async #apply(state: RuntimeRecord, runtime: NativeHostRuntime, facts: ControlNativeState): Promise<void> {
		const { index, window, identity } = this.#deps;
		const fromId = state.tabId;
		if (fromId === null || facts.sessionId === null || state.runtime !== runtime || state.transitioning) return;
		const from = index.get(fromId);
		if (from === null) return;
		const sameId = from.sessionId === null || from.sessionId === facts.sessionId;
		const sameFile = from.sessionFile === null || (facts.sessionFile !== null && controlPathEquals(from.sessionFile, facts.sessionFile));
		if (sameId && sameFile) {
			await index.recordHostSessionId(fromId, facts.sessionId);
			if (facts.sessionFile !== null && from.sessionFile === null) await identity.bind(fromId, runtime, facts.sessionFile, facts.sessionId);
			if (facts.name !== from.title) {
				await index.recordConversationState(fromId, { title: facts.name });
				window.titled(fromId);
			}
			await window.committed(fromId);
			return;
		}
		// SDK allocated paths may not exist yet. Never import or materialize one.
		let destination: SessionIndexEntry | null = null;
		const observedFile = facts.sessionFile;
		if (observedFile !== null && await readSessionFileHeader(observedFile) !== null) {
			destination = index.list().find(entry => entry.sessionFile !== null && controlPathEquals(entry.sessionFile, observedFile)) ?? await index.trackSession({ sessionFile: observedFile, cwd: facts.cwd ?? runtime.cwd, scope: from.scope });
		} else if (observedFile === null || !sameId) {
			destination = index.list().find(entry => entry.sessionFile === null && entry.sessionId === facts.sessionId) ?? await index.createDraft({ cwd: facts.cwd ?? runtime.cwd, scope: from.scope });
		}
		if (destination === null || state.runtime !== runtime || state.transitioning || state.tabId !== fromId || runtime.identity.childCreationTime === null) return;
		const mapping = this.#deps.brokerSlots();
		if (mapping === undefined) return;
		const priorDestinationSlot = mapping.forConversation(destination.tabId) ?? undefined;
		const result = await index.transferNativeHost({
			fromTabId: fromId, toTabId: destination.tabId, slotId: state.slotId, expectedPid: runtime.pid,
			expectedCreationTime: runtime.identity.childCreationTime, sessionId: facts.sessionId, name: facts.name, reconciler: this.#deps.reconciler(),
			brokerMapping: { key: BROKER_SLOTS_KEY, decide: latest => {
				const plan = mapping.planRepointAgainst(latest, fromId, destination.tabId, priorDestinationSlot);
				return plan.ok ? { desired: plan.value } : { refused: plan.reason };
			} },
		});
		if (result.status === "refused") {
			state.controlFailure = result.detail;
			if (result.kind === "conflict") {
				await index.bindEditorSlot(state.slotId, fromId, "passive");
				window.passive(state, fromId, result.detail);
			}
			return;
		}
		mapping.reload();
		identity.forget(fromId);
		window.rebound(state, fromId, destination.tabId, result.binding);
		if (facts.sessionFile !== null && destination.sessionFile === null) await identity.bind(destination.tabId, runtime, facts.sessionFile, facts.sessionId);
		await window.presented(state, runtime, destination.tabId);
		await index.setActiveTab(destination.tabId);
		window.settled(destination.tabId);
	}
}

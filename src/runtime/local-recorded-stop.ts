/**
 * Stopping the recorded host of a row this window does not drive (ADR-0066, cut 7): the Sessions
 * view's Stop of a survivor of an earlier extension host, and the stop of an owned writer a delete or
 * an open must end first when no runtime of this window holds it.
 *
 * The row's durable broker slot is resolved here, losslessly ({@link readBrokerProvenance}), because
 * the index owns the policy and never reads the slot table itself. Every refusal is bounded text;
 * nothing is signalled by pid. The operation takes the tab's gate itself and records what follows a
 * stop that happened (the slot is forgotten, the remembered outcome dropped, the credentials of the
 * recorded owner released).
 */
import type { Logger } from "../shared/logger.ts";
import type { BrokerSlotProvenance, BrokerSlotStore } from "../host/broker-slots.ts";
import type { PtyBrokerClient } from "../host/pty-client.ts";
import { stopBrokerOwnedHost } from "../host/rpc-reconcile.ts";
import type { RecordedHostStopPort, StopRecordedHostResult } from "../host/session-availability.ts";
import type { SessionIndex } from "../host/session-index.ts";
import { isManagedHost } from "../host/session-model.ts";
import { recordedControlOwner } from "./local-control.ts";
import type { LocalWriterVerifier } from "./local-writer.ts";
import type { LocalHostControl } from "./local-control.ts";
import type { StopRecordedOutcome, StopRecordedRequest } from "./session-runtime.ts";

/** What {@link createRecordedHostStopPort} reads of the runtime. */
export interface RecordedHostStopPorts {
	brokerProvenanceFor(tabId: string): BrokerSlotProvenance;
	attachBrokerClient(): Promise<PtyBrokerClient | null>;
	readonly log: Logger;
}

/** What {@link readBrokerProvenance} reads of the window: the slot table and the editor slots a conversation is shown in. */
export interface BrokerProvenanceSources {
	brokerSlots: BrokerSlotStore | undefined;
	slotsForConversation(tabId: string): readonly { readonly role: string; readonly slotId: string }[];
}

/**
 * The broker provenance recorded for one row, without loss.
 *
 * {@link BrokerSlotStore.forConversation} cannot distinguish "this row recorded no
 * slot" from "the mapping could not be read", and both the reconciler's probe and the
 * explicit stop decide whether a writer may exist, so they ask this instead: an
 * unreadable table or entry is uncertainty, never "nothing was launched".
 */
export function readBrokerProvenance(sources: BrokerProvenanceSources, tabId: string): BrokerSlotProvenance {
	if (sources.brokerSlots === undefined) return { kind: "unreadable" };
	const byConversation = sources.brokerSlots.provenanceFor({ conversation: tabId });
	if (byConversation.kind !== "none") return byConversation;
	let unreadable = false;
	for (const binding of sources.slotsForConversation(tabId)) {
		if (binding.role !== "controlling") continue;
		const byEditor = sources.brokerSlots.provenanceFor({ editor: binding.slotId });
		if (byEditor.kind === "slot") return byEditor;
		if (byEditor.kind === "unreadable") unreadable = true;
	}
	return unreadable ? { kind: "unreadable" } : { kind: "none" };
}

/**
 * The transport the index uses to stop a recorded host this window does not run.
 *
 * `expectedBroker` is the broker the caller bound the stop to, when it was shown one: the row's
 * recorded identity must still be it.
 */
export function createRecordedHostStopPort(
	ports: RecordedHostStopPorts,
	expectedSlot: string,
	expectedBroker: { readonly brokerId: string; readonly brokerGeneration: string } | null = null,
): RecordedHostStopPort {
	return {
		async stopRecordedHost(entry) {
			const provenance = ports.brokerProvenanceFor(entry.tabId);
			const recordedRpc = entry.host !== null && isManagedHost(entry.host) ? entry.host.rpc ?? null : null;
			if (
				(provenance.kind === "slot" && provenance.slot !== expectedSlot) ||
				(expectedBroker !== null && (recordedRpc === null || recordedRpc.brokerId !== expectedBroker.brokerId || recordedRpc.brokerGeneration !== expectedBroker.brokerGeneration))
			) {
				return {
					kind: "unknown",
					detail:
						"This session changed while the confirmation was open. Nothing was stopped; try Stop again.",
				};
			}
			if (provenance.kind === "unreadable") {
				return {
					kind: "unknown",
					detail: "This session's connection details could not be read. Refresh Sessions and try again.",
				};
			}
			if (provenance.kind === "none") {
				return {
					kind: "unknown",
					detail:
						"This session's connection details are missing. Reopen its editor and try Stop again.",
				};
			}
			const client = await ports.attachBrokerClient();
			if (client === null) {
				return { kind: "unknown", detail: "This session is disconnected. Reopen its editor and try Stop again." };
			}
			if (entry.host?.transport === "native") {
				return { kind: "unknown", detail: "Stop this session from its Terminal editor, or use /exit there." };
			}
			const stopped = await stopBrokerOwnedHost({
				client,
				slot: provenance.slot,
				recordedPid: entry.host?.pid ?? null,
				expected: entry.host !== null && isManagedHost(entry.host) ? (entry.host.rpc ?? null) : null,
			});
			if (!stopped.ok) {
				ports.log.warn(`recorded host stop ${entry.tabId}: ${stopped.reason}`);
				return {
					kind: "unknown",
					// A refusal that never dispatched proves nothing was stopped. One that did is
					// unconfirmed: the recorded process may have stopped or may still be running.
					detail: stopped.dispatched
						? "The session could not be confirmed stopped. Refresh Sessions before resuming; see OMP Desk output for details."
						: "This window could not reach the session safely. Nothing was stopped; refresh Sessions and try again.",
				};
			}
			ports.log.info(`recorded host stop ${entry.tabId}: ${stopped.verdict.diagnosticDetail ?? stopped.verdict.detail}`);
			return {
				kind: "stopped",
				writerGone: stopped.verdict.writerGone,
				treeEmpty: stopped.verdict.treeEmpty,
				detail: stopped.verdict.detail,
				slot: provenance.slot,
			};
		},
	};
}

/** What the recorded stop shows of itself to its window. */
export interface RecordedStopWindow {
	/** The window's remembered restore outcome of a conversation described a host that is stopped now. */
	forgetOutcome(conversation: string): void;
}

export interface LocalRecordedStopDeps {
	readonly index: SessionIndex;
	readonly window: RecordedStopWindow;
	readonly control: Pick<LocalHostControl, "release">;
	/** The writer check of a stop that must still find the pid its caller verified. */
	readonly writer: Pick<LocalWriterVerifier, "pid">;
	/** The durable broker slot table, `undefined` before activation created it. */
	readonly brokerSlots: () => BrokerSlotStore | undefined;
	/** The transport the index stops the recorded host through; the runtime's own unless a test supplies one. */
	readonly stopPort: (slot: string, expectedBroker: { readonly brokerId: string; readonly brokerGeneration: string } | null) => RecordedHostStopPort;
}

/** What `LocalSessionRuntime` delegates `stopRecorded` to. */
export interface RecordedStopOperations {
	stopRecorded(request: StopRecordedRequest): Promise<StopRecordedOutcome>;
}

export class LocalRecordedStop implements RecordedStopOperations {
	readonly #deps: LocalRecordedStopDeps;

	constructor(deps: LocalRecordedStopDeps) {
		this.#deps = deps;
	}

	/**
	 * Stop the exact recorded host a confirmation named, under the tab's gate. The index re-reads the
	 * row under that gate and refuses when it now records another attempt or broker, and takes a
	 * temporary claim unless a live rival holds one; a stop that happened retires the slot and the
	 * credentials before a queued Resume can provision a replacement, and uncertainty deletes nothing.
	 */
	stopRecorded(request: StopRecordedRequest): Promise<StopRecordedOutcome> {
		const { index, window, control, writer } = this.#deps;
		return index.lifecycle.run(request.conversation, async (lease): Promise<StopRecordedOutcome> => {
			if (request.expectedWriter !== undefined) {
				const current = await writer.pid(request.conversation);
				if (current === null) return { kind: "writer-gone" };
				if (current !== request.expectedWriter.pid) return { kind: "writer-changed" };
			}
			const entry = index.get(request.conversation);
			const result: StopRecordedHostResult = await index.stopRecordedHost(request.conversation, {
				stop: this.#deps.stopPort(request.slot, request.broker),
				expect: request.expect,
			}, lease);
			if (result.stopped) {
				if (result.slot !== null) await this.#deps.brokerSlots()?.forget(result.slot).catch(() => undefined);
				window.forgetOutcome(request.conversation);
				await control.release(request.conversation, entry === null ? null : recordedControlOwner(entry));
			}
			return { kind: "result", result };
		});
	}
}

/**
 * Conversation identity for the in-process runtime (ADR-0066, cut 5): bind a new conversation to
 * the exact session file its process reported.
 *
 * The process learned the path from `get_state.sessionFile`: it is the identity of the
 * conversation, so the draft row is promoted to it (keeping the tab) under the tab's lifecycle
 * gate, and a resumed session whose reported file differs was already refused by the chat session
 * itself. OMP writes the file lazily (first message), so the exact path is remembered and bound
 * as soon as the file exists.
 */
import type { Logger } from "../shared/logger.ts";
import type { ContinuationProof } from "../host/session-chain.ts";
import { controlPathEquals } from "../wire/control-protocol.ts";
import type { SessionHostRuntime } from "../host/native-session.ts";
import type { SessionIndex } from "../host/session-index.ts";
import type { RuntimeRecord, RuntimeRecords } from "./runtime-record.ts";

const IDENTITY_RETRY_MS = 750;

/** New sessions whose exact file is known but not written yet, by tab. */
interface PendingIdentity {
	readonly runtime: SessionHostRuntime;
	readonly sessionFile: string;
	readonly sessionId: string;
	lastFailureDetail: string;
	lastTry: number;
	timer: NodeJS.Timeout | null;
}

/** What identity binding asks of its window; in-process only (design §2.5). */
export interface IdentityWindow {
	/** The conversation was bound to its file: refresh its tab appearance and commit the document the file now allows. */
	bound(conversation: string): void;
	/** The tab's process serves a conversation another one owns: show it, with the reason and the way out. */
	conflict(conversation: string, detail: string): void;
	/** The catalogue of sessions changed. */
	refresh(): void;
}

export interface LocalIdentityDeps {
	readonly index: SessionIndex;
	readonly window: IdentityWindow;
	readonly records: RuntimeRecords;
	readonly log: Logger;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class LocalIdentity {
	readonly #deps: LocalIdentityDeps;
	readonly #pending = new Map<string, PendingIdentity>();

	constructor(deps: LocalIdentityDeps) {
		this.#deps = deps;
	}

	/** Forget a conversation's retry chain (its native session moved to another row). */
	forget(conversation: string): void {
		this.#pending.delete(conversation);
	}

	/** Bind a conversation to the exact file its process reported; `previousSessionId` is set for an accepted provider identity change. */
	async bind(
		tabId: string,
		runtime: SessionHostRuntime,
		sessionFile: string,
		sessionId: string,
		previousSessionId?: string,
	): Promise<void> {
		const { index, window, log } = this.#deps;
		await index.lifecycle.run(tabId, async lease => {
			const current = this.#deps.records.get(tabId);
			if (current === undefined || current.runtime !== runtime) return;
			// The id is recorded the moment it is known — a new session's file does not exist until its
			// first message, but a re-adopt after any restart needs the id to tell this session from a switch.
			const recorded = await index.recordHostSessionId(tabId, sessionId, lease, previousSessionId);
			if (!recorded) log.warn(`tab ${tabId}: the session id ${sessionId} conflicts with the one this row recorded and was not recorded`);
			if (!recorded && previousSessionId !== undefined) throw new Error("Accepted provider identity could not be recorded.");
			const entry = index.get(tabId);
			if (entry === null || entry.sessionFile !== null) return;
			const pending = this.#pending.get(tabId);
			// Repeated native snapshots report the same allocated path before OMP writes it.
			// Keep its retry chain: restarting binding would also invalidate every in-flight
			// Sessions projection even though no conversation state changed.
			if (pending?.runtime === runtime && pending.sessionId === sessionId &&
				(pending.sessionFile === sessionFile || controlPathEquals(pending.sessionFile, sessionFile))) return;
			clearTimeout(pending?.timer ?? undefined);
			const promotion = await index.promoteDraft(tabId, sessionFile, lease);
			if (promotion.status === "promoted") {
				this.#pending.delete(tabId);
				log.info(`tab ${tabId}: bound to the session file ${sessionFile}`);
				// The document could not be committed while the session had no file: the binding a
				// surviving page authenticates against needs the exact file, so it is committed now.
				window.bound(tabId);
			} else {
				// OMP creates the file lazily (first message), so the exact path is remembered and bound as
				// soon as the file exists.
				this.#pending.set(tabId, { runtime, sessionFile, sessionId, lastTry: Date.now(), timer: null, lastFailureDetail: promotion.detail });
				this.#scheduleRetry(tabId);
				if (promotion.status === "claim-conflict") this.#reportConflict(tabId, sessionFile, promotion.detail);
				else log.debug(`tab ${tabId}: the session file ${sessionFile} is not bound yet: ${promotion.detail}`);
			}
			window.refresh();
		});
	}

	/**
	 * Make the row of a conversation follow it into the newer file OMP serves (a session continuation, OMP 18.13): the
	 * process proved by the caller reports a file and an id that continue the ones the row records, and the index records
	 * them under the tab's gate, re-proving the chain itself. `false` when the catalog refused (another row or window
	 * holds the new file, the row records something else); the tab then says why and the conversation stays as it was.
	 */
	async bindContinuation(tabId: string, runtime: SessionHostRuntime, proof: ContinuationProof): Promise<boolean> {
		const { index, window, log } = this.#deps;
		return await index.lifecycle.run(tabId, async lease => {
			const current = this.#deps.records.get(tabId);
			if (current === undefined || current.runtime !== runtime) return false;
			const accepted = await index.acceptContinuation(tabId, proof, lease);
			if (accepted.status === "refused") {
				log.warn(`tab ${tabId}: the conversation went on in ${proof.toFile}, but the row was not moved: ${accepted.detail}`);
				window.conflict(tabId, `This session went on in a newer file, which could not be recorded: ${accepted.detail}`);
				return false;
			}
			// The document a page authenticates against names the file and the id: it is committed again for the new pair.
			window.bound(tabId);
			window.refresh();
			return true;
		});
	}

	/**
	 * Keep trying to bind a pending new session until OMP has written its file.
	 *
	 * OMP writes the file lazily, a moment *after* the turn's events have gone by, so retrying
	 * only when an event arrives can miss the write entirely: the last event of a turn lands
	 * before the file exists and nothing else follows. A row left unbound has no session file,
	 * which a later restart cannot re-adopt. The chain stops the moment the row is bound, the
	 * conversation's process changes, or the pending entry is replaced.
	 */
	#scheduleRetry(tabId: string): void {
		const pending = this.#pending.get(tabId);
		if (pending === undefined || pending.timer !== null) return;
		const timer = setTimeout(() => {
			pending.timer = null;
			void this.retry(tabId).finally(() => {
				if (this.#pending.get(tabId) === pending) this.#scheduleRetry(tabId);
			});
		}, IDENTITY_RETRY_MS);
		timer.unref?.();
		pending.timer = timer;
	}

	/** Bind a pending new session to its file once OMP has written it; also called on conversation activity. */
	retry(tabId: string): Promise<void> {
		const { index, window, log } = this.#deps;
		const pending = this.#pending.get(tabId);
		if (pending === undefined || Date.now() - pending.lastTry < IDENTITY_RETRY_MS) return Promise.resolve();
		if (this.#deps.records.get(tabId)?.runtime !== pending.runtime || index.get(tabId)?.sessionFile !== null) {
			clearTimeout(pending.timer ?? undefined);
			this.#pending.delete(tabId);
			return Promise.resolve();
		}
		pending.lastTry = Date.now();
		return index.lifecycle
			.run(tabId, async lease => {
				if (this.#deps.records.get(tabId)?.runtime !== pending.runtime || this.#pending.get(tabId) !== pending) return;
				const promotion = await index.promoteDraft(tabId, pending.sessionFile, lease);
				if (promotion.status !== "promoted") {
					if (promotion.detail !== pending.lastFailureDetail) {
						pending.lastFailureDetail = promotion.detail;
						if (promotion.status === "claim-conflict") this.#reportConflict(tabId, pending.sessionFile, promotion.detail);
						else log.debug(`tab ${tabId}: the session file ${pending.sessionFile} is not bound yet: ${promotion.detail}`);
					}
					return;
				}
				clearTimeout(pending.timer ?? undefined);
				this.#pending.delete(tabId);
				log.info(`tab ${tabId}: bound to the session file ${pending.sessionFile}`);
				window.bound(tabId);
				window.refresh();
			})
			.catch(error => log.warn(`tab ${tabId}: binding the session file failed: ${messageOf(error)}`));
	}

	/**
	 * The session file this tab's process serves is claimed by another conversation (a re-adopted draft whose process
	 * turns out to serve another session). The tab says so with a way out, once per distinct reason, and keeps its retry
	 * chain: when that conversation closes and releases its claim, this live writer is the file's owner and binds.
	 */
	#reportConflict(tabId: string, sessionFile: string, detail: string): void {
		const { window, log } = this.#deps;
		log.error(`tab ${tabId}: its OMP process serves ${sessionFile}, which another conversation owns: ${detail}`);
		window.conflict(tabId, `${detail} This tab's OMP process serves that conversation, so it is not bound; it binds once that conversation closes, or use Stop or Kill on it in Sessions.`);
	}
}

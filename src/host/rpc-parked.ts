/**
 * Connections the startup restore pass keeps between a row's reconcile and its attach.
 *
 * A reconcile of a `managed-rpc` row proves the broker over an authenticated connection and then used to close it; the
 * attach that follows opened another one and repeated the handshake, the status and the identity checks. After a reload
 * that doubled the pipe work of every restored tab (each connect a few hundred milliseconds when the host's loop is busy).
 * For the restore pass only, a reconcile whose verdict is `attachable` parks its connection here under the pin it proved,
 * and the attach takes it (`attachRpcHost`), asks it a *new* `status`, and runs every proof it always ran.
 *
 * What is kept is the authenticated socket, never a proof: every frame on it is sequence-numbered and MAC'd with the session
 * key derived from the record's token, a replaced broker closes it, and the attach still refuses unless a status answered
 * now, the child identity wait, the broker's identity confirmation and the pin proof all agree with the pin. A parked
 * connection that is closed, past its time limit, under a different pin or not claimed before the pass ends is closed
 * and the attach opens its own, so nothing here can make an attach succeed that a fresh one would refuse.
 *
 * One store serves one pass. It is `ended` by {@link ParkedRpcConnections.release}, which closes everything still parked,
 * and a connection offered after that is closed at once.
 */
import { sameAttachPin } from "./session-availability.ts";
import type { AttachPin } from "./session-availability.ts";

/** How long a connection may stay parked before it is closed; far above a row's reconcile-to-attach gap, far below a pass. */
export const PARKED_RPC_TTL_MS = 30_000;

/** What the store needs of a parked connection: a way to close it and, when known, whether the socket already closed. */
export interface ParkedConnection {
	readonly closed?: boolean;
	disconnect(): void;
}

interface Parked {
	readonly pin: AttachPin;
	readonly connection: ParkedConnection;
	readonly timer: NodeJS.Timeout;
}

export class ParkedRpcConnections {
	readonly #ttlMs: number;
	readonly #parked = new Map<string, Parked>();
	#ended = false;

	constructor(options: { readonly ttlMs?: number } = {}) {
		this.#ttlMs = options.ttlMs ?? PARKED_RPC_TTL_MS;
	}

	/** Connections parked right now. */
	get size(): number {
		return this.#parked.size;
	}

	/**
	 * Keep `connection` for the attach that follows, under the pin it proved. Returns whether the store took it: a store whose
	 * pass ended, or a connection that already closed, is not kept (and the connection is closed). A connection already parked
	 * for the same slot is closed and replaced: one slot has one broker, and the newer proof is the one a later attach checks.
	 */
	park(pin: AttachPin, connection: ParkedConnection): boolean {
		if (this.#ended || connection.closed === true) {
			connection.disconnect();
			return false;
		}
		const earlier = this.#parked.get(pin.slot);
		if (earlier !== undefined) this.#drop(pin.slot, earlier);
		const timer = setTimeout(() => {
			const current = this.#parked.get(pin.slot);
			if (current !== undefined && current.connection === connection) this.#drop(pin.slot, current);
		}, this.#ttlMs);
		timer.unref();
		this.#parked.set(pin.slot, { pin, connection, timer });
		return true;
	}

	/**
	 * Claim the connection parked for exactly this pin, or `null`. The connection leaves the store either way; one that is
	 * closed, or parked under another pin (the slot named another broker or child by then), is closed here and not returned.
	 */
	take(pin: AttachPin): ParkedConnection | null {
		const parked = this.#parked.get(pin.slot);
		if (parked === undefined) return null;
		this.#parked.delete(pin.slot);
		clearTimeout(parked.timer);
		if (!sameAttachPin(parked.pin, pin) || parked.connection.closed === true) {
			parked.connection.disconnect();
			return null;
		}
		return parked.connection;
	}

	/** End the pass's use of the store: close every connection still parked and refuse any later one. Returns how many were closed. */
	release(): number {
		this.#ended = true;
		let closed = 0;
		for (const [slot, parked] of [...this.#parked]) {
			this.#drop(slot, parked);
			closed += 1;
		}
		return closed;
	}

	#drop(slot: string, parked: Parked): void {
		this.#parked.delete(slot);
		clearTimeout(parked.timer);
		parked.connection.disconnect();
	}
}

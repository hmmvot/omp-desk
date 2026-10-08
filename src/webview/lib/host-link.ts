/**
 * Whether this page can still trust that a host is listening to it.
 *
 * A page hands its chat commands to the panel route (`postMessage`) or to the bridge.
 * `postMessage` cannot tell a live extension host from a dead one: after a host-only
 * restart the panel handle the page was talking to is gone, the call still returns, and the
 * command vanishes. The bridge socket is the only channel that notices — it drops when the
 * host dies — so once a connection that was up has been lost, chat commands are refused
 * (and the composer keeps the draft and says why) until a connection is up again.
 *
 * Nothing here is set before the first connection: a page whose bridge has not come up yet
 * (a fresh document, or one that never received a secret) is not "lost", and its panel route
 * is trusted as before.
 */
export class HostLink {
	#lost = false;

	/** The bridge socket became usable (`true`) or a usable one dropped (`false`). */
	noteConnection(connected: boolean): void {
		this.#lost = !connected;
	}

	/** An established host connection was lost and has not recovered. */
	get lost(): boolean {
		return this.#lost;
	}

	/** Whether a message of this type must not be handed to any route right now. */
	refuses(type: string): boolean {
		return this.#lost && type.startsWith("omp:chat-");
	}
}

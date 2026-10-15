/**
 * One lane for Win32 calls that run on koffi's worker threads (ADR-0076, decision 5).
 *
 * Those calls run on libuv's thread pool, which every extension in the extension host shares (four
 * threads by default), and a Win32 call cannot be cancelled: a `GetNamedSecurityInfoW` on a hung
 * path, or a `LookupAccountSidW` waiting for an unreachable domain controller, holds its thread
 * until it returns. So Desk keeps at most one such call in flight and queues the rest.
 *
 * Every request carries a deadline counted from the request. A request that misses it settles with
 * its own "unknown" answer, and a call already running keeps the lane until it returns, so a later
 * request answers "unknown" at its own deadline instead of starting a second pool call. A request
 * whose deadline passed before its turn is never started.
 */
export class CallLane {
	#tail: Promise<void> = Promise.resolve();

	/**
	 * Run `call` when the lane is free. `call` receives an `isExpired` probe, so a multi-step call can stop
	 * between steps once nobody is waiting for it. Settles with `call`'s result, or with `onExpired()` at the
	 * deadline, whichever comes first.
	 */
	run<T>(call: (isExpired: () => boolean) => Promise<T>, deadlineMs: number, onExpired: () => T): Promise<T> {
		const result = Promise.withResolvers<T>();
		let expired = false;
		const timer = setTimeout(() => {
			expired = true;
			result.resolve(onExpired());
		}, deadlineMs);
		timer.unref();
		const isExpired = (): boolean => expired;
		this.#tail = this.#tail.then(async () => {
			if (expired) return;
			try {
				const value = await call(isExpired);
				if (!expired) result.resolve(value);
			} catch (error) {
				if (!expired) result.reject(error);
			} finally {
				clearTimeout(timer);
			}
		});
		return result.promise;
	}
}

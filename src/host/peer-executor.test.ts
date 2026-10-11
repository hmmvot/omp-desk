/**
 * The proof that a window's extension host ended (ADR-0060): a request that may still be served is given up on only
 * when the exact process identified when the window was asked is positively gone.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { identifyPeerExecutor, proveExecutorGone } from "./peer-executor.ts";
import type { PeerExecutorProbe } from "./peer-executor.ts";
import type { PtyGoneReading, PtyIdentityReading } from "./pty-identity.ts";

function probe(options: { readonly read?: PtyIdentityReading | Error; readonly gone?: PtyGoneReading | Error } = {}): PeerExecutorProbe & { readonly waited: Array<{ pid: number; creationTime: string; timeoutMs: number }> } {
	const waited: Array<{ pid: number; creationTime: string; timeoutMs: number }> = [];
	return {
		waited,
		read: async () => {
			const reading = options.read ?? { kind: "found", creationTime: "13434942101430001" };
			if (reading instanceof Error) throw reading;
			return reading;
		},
		waitGone: async (pid, creationTime, timeoutMs) => {
			waited.push({ pid, creationTime, timeoutMs });
			const reading = options.gone ?? { gone: false, detail: "the process is still alive after 3000ms" };
			if (reading instanceof Error) throw reading;
			return reading;
		},
	};
}

describe("identifying a window's executor", () => {
	it("records the host's process id with the creation time the kernel reports", async () => {
		assert.deepEqual(await identifyPeerExecutor(4242, probe()), { pid: 4242, creationTime: "13434942101430001" });
	});

	it("records nothing when the host cannot be identified: a process that was never identified can never be proven gone", async () => {
		assert.equal(await identifyPeerExecutor(null, probe()), null, "the record names no host");
		assert.equal(await identifyPeerExecutor(4242, null), null, "no probe helper");
		assert.equal(await identifyPeerExecutor(4242, probe({ read: { kind: "gone" } })), null);
		assert.equal(await identifyPeerExecutor(4242, probe({ read: { kind: "unknown", detail: "timed out" } })), null);
		assert.equal(await identifyPeerExecutor(4242, probe({ read: new Error("helper crashed") })), null);
	});
});

describe("proving a window's executor gone", () => {
	const peer = { executor: { pid: 4242, creationTime: "13434942101430001" } } as const;

	it("asks the kernel about exactly the identified process, and is positive only when the kernel says it is gone", async () => {
		const gone = probe({ gone: { gone: true, detail: "the process id was reused by a different process" } });
		assert.deepEqual(await proveExecutorGone(peer, gone, 1_000), { gone: true, detail: "the process id was reused by a different process" });
		assert.deepEqual(gone.waited, [{ pid: 4242, creationTime: "13434942101430001", timeoutMs: 1_000 }]);
		const alive = probe();
		assert.equal((await proveExecutorGone(peer, alive, 1_000)).gone, false);
	});

	it("never calls a window gone on anything but that proof", async () => {
		const noProbe = await proveExecutorGone(peer, null);
		assert.equal(noProbe.gone, false);
		const unidentified = probe({ gone: { gone: true, detail: "x" } });
		assert.equal((await proveExecutorGone({ executor: null }, unidentified)).gone, false, "a host that was never identified");
		assert.deepEqual(unidentified.waited, [], "and the kernel is not even asked");
		const failing = await proveExecutorGone(peer, probe({ gone: new Error("the helper stopped") }));
		assert.equal(failing.gone, false);
		assert.match(failing.detail, /the process probe failed: the helper stopped/);
	});
});

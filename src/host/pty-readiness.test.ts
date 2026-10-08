/**
 * The window-level policy over `PtyBrokerClient.ready()`.
 *
 * What is worth defending here is the difference between latching success and latching
 * failure: a proven runtime may be kept for the whole activation, but a failed check
 * must stay retryable, because the client's own contract says a failure is usually a
 * staging pass that has not finished. Latching it is what left a surviving broker
 * unadoptable after a full VS Code restart. The tests below cover the retry, the single
 * shared attempt, the success latch and the bounded retry window.
 *
 * Runner: `node --test src/host/pty-readiness.test.ts`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PTY_READINESS_RETRY_MS, createPtyReadinessGate } from "./pty-readiness.ts";
import type { PtyReadinessGate } from "./pty-readiness.ts";
import type { PtyBrokerClient } from "./pty-client.ts";

/** One `ready()` answer the fake client replays, or a check that throws. */
type ReadinessAnswer = { readonly ready: boolean; readonly reason?: string | null } | "throw";

interface FakeReadiness {
	readonly gate: PtyReadinessGate;
	readonly client: PtyBrokerClient;
	readonly calls: () => number;
	readonly failures: readonly string[];
}

/**
 * A gate over a client whose readiness the test decides, one answer per `ready()` call.
 *
 * The last answer is replayed for any further call, so a test states the sequence it
 * cares about and nothing else.
 */
function gateWith(answers: readonly ReadinessAnswer[], options: { readonly retryMs?: number } = {}): FakeReadiness {
	let calls = 0;
	const client = {
		ready: async () => {
			const answer = answers[Math.min(calls, answers.length - 1)];
			calls += 1;
			if (answer === "throw") throw new Error("the staged runtime could not be checked");
			return { ready: answer.ready, reason: answer.reason ?? null };
		},
	} as unknown as PtyBrokerClient;
	const failures: string[] = [];
	const gate = createPtyReadinessGate({
		client,
		onFailure: reason => failures.push(reason),
		...(options.retryMs === undefined ? {} : { retryMs: options.retryMs }),
	});
	return { gate, client, calls: () => calls, failures };
}

describe("broker readiness gate", () => {
	it("keeps a transient failure retryable instead of latching it for the activation", async () => {
		const { gate, client, calls, failures } = gateWith(
			[
				{ ready: false, reason: "the runtime self-check failed with exit code 7" },
				{ ready: true, reason: null },
			],
			{ retryMs: 0 },
		);

		assert.equal(await gate.client(), null, "a failed check never yields the client");
		assert.match(gate.reason() ?? "", /exit code 7/);
		assert.deepEqual(failures, ["the runtime self-check failed with exit code 7"]);

		// The next caller — the next row, click, recheck or attach — retries.
		assert.equal(await gate.client(), client);
		assert.equal(calls(), 2);
		assert.equal(gate.reason(), null, "a proven runtime stops reporting a reason");
	});

	it("retries a thrown check rather than latching it", async () => {
		const { gate, client, calls } = gateWith(["throw", { ready: true }], { retryMs: 0 });

		assert.equal(await gate.client(), null);
		assert.match(gate.reason() ?? "", /could not be checked/);
		assert.equal(await gate.client(), client);
		assert.equal(calls(), 2);
	});

	it("holds a failure for the retry window, so one pass cannot stage per row", async () => {
		let clock = 1_000;
		const answers: Array<{ readonly ready: boolean; readonly reason?: string | null }> = [
			{ ready: false, reason: "staging is not finished" },
			{ ready: true },
		];
		let calls = 0;
		const client = {
			ready: async () => {
				const answer = answers[Math.min(calls, answers.length - 1)];
				calls += 1;
				return { ready: answer.ready, reason: answer.reason ?? null };
			},
		} as unknown as PtyBrokerClient;
		const gate = createPtyReadinessGate({ client, retryMs: PTY_READINESS_RETRY_MS, now: () => clock });

		assert.equal(await gate.client(), null);
		// Every other row of the same pass gets the same answer without another attempt.
		assert.equal(await gate.client(), null);
		assert.equal(await gate.client(), null);
		assert.equal(calls, 1);
		assert.match(gate.reason() ?? "", /staging is not finished/, "the reason is kept for the caller that reports it");

		// Past the window the next caller checks again, and can now succeed.
		clock += PTY_READINESS_RETRY_MS;
		assert.equal(await gate.client(), client);
		assert.equal(calls, 2);
	});

	it("stages once and keeps the proven runtime for the rest of the activation", async () => {
		const { gate, client, calls } = gateWith([{ ready: true }]);

		assert.equal(await gate.client(), client);
		assert.equal(await gate.client(), client);
		assert.equal(calls(), 1, "a proven runtime is never staged twice");
	});

	it("retries immediately when a caller asks to recheck", async () => {
		const { gate, client, calls } = gateWith(
			[
				{ ready: false, reason: "the runtime self-check failed with exit code 7" },
				{ ready: true },
			],
			{ retryMs: PTY_READINESS_RETRY_MS },
		);

		assert.equal(await gate.client(), null);
		// An explicit open must not be answered from the background pass's backoff: the
		// next call here would otherwise return null without checking at all.
		gate.invalidate();
		assert.equal(await gate.client(), client);
		assert.equal(calls(), 2);
		assert.equal(await gate.client(), client, "and a proven runtime stays proven");
		assert.equal(calls(), 2);
	});

	it("shares one attempt between callers that arrive together", async () => {
		let calls = 0;
		const settle = Promise.withResolvers<{ readonly ready: boolean; readonly reason: null }>();
		const client = {
			ready: () => {
				calls += 1;
				return settle.promise;
			},
		} as unknown as PtyBrokerClient;
		const gate = createPtyReadinessGate({ client });

		const first = gate.client();
		const second = gate.client();
		settle.resolve({ ready: true, reason: null });

		assert.equal(await first, client);
		assert.equal(await second, client);
		assert.equal(calls, 1, "concurrent callers share one readiness check");
	});
});

describe("attach readiness in the gate", () => {
	it("re-adopts a broker while the runtime proof is still running, and never waits for it", async () => {
		const proof = Promise.withResolvers<{ readonly ready: boolean; readonly reason: null }>();
		let attachCalls = 0;
		const client = {
			ready: () => proof.promise,
			attachReady: async () => {
				attachCalls += 1;
				return { ready: true, reason: null, helper: { path: "probe.ps1", sha256: "x" } };
			},
		} as unknown as PtyBrokerClient;
		const gate = createPtyReadinessGate({ client });

		const launching = gate.client();
		assert.equal(await gate.attachClient(), client, "the attach is answered while the full proof is pending");
		assert.equal(await gate.attachClient(), client);
		assert.equal(attachCalls, 1, "a proven probe is kept");

		proof.resolve({ ready: true, reason: null });
		assert.equal(await launching, client);
	});

	it("keeps a failed identity probe retryable after the bounded window, and reports why", async () => {
		let time = 1_000;
		let calls = 0;
		const failures: string[] = [];
		const client = {
			ready: async () => ({ ready: false, reason: "not used" }),
			attachReady: async () => {
				calls += 1;
				return calls === 1
					? { ready: false, reason: "the identity probe could not be staged", helper: null }
					: { ready: true, reason: null, helper: { path: "probe.ps1", sha256: "x" } };
			},
		} as unknown as PtyBrokerClient;
		const gate = createPtyReadinessGate({ client, onFailure: reason => failures.push(reason), now: () => time });

		assert.equal(await gate.attachClient(), null);
		assert.deepEqual(failures, ["the identity probe could not be staged"]);
		assert.equal(await gate.attachClient(), null, "inside the retry window a pass over many rows does not retry per row");
		assert.equal(calls, 1);

		time += PTY_READINESS_RETRY_MS;
		assert.equal(await gate.attachClient(), client);
		assert.equal(calls, 2);
	});
});

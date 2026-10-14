/**
 * The proof state over a probe that can come back inconclusive.
 *
 * The regression these defend: starting a session while the CPU was saturated failed with
 * `the runtime self-check failed with exit code 7: the pipe child did not finish within
 * the self-check deadline`. A slow probe was read as a broken runtime. The tests drive
 * the state machine with a fake clock and a fake scheduler, so the timing is exact and
 * nothing waits in real time.
 *
 * Runner: `node --test src/host/pty-runtime-proof.test.ts`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SELF_CHECK_EXTENDED_DEADLINE_MS } from "../broker/pty-self-check.ts";
import { recordingLogger, type LoggedLine } from "../shared/logger.ts";
import { PTY_FAULT_HOLD_MS, PTY_REPROBE_DELAY_MS, PtyRuntimeProof } from "./pty-runtime-proof.ts";
import type { PtyRuntimeReadiness } from "./pty-runtime.ts";

const base = { platform: "win32", runtimeVersion: 2, treeDigest: "d".repeat(64), runtime: null } as const;
const proven: PtyRuntimeReadiness = { ...base, ready: true, proven: true, reason: null };
const unproven: PtyRuntimeReadiness = {
	...base,
	ready: true,
	proven: false,
	reason: "the pipe child did not finish within the self-check deadline of 15 s; no fault was observed",
};
const refused: PtyRuntimeReadiness = {
	...base,
	ready: false,
	proven: false,
	reason: "the runtime self-check failed with exit code 7: the self-check child exited with code 3",
};

/** A fake clock whose scheduled work runs only when the test advances it. */
class FakeClock {
	time = 1_000_000;
	private readonly queue: { at: number; run: () => void; cancelled: boolean }[] = [];
	readonly now = (): number => this.time;
	readonly schedule = (run: () => void, delayMs: number): (() => void) => {
		const entry = { at: this.time + delayMs, run, cancelled: false };
		this.queue.push(entry);
		return () => {
			entry.cancelled = true;
		};
	};
	pending(): number {
		return this.queue.filter(entry => !entry.cancelled).length;
	}
	/** Move time forward, running what became due in order, and let its async work settle. */
	async advance(ms: number): Promise<void> {
		const target = this.time + ms;
		for (;;) {
			const due = this.queue.filter(entry => !entry.cancelled && entry.at <= target).sort((a, b) => a.at - b.at)[0];
			if (due === undefined) break;
			this.queue.splice(this.queue.indexOf(due), 1);
			this.time = due.at;
			due.run();
			const settled = Promise.withResolvers<void>();
			setImmediate(settled.resolve);
			await settled.promise;
		}
		this.time = target;
	}
}

interface Harness {
	readonly proof: PtyRuntimeProof;
	readonly clock: FakeClock;
	/** The deadline each probe was asked for, in order; `undefined` is the default. */
	readonly deadlines: (number | undefined)[];
	readonly logs: LoggedLine[];
}

/** A proof over probes that answer from `answers` in order, the last replayed. */
function harness(answers: readonly (PtyRuntimeReadiness | "throw")[]): Harness {
	const clock = new FakeClock();
	const deadlines: (number | undefined)[] = [];
	const logs: LoggedLine[] = [];
	const proof = new PtyRuntimeProof({
		probe: async deadlineMs => {
			const answer = answers[Math.min(deadlines.length, answers.length - 1)]!;
			deadlines.push(deadlineMs);
			if (answer === "throw") throw new Error("the staged runtime could not be checked");
			return answer;
		},
		log: recordingLogger(logs),
		now: clock.now,
		schedule: clock.schedule,
	});
	return { proof, clock, deadlines, logs };
}

const text = (lines: readonly LoggedLine[]): string => lines.map(line => line.message).join("\n");

describe("PtyRuntimeProof", () => {
	it("keeps a proven runtime and never probes again", async () => {
		const { proof, deadlines, clock } = harness([proven]);
		assert.equal(await proof.ready(), proven);
		assert.equal(await proof.ready(), proven);
		assert.equal(proof.provenAnswer(), proven);
		assert.deepEqual(deadlines, [undefined]);
		assert.equal(clock.pending(), 0, "a proof needs no re-run");
	});

	it("logs a proof reused from an earlier window apart from one it computed", async () => {
		const reused: PtyRuntimeReadiness = { ...proven, reusedProof: { provedAt: "2026-10-13T08:12:03.000Z", file: "proof.json" } };
		const fromDisk = harness([reused]);
		assert.equal(await fromDisk.proof.ready(), reused);
		assert.match(text(fromDisk.logs), /PTY runtime proof reused from 2026-10-13T08:12:03\.000Z/);
		assert.doesNotMatch(text(fromDisk.logs), /proved itself/);
		assert.equal(fromDisk.proof.provenAnswer(), reused, "a reused proof is a proof");

		const computed = harness([proven]);
		await computed.proof.ready();
		assert.match(text(computed.logs), /PTY runtime proved itself/);
		assert.doesNotMatch(text(computed.logs), /reused from/);
		assert.deepEqual(computed.logs.map(line => line.level), ["info"]);
	});

	it("withdraws a reused proof so the next ready() probes again, and leaves a computed proof alone", async () => {
		const reused: PtyRuntimeReadiness = { ...proven, reusedProof: { provedAt: "2026-10-13T08:12:03.000Z", file: "proof.json" } };
		const fromDisk = harness([reused, proven]);
		assert.equal(await fromDisk.proof.ready(), reused);
		assert.deepEqual(fromDisk.proof.discardReusedProof(), reused.reusedProof);
		assert.equal(fromDisk.proof.provenAnswer(), null, "nothing is believed any more");
		assert.equal(await fromDisk.proof.ready(), proven, "the next launch runs the whole probe");
		assert.deepEqual(fromDisk.deadlines, [undefined, undefined]);
		assert.equal(fromDisk.proof.discardReusedProof(), null, "a proof computed here is not withdrawn");
		assert.equal(fromDisk.proof.provenAnswer(), proven);
	});

	it("lets the launch proceed on an inconclusive probe instead of failing it", async () => {
		const { proof, deadlines, logs } = harness([unproven]);
		const readiness = await proof.ready();
		assert.equal(readiness.ready, true, "a slow probe is not a failed launch");
		assert.equal(readiness.proven, false);
		assert.equal(proof.provenAnswer(), null, "and it is not recorded as a proof");
		// Later callers are answered from the provisional state: no second probe on the launch path.
		assert.equal((await proof.ready()).proven, false);
		assert.deepEqual(deadlines, [undefined]);
		assert.match(text(logs), /admitted unproven/);
		assert.equal(logs[0]?.level, "warn");
	});

	it("re-runs the probe with the extended deadline after the delay, not before", async () => {
		const { proof, deadlines, clock } = harness([unproven, proven]);
		await proof.ready();
		assert.equal(clock.pending(), 1);

		await clock.advance(PTY_REPROBE_DELAY_MS - 1);
		assert.deepEqual(deadlines, [undefined], "the launch that triggered it gets the CPU first");
		await clock.advance(1);
		assert.deepEqual(deadlines, [undefined, SELF_CHECK_EXTENDED_DEADLINE_MS]);
	});

	it("keeps the proof the re-run produced", async () => {
		const { proof, deadlines, clock, logs } = harness([unproven, proven]);
		await proof.ready();
		await clock.advance(PTY_REPROBE_DELAY_MS);
		assert.equal(proof.provenAnswer(), proven);
		assert.equal(await proof.ready(), proven);
		assert.equal(deadlines.length, 2, "nothing probes after the proof");
		assert.match(text(logs), /proved itself on the repeated/);
	});

	it("hands a fault the re-run found to the next launch and holds it, so a broken tree is not admitted again", async () => {
		const { proof, deadlines, clock, logs } = harness([unproven, refused]);
		await proof.ready();
		await clock.advance(PTY_REPROBE_DELAY_MS);

		const first = await proof.ready();
		assert.equal(first.ready, false);
		assert.match(first.reason ?? "", /repeated self-check refused the runtime that was admitted unproven/);
		assert.match(first.reason ?? "", /exited with code 3/, "the entry's own reason survives");
		assert.match(text(logs), /PTY runtime refused/);
		assert.equal(logs.at(-1)?.level, "error");
		// Held: a fresh short probe would only be inconclusive on the same tree and admit it again.
		await clock.advance(PTY_FAULT_HOLD_MS - 1);
		assert.equal((await proof.ready()).ready, false);
		assert.equal(deadlines.length, 2, "no probe while the fault is held");
	});

	it("probes afresh once the held fault expires, as a loaded machine's load may be gone", async () => {
		const { proof, deadlines, clock } = harness([unproven, refused, proven]);
		await proof.ready();
		await clock.advance(PTY_REPROBE_DELAY_MS);
		assert.equal((await proof.ready()).ready, false);

		await clock.advance(PTY_FAULT_HOLD_MS);
		assert.equal(await proof.ready(), proven);
		assert.deepEqual(deadlines, [undefined, SELF_CHECK_EXTENDED_DEADLINE_MS, undefined]);
	});

	it("does not hold a first probe's refusal: its cause may be a staging pass that is fixed by the next call", async () => {
		const { proof, deadlines, clock } = harness([refused, proven]);
		assert.equal((await proof.ready()).ready, false);
		assert.equal(clock.pending(), 0, "a refusal schedules no re-run");
		assert.equal(await proof.ready(), proven);
		assert.deepEqual(deadlines, [undefined, undefined]);
	});

	it("shares one probe between callers that arrive together", async () => {
		const clock = new FakeClock();
		const settle = Promise.withResolvers<PtyRuntimeReadiness>();
		let calls = 0;
		const proof = new PtyRuntimeProof({
			probe: () => {
				calls += 1;
				return settle.promise;
			},
			now: clock.now,
			schedule: clock.schedule,
		});
		const first = proof.ready();
		const second = proof.ready();
		settle.resolve(proven);
		assert.equal(await first, proven);
		assert.equal(await second, proven);
		assert.equal(calls, 1);
	});

	it("retries a probe that threw instead of caching the throw", async () => {
		const { proof } = harness(["throw", proven]);
		await assert.rejects(proof.ready(), /could not be checked/);
		assert.equal(await proof.ready(), proven);
	});

	it("gives up a re-run that keeps throwing after a bounded number of tries, and the next launch probes afresh", async () => {
		const { proof, deadlines, clock, logs } = harness([unproven, "throw", "throw", "throw", proven]);
		await proof.ready();
		await clock.advance(PTY_REPROBE_DELAY_MS);
		await clock.advance(PTY_REPROBE_DELAY_MS);
		await clock.advance(PTY_REPROBE_DELAY_MS);
		await clock.advance(10 * PTY_REPROBE_DELAY_MS);
		assert.equal(deadlines.length, 4, "the first probe and three re-runs, then no more");
		assert.equal(logs.filter(line => /could not run/.test(line.message)).length, 3);
		// Not left admitted on a check that never ran: the next call is a new first probe.
		assert.equal(await proof.ready(), proven);
		assert.deepEqual(deadlines, [undefined, SELF_CHECK_EXTENDED_DEADLINE_MS, SELF_CHECK_EXTENDED_DEADLINE_MS, SELF_CHECK_EXTENDED_DEADLINE_MS, undefined]);
	});
});

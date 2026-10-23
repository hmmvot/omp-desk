/**
 * The Bun plan's pipe-only check, and what an overlap with the window's first full runtime proof may change about its answer.
 *
 * Runner: `node --test src/host/pty-bun-proof.test.ts`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { proveBunRuntime } from "./pty-bun-proof.ts";
import type { PtyRuntimeReadiness } from "./pty-runtime.ts";

const base = { platform: "win32", runtimeVersion: 2, treeDigest: "d".repeat(64), runtime: null } as const;
const proven: PtyRuntimeReadiness = { ...base, ready: true, proven: true, reason: null };
const inconclusive: PtyRuntimeReadiness = { ...base, ready: true, proven: false, reason: "the pipe child did not finish within the self-check deadline of 15 s" };
const refused: PtyRuntimeReadiness = { ...base, ready: false, proven: false, reason: "the runtime self-check failed with exit code 7" };

async function oneTurn(): Promise<void> {
	const turn = Promise.withResolvers<void>();
	setImmediate(turn.resolve);
	await turn.promise;
}

/**
 * One check per answer in order (the last replayed), and a full probe that runs while `running.value` says so.
 * `events` records the order of what happened.
 */
function scenario(answers: readonly PtyRuntimeReadiness[], running: { value: boolean }) {
	const events: string[] = [];
	const finish = Promise.withResolvers<void>();
	let checks = 0;
	const input = {
		prove: async () => {
			const answer = answers[Math.min(checks, answers.length - 1)]!;
			checks += 1;
			events.push(`check ${checks}`);
			return answer;
		},
		fullProbeRunning: () => running.value,
		fullProbeSettled: async () => {
			events.push("wait for the full probe");
			await finish.promise;
			events.push("the full probe answered");
		},
	};
	return {
		input,
		events,
		checks: () => checks,
		answerFullProbe: () => {
			running.value = false;
			finish.resolve();
		},
	};
}

describe("proveBunRuntime", () => {
	it("judges an inconclusive answer at once when no full probe ran before, during or after the check", async () => {
		const s = scenario([inconclusive], { value: false });
		const result = await proveBunRuntime(s.input);
		assert.equal(result.readiness, inconclusive);
		assert.equal(result.retried, false);
		assert.deepEqual(s.events, ["check 1"]);
	});

	it("does not retry a proof or a refusal, whether or not a full probe is running", async () => {
		for (const answer of [proven, refused]) {
			const s = scenario([answer], { value: true });
			const result = await proveBunRuntime(s.input);
			assert.equal(result.readiness, answer);
			assert.equal(result.retried, false);
			assert.equal(s.checks(), 1);
		}
	});

	it("waits for the full probe and checks once more when an inconclusive answer came while it was running", async () => {
		const s = scenario([inconclusive, proven], { value: true });
		const running = proveBunRuntime(s.input);
		await oneTurn();
		assert.deepEqual(s.events, ["check 1", "wait for the full probe"], "the second check does not start before the full probe answered");
		s.answerFullProbe();
		const result = await running;
		assert.equal(result.readiness, proven, "the second answer is the one judged");
		assert.equal(result.retried, true);
		assert.deepEqual(s.events, ["check 1", "wait for the full probe", "the full probe answered", "check 2"]);
	});

	it("retries when the full probe was running at the start only, or at the end only", async () => {
		const atStart = { value: true };
		const first = scenario([inconclusive, proven], atStart);
		const startOnly = await proveBunRuntime({
			...first.input,
			prove: async () => {
				const answer = await first.input.prove();
				atStart.value = false;
				return answer;
			},
			fullProbeSettled: async () => undefined,
		});
		assert.equal(startOnly.retried, true);

		const atEnd = { value: false };
		const second = scenario([inconclusive, proven], atEnd);
		const endOnly = await proveBunRuntime({
			...second.input,
			prove: async () => {
				atEnd.value = true;
				return await second.input.prove();
			},
			fullProbeSettled: async () => undefined,
		});
		assert.equal(endOnly.retried, true);
	});

	it("returns the second answer as it is, so a second inconclusive answer is judged by the ordinary rules", async () => {
		const s = scenario([inconclusive, inconclusive], { value: true });
		s.answerFullProbe();
		const result = await proveBunRuntime({ ...s.input, fullProbeRunning: () => true });
		assert.equal(result.readiness, inconclusive);
		assert.equal(result.retried, true);
		assert.equal(s.checks(), 2, "never a third check");
	});
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChatPhase } from "../chat/model.ts";
import { launchReadiness, stepAfterChatPhase, type LaunchWriterFacts } from "./launch-readiness.ts";

const CHAT = { kind: "chat", carriesControl: true, stopping: false } as const;
const TERMINAL = { kind: "terminal", carriesControl: true, stopping: false } as const;

function facts(overrides: Partial<LaunchWriterFacts>): LaunchWriterFacts {
	return { runtime: CHAT, chatPhase: null, controlVerified: false, controlFailed: false, ...overrides };
}

describe("when a launch's writer is ready", () => {
	it("is booting for a Chat while it attaches, waits for OMP's `ready` and reads its first state, and ready only when live", () => {
		const read = (chatPhase: ChatPhase) => launchReadiness(facts({ chatPhase }));
		assert.deepEqual((["starting", "attaching", "resyncing"] as const).map(read), ["booting", "booting", "booting"]);
		assert.equal(read("live"), "ready");
		assert.deepEqual((["stopped", "failed", "view-only", "blocked", "legacy"] as const).map(read), ["gone", "gone", "gone", "gone", "gone"]);
		assert.equal(launchReadiness(facts({ chatPhase: null })), "gone", "a Chat without a conversation has nothing to wait for");
		assert.equal(launchReadiness(facts({ chatPhase: "attaching", controlVerified: true })), "booting", "host control is not what a Chat waits for");
	});

	it("is booting for a Terminal until host control is verified, and no longer waits when it never will be", () => {
		assert.equal(launchReadiness(facts({ runtime: TERMINAL })), "booting");
		assert.equal(launchReadiness(facts({ runtime: TERMINAL, controlVerified: true })), "ready");
		assert.equal(launchReadiness(facts({ runtime: TERMINAL, controlFailed: true })), "ready", "the failure says why, and the wait is over");
		assert.equal(launchReadiness(facts({ runtime: { ...TERMINAL, carriesControl: false } })), "ready", "a launch without a host-control bootstrap never gets one");
		assert.equal(launchReadiness(facts({ runtime: { ...TERMINAL, stopping: true } })), "gone");
	});

	it("has nothing to wait for without a process", () => {
		assert.equal(launchReadiness(facts({ runtime: null, chatPhase: "live", controlVerified: true })), "gone");
	});

	it("names the launch step of the phases before `live`, and nothing for the others", () => {
		assert.equal(stepAfterChatPhase("starting"), "boot");
		assert.equal(stepAfterChatPhase("attaching"), "boot");
		assert.equal(stepAfterChatPhase("resyncing"), "connect");
		for (const phase of ["live", "stopped", "failed", "view-only", "blocked", "legacy"] as const) assert.equal(stepAfterChatPhase(phase), null, phase);
	});
});

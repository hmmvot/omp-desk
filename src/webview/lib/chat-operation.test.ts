/**
 * Tests for the page-local acknowledgement of a Chat action: it shows at once, the host's word replaces it, and it can never stay
 * stuck (the host ended it, the conversation moved on, the link was lost, or 15 s passed in silence).
 *
 * Runner: `node --test src/webview/lib/chat-operation.test.ts`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChatOperationMessage } from "../../protocol/chat-messages.ts";
import { CHAT_STALL_MS, CHAT_STALLED_SENTENCE, ChatOperationStore, operationBannerText } from "./chat-operation.ts";

interface Scheduled { readonly callback: () => void; readonly at: number; readonly every: number | null }

function fixture(): { store: ChatOperationStore; advance(ms: number): void; changes(): number; pendingTimers(): number } {
	let now = 1_000;
	let next = 0;
	const timers = new Map<number, Scheduled>();
	let changed = 0;
	const store = new ChatOperationStore({
		now: () => now,
		timers: {
			setTimeout: (callback, ms) => { timers.set(++next, { callback, at: now + ms, every: null }); return next; },
			clearTimeout: handle => { timers.delete(handle as number); },
			setInterval: (callback, ms) => { timers.set(++next, { callback, at: now + ms, every: ms }); return next; },
			clearInterval: handle => { timers.delete(handle as number); },
		},
	});
	store.subscribe(() => { changed += 1; });
	const advance = (ms: number): void => {
		const target = now + ms;
		for (;;) {
			const due = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
			if (due === undefined) break;
			const [id, timer] = due;
			now = Math.max(now, timer.at);
			if (timer.every === null) timers.delete(id); else timers.set(id, { ...timer, at: now + timer.every });
			timer.callback();
		}
		now = target;
	};
	return { store, advance, changes: () => changed, pendingTimers: () => timers.size };
}

const ID = "a".repeat(32);

function hosted(step: "ownership" | "spawn", requestId: string | null = ID, elapsedMs = 0): ChatOperationMessage {
	return { type: "omp:chat-operation", operation: { kind: "resume", step, elapsedMs, requestId, still: false } };
}

describe("the page acknowledges a click before the host says anything", () => {
	it("shows the operation at once, once, and refuses a second begin of the same kind", () => {
		const { store, changes } = fixture();
		assert.equal(store.begin("resume", ID, "view-only"), true);
		assert.deepEqual(store.getState().operation, { kind: "resume", step: null, elapsedMs: 0, still: false, requestId: ID });
		assert.equal(changes(), 1);
		assert.equal(store.begin("resume", "b".repeat(32), "view-only"), false, "a second click sends nothing");
		assert.equal(store.getState().operation?.requestId, ID);
	});

	it("takes the host's step as soon as it arrives, keeps counting from the host's elapsed, and never shows both", () => {
		const { store, advance } = fixture();
		store.begin("resume", ID, "view-only");
		store.host(hosted("ownership", ID, 2_000));
		assert.equal(store.getState().operation?.step, "ownership");
		assert.equal(store.getState().operation?.elapsedMs, 2_000);
		advance(3_000);
		assert.equal(store.getState().operation?.elapsedMs, 5_000, "the page adds its own delta to the host's clock");
		assert.equal(store.begin("resume", "c".repeat(32), "view-only"), false, "a hosted launch is already in flight");
	});

	it("counts seconds with a one-second ticker that exists only while something is pending", () => {
		const { store, advance, pendingTimers } = fixture();
		const seen: (number | undefined)[] = [];
		store.subscribe(() => seen.push(store.getState().operation?.elapsedMs));
		store.begin("resume", ID, "view-only");
		advance(2_000);
		assert.deepEqual(seen.slice(-2), [1_000, 2_000]);
		store.host({ type: "omp:chat-operation", operation: null, ended: { kind: "resume", requestId: ID, status: "running" } });
		assert.equal(store.getState().operation, null);
		assert.equal(pendingTimers(), 0, "no ticker and no stall timer remain");
	});
});

describe("a pending action cannot stay stuck", () => {
	it("is cleared by the host's end, including a refusal, and the button is available again", () => {
		const { store } = fixture();
		store.begin("restart", ID, "failed");
		store.host({ type: "omp:chat-operation", operation: null, ended: { kind: "restart", requestId: ID, status: "refused" } });
		assert.deepEqual(store.getState(), { operation: null, notice: null });
		assert.equal(store.begin("restart", "d".repeat(32), "failed"), true);
	});

	it("stops waiting after the stall limit with one fixed sentence, and a later click starts over", () => {
		const { store, advance, pendingTimers } = fixture();
		store.begin("resume", ID, "view-only");
		advance(CHAT_STALL_MS - 1);
		assert.notEqual(store.getState().operation, null);
		advance(1);
		assert.deepEqual(store.getState(), { operation: null, notice: CHAT_STALLED_SENTENCE });
		assert.equal(pendingTimers(), 0);
		assert.equal(store.begin("resume", "e".repeat(32), "view-only"), true);
		assert.equal(store.getState().notice, null, "the sentence goes with the next attempt");
	});

	it("is not stalled once the host has spoken: the host owns the end", () => {
		const { store, advance } = fixture();
		store.begin("resume", ID, "view-only");
		store.host(hosted("spawn"));
		advance(CHAT_STALL_MS * 4);
		assert.equal(store.getState().operation?.step, "spawn");
		assert.equal(store.getState().notice, null);
	});

	it("is cleared by a host-owned phase, but not by the host-less phases a resume passes through", () => {
		const { store } = fixture();
		store.begin("resume", ID, "view-only");
		store.model({ phase: "starting", working: false });
		store.model({ phase: "view-only", working: false });
		assert.notEqual(store.getState().operation, null);
		store.model({ phase: "attaching", working: false });
		assert.equal(store.getState().operation, null);
	});

	it("is cleared by a lost host link or a route change, silently", () => {
		const { store } = fixture();
		store.begin("resume", ID, "view-only");
		store.host(hosted("ownership"));
		store.reset();
		assert.deepEqual(store.getState(), { operation: null, notice: null });
	});

	it("abandons an action whose message went nowhere", () => {
		const { store } = fixture();
		store.begin("resume", ID, "view-only");
		store.abandon("f".repeat(32));
		assert.notEqual(store.getState().operation, null, "another request's id changes nothing");
		store.abandon(ID);
		assert.equal(store.getState().operation, null);
	});
});

describe("Stop", () => {
	it("is its own page-local state: the host's operations do not end it, its abort result, the turn ending or the stall limit does", () => {
		const { store, advance } = fixture();
		store.begin("stop", ID, "live");
		store.host({ type: "omp:chat-operation", operation: null });
		assert.equal(store.getState().operation?.kind, "stop");
		store.model({ phase: "live", working: true });
		assert.equal(store.getState().operation?.kind, "stop");
		store.stopAnswered("0".repeat(32));
		assert.equal(store.getState().operation?.kind, "stop", "another request's answer changes nothing");
		store.stopAnswered(ID);
		assert.equal(store.getState().operation, null);

		store.begin("stop", ID, "live");
		store.model({ phase: "live", working: false });
		assert.equal(store.getState().operation, null);

		store.begin("stop", ID, "live");
		advance(CHAT_STALL_MS);
		assert.equal(store.getState().notice, CHAT_STALLED_SENTENCE);
	});
});

describe("the banner sentence", () => {
	it("acknowledges before the host names a step, then names it, with seconds after five", () => {
		assert.equal(operationBannerText({ kind: "resume", step: null, elapsedMs: 100, still: false, requestId: ID }), "Starting the session…");
		assert.equal(operationBannerText({ kind: "resume", step: null, elapsedMs: 7_400, still: false, requestId: ID }), "Starting the session… · 7 s");
		assert.equal(operationBannerText({ kind: "resume", step: "ownership", elapsedMs: 7_400, still: false, requestId: ID }), "Starting the session · checking for another OMP process · 7 s");
		assert.equal(operationBannerText({ kind: "reconnect", step: null, elapsedMs: 0, still: false, requestId: ID }), "Reconnecting to the session…");
		assert.equal(operationBannerText({ kind: "stop", step: null, elapsedMs: 0, still: false, requestId: ID }), null, "Stop lives on its button");
	});
});

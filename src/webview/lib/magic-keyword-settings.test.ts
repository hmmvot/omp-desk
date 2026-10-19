/**
 * Tests for the page's copy of which magic keywords OMP acts on: every keyword until the host speaks, the host's answer after,
 * garbage and repeats changing nothing, and the lazy, throttled question to the host.
 *
 * Runner: `node --test src/webview/lib/magic-keyword-settings.test.ts`.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { GuestHostMessage, GuestWebviewMessage } from "../../protocol/messages.ts";
import type { MagicKeywordId } from "../../shared/magic-keywords.ts";
import {
	attachMagicKeywordSettings,
	getMagicKeywordSettings,
	MAGIC_KEYWORD_REFRESH_MS,
	refreshMagicKeywordSettings,
	requestMagicKeywordSettings,
	setMagicKeywordSettings,
	subscribeMagicKeywordSettings,
} from "./magic-keyword-settings.ts";

const EVERY: MagicKeywordId[] = ["ultrathink", "orchestrate", "workflow", "jevify"];
const sorted = (set: ReadonlySet<MagicKeywordId>): MagicKeywordId[] => [...set].sort();

/** A host transport that records what the page posts and lets a test speak as the host. */
function fakeHost(options: { post?: (message: GuestWebviewMessage) => boolean | void } = {}) {
	const posted: GuestWebviewMessage[] = [];
	let listener: ((message: GuestHostMessage) => void) | null = null;
	return {
		posted,
		transport: {
			subscribe(next: (message: GuestHostMessage) => void) {
				listener = next;
				return () => {
					listener = null;
				};
			},
			post(message: GuestWebviewMessage) {
				posted.push(message);
				return options.post?.(message);
			},
		},
		say: (message: GuestHostMessage) => listener?.(message),
		get listening() {
			return listener !== null;
		},
	};
}

let detach: (() => void) | null = null;
afterEach(() => {
	detach?.();
	detach = null;
});

describe("the page's copy of the magic keyword settings", () => {
	it("counts every keyword until the host speaks, as OMP's terminal does", () => {
		assert.deepEqual(sorted(getMagicKeywordSettings()), [...EVERY].sort());
	});

	it("takes the host's answer from the transport, and an empty answer means none", () => {
		const host = fakeHost();
		detach = attachMagicKeywordSettings(host.transport);
		host.say({ type: "omp:chat-magic-keywords", keywords: ["ultrathink", "jevify"] });
		assert.deepEqual(sorted(getMagicKeywordSettings()), ["jevify", "ultrathink"]);
		host.say({ type: "omp:chat-magic-keywords", keywords: [] });
		assert.deepEqual([...getMagicKeywordSettings()], []);
		host.say({ type: "omp:chat-magic-keywords", keywords: EVERY });
		assert.deepEqual(sorted(getMagicKeywordSettings()), [...EVERY].sort());
	});

	it("keeps the previous answer on garbage, and tells nobody about an answer that changes nothing", () => {
		const host = fakeHost();
		detach = attachMagicKeywordSettings(host.transport);
		setMagicKeywordSettings(["orchestrate"]);
		const before = getMagicKeywordSettings();
		const heard: number[] = [];
		const stop = subscribeMagicKeywordSettings(() => heard.push(1));
		for (const garbage of [null, "orchestrate", 3, {}, ["orchestrate", "workflowz"], ["orchestrate", 4], [null]]) setMagicKeywordSettings(garbage);
		setMagicKeywordSettings(["orchestrate"]);
		assert.equal(getMagicKeywordSettings(), before, "the same set object until the keywords change");
		assert.equal(heard.length, 0);
		setMagicKeywordSettings(["orchestrate", "jevify"]);
		assert.equal(heard.length, 1);
		stop();
		setMagicKeywordSettings(["orchestrate"]);
		assert.equal(heard.length, 1, "a listener that stopped is not told");
	});

	it("forgets what it heard, and stops listening, when detached", () => {
		const host = fakeHost();
		const stop = attachMagicKeywordSettings(host.transport);
		host.say({ type: "omp:chat-magic-keywords", keywords: [] });
		assert.equal(getMagicKeywordSettings().size, 0);
		stop();
		assert.equal(host.listening, false);
		assert.equal(getMagicKeywordSettings().size, EVERY.length);
	});
});

describe("asking the host", () => {
	it("is silent before the page is attached", () => {
		requestMagicKeywordSettings(1_000_000);
		const host = fakeHost();
		detach = attachMagicKeywordSettings(host.transport);
		assert.deepEqual(host.posted, [], "nothing was remembered for a later transport");
	});

	it("asks once, with no fields, and not again within the refresh period", () => {
		const host = fakeHost();
		detach = attachMagicKeywordSettings(host.transport);
		requestMagicKeywordSettings(10_000);
		requestMagicKeywordSettings(10_000 + 1);
		requestMagicKeywordSettings(10_000 + MAGIC_KEYWORD_REFRESH_MS - 1);
		assert.deepEqual(host.posted, [{ type: "omp:chat-magic-keywords-read" }]);
		requestMagicKeywordSettings(10_000 + MAGIC_KEYWORD_REFRESH_MS);
		assert.equal(host.posted.length, 2, "the period is over: ask again");
		assert.equal(MAGIC_KEYWORD_REFRESH_MS, 30_000);
	});

	it("asks again on a refresh inside the period, which then counts as the last question", () => {
		const host = fakeHost();
		detach = attachMagicKeywordSettings(host.transport);
		requestMagicKeywordSettings(10_000);
		refreshMagicKeywordSettings(10_001);
		assert.equal(host.posted.length, 2, "the reader came back: no wait for the period");
		requestMagicKeywordSettings(10_001 + MAGIC_KEYWORD_REFRESH_MS - 1);
		assert.equal(host.posted.length, 2, "the refresh started a new period");
		requestMagicKeywordSettings(10_001 + MAGIC_KEYWORD_REFRESH_MS);
		assert.equal(host.posted.length, 3);
	});

	it("does not count a refresh that went nowhere, and is silent before the page is attached", () => {
		refreshMagicKeywordSettings(80_000);
		let accepted = false;
		const host = fakeHost({ post: () => accepted });
		detach = attachMagicKeywordSettings(host.transport);
		assert.deepEqual(host.posted, [], "nothing was remembered for a later transport");
		refreshMagicKeywordSettings(80_001);
		accepted = true;
		requestMagicKeywordSettings(80_002);
		assert.equal(host.posted.length, 2, "the refresh that went nowhere started no period");
	});

	it("does not count a question that went nowhere, whether the route says so or throws", () => {
		let outcome: "nowhere" | "throws" | "ok" = "nowhere";
		const host = fakeHost({
			post: () => {
				if (outcome === "throws") throw new Error("the panel is gone");
				return outcome === "nowhere" ? false : true;
			},
		});
		detach = attachMagicKeywordSettings(host.transport);
		requestMagicKeywordSettings(50_000);
		outcome = "throws";
		requestMagicKeywordSettings(50_001);
		outcome = "ok";
		requestMagicKeywordSettings(50_002);
		assert.equal(host.posted.length, 3, "each earlier question may be asked again at once");
		requestMagicKeywordSettings(50_003);
		assert.equal(host.posted.length, 3, "an accepted question starts the period");
	});

	it("starts a fresh period for a newly attached transport", () => {
		const first = fakeHost();
		const stop = attachMagicKeywordSettings(first.transport);
		requestMagicKeywordSettings(70_000);
		stop();
		const second = fakeHost();
		detach = attachMagicKeywordSettings(second.transport);
		requestMagicKeywordSettings(70_001);
		assert.equal(second.posted.length, 1);
	});
});

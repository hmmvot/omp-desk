import assert from "node:assert/strict";
import { mock, test } from "node:test";
import type { GuestHostMessage, GuestWebviewMessage } from "../messages.ts";
import type { SymbolLinkResult } from "../code-symbols.ts";
import { ChatSymbolLinks } from "./chat-symbol-links.ts";

function fixture() {
	const sent: Extract<GuestWebviewMessage, { type: "omp:terminal-link-symbols" }>[] = [];
	let deliver: (message: GuestHostMessage) => void = () => {};
	let accept = true;
	const transport = {
		post(message: GuestWebviewMessage) { if (message.type === "omp:terminal-link-symbols") sent.push(message); return accept; },
		subscribe(listener: (message: GuestHostMessage) => void) { deliver = listener; return () => { deliver = () => {}; }; },
	};
	const answer = (index: number, results: SymbolLinkResult[], disabled?: true) =>
		deliver({ type: "omp:terminal-link-symbol-resolution", requestId: sent[index]!.requestId, ...(disabled === undefined ? {} : { disabled }), results });
	return { sent, transport, answer, deliver: (message: GuestHostMessage) => deliver(message), refuse: () => { accept = false; } };
}

/** Lets promise continuations run after a mocked timer fired. */
async function settle(): Promise<void> {
	for (let turn = 0; turn < 10; turn++) await Promise.resolve();
}

const found = (token: string, target: string): SymbolLinkResult => ({ token, status: "found", target });

test("tokens of one burst are batched into one request, answered per token, cached and de-duplicated", async () => {
	mock.timers.enable({ apis: ["setTimeout"] });
	try {
		const { sent, transport, answer } = fixture();
		const links = new ChatSymbolLinks(transport);
		assert.equal(links.peek("Ability"), undefined);
		const a = links.resolve("Ability");
		const again = links.resolve("Ability");
		const b = links.resolve("Missing");
		assert.equal(sent.length, 0, "nothing is posted before the batch window closes");
		mock.timers.tick(40);
		assert.equal(sent.length, 1);
		assert.deepEqual(sent[0]!.tokens, ["Ability", "Missing"], "unique tokens in one message");
		answer(0, [found("Ability", "src/a.ts:3:5"), { token: "Missing", status: "none" }]);
		assert.deepEqual(await a, { target: "src/a.ts:3:5" });
		assert.deepEqual(await again, { target: "src/a.ts:3:5" });
		assert.equal(await b, null);
		assert.deepEqual(links.peek("Ability"), { target: "src/a.ts:3:5" });
		assert.equal(links.peek("Missing"), null);
		assert.deepEqual(await links.resolve("Ability"), { target: "src/a.ts:3:5" });
		assert.equal(sent.length, 1, "answers come from the cache");
		links.dispose();
	} finally { mock.timers.reset(); }
});

test("no more than sixteen tokens per request and two requests at a time; the rest follows as answers arrive", async () => {
	mock.timers.enable({ apis: ["setTimeout"] });
	try {
		const { sent, transport, answer } = fixture();
		const links = new ChatSymbolLinks(transport);
		const names = Array.from({ length: 40 }, (_, index) => `Name${index}`);
		const pending = names.map(name => links.resolve(name));
		mock.timers.tick(40);
		assert.deepEqual(sent.map(message => message.tokens.length), [16, 16], "two full requests, the third waits");
		answer(0, sent[0]!.tokens.map(token => ({ token, status: "none" as const })));
		await settle();
		mock.timers.tick(40);
		assert.deepEqual(sent.map(message => message.tokens.length), [16, 16, 8]);
		answer(1, sent[1]!.tokens.map(token => ({ token, status: "none" as const })));
		answer(2, sent[2]!.tokens.map(token => ({ token, status: "none" as const })));
		assert.deepEqual(await Promise.all(pending), names.map(() => null));
		links.dispose();
	} finally { mock.timers.reset(); }
});

test("a burst beyond the queue budget stays plain code and is not cached", async () => {
	mock.timers.enable({ apis: ["setTimeout"] });
	try {
		const { sent, transport, answer } = fixture();
		const links = new ChatSymbolLinks(transport);
		const names = Array.from({ length: 100 }, (_, index) => `Name${index}`);
		const pending = names.map(name => links.resolve(name));
		mock.timers.tick(40);
		assert.equal(sent.flatMap(message => message.tokens).length, 32, "two requests of sixteen were sent");
		assert.equal(links.peek("Name99"), undefined, "an unasked token is not recorded as none");
		for (const [index, message] of sent.entries()) answer(index, message.tokens.map(token => ({ token, status: "none" as const })));
		await settle();
		mock.timers.tick(40);
		for (const [index, message] of [...sent.entries()].slice(2)) answer(index, message.tokens.map(token => ({ token, status: "none" as const })));
		await Promise.all(pending);
		assert.equal(sent.flatMap(message => message.tokens).length, 64, "only the budget of sixty-four was ever asked");
		assert.equal(links.peek("Name10"), null);
		assert.equal(links.peek("Name99"), undefined);
		links.dispose();
	} finally { mock.timers.reset(); }
});

test("an unavailable answer is asked once more later; after that the token is none and not asked again for a while", async () => {
	mock.timers.enable({ apis: ["setTimeout"] });
	try {
		let now = 0;
		const { sent, transport, answer } = fixture();
		const links = new ChatSymbolLinks(transport, { now: () => now });
		const result = links.resolve("Ability");
		mock.timers.tick(40);
		answer(0, [{ token: "Ability", status: "unavailable" }]);
		await settle();
		assert.equal(sent.length, 1, "the retry waits");
		mock.timers.tick(5000);
		await settle();
		mock.timers.tick(40);
		assert.equal(sent.length, 2, "one retry");
		answer(1, [found("Ability", "src/a.ts:1:1")]);
		assert.deepEqual(await result, { target: "src/a.ts:1:1" }, "the retry's answer is the answer");

		const hopeless = links.resolve("Unknown");
		mock.timers.tick(40);
		answer(2, [{ token: "Unknown", status: "unavailable" }]);
		await settle();
		mock.timers.tick(5000);
		await settle();
		mock.timers.tick(40);
		answer(3, [{ token: "Unknown", status: "unavailable" }]);
		await settle();
		mock.timers.tick(5000);
		mock.timers.tick(40);
		assert.equal(sent.length, 4, "the second retry waits four times as long");
		mock.timers.tick(15_000);
		await settle();
		mock.timers.tick(40);
		assert.equal(sent.length, 5, "two retries in all");
		answer(4, [{ token: "Unknown", status: "unavailable" }]);
		assert.equal(await hopeless, null);
		now += 11_000;
		assert.equal(links.peek("Unknown"), null, "an exhausted retry rests longer than an answered none");
		now += 50_000;
		assert.equal(links.peek("Unknown"), undefined);
		links.dispose();
	} finally { mock.timers.reset(); }
});

test("an answered none expires sooner than a found, and a found expires too", async () => {
	mock.timers.enable({ apis: ["setTimeout"] });
	try {
		let now = 0;
		const { sent, transport, answer } = fixture();
		const links = new ChatSymbolLinks(transport, { now: () => now });
		const pair = [links.resolve("Ability"), links.resolve("Nope")];
		mock.timers.tick(40);
		answer(0, [found("Ability", "a.ts:1:1"), { token: "Nope", status: "none" }]);
		await Promise.all(pair);
		now += 11_000;
		assert.equal(links.peek("Nope"), undefined);
		assert.deepEqual(links.peek("Ability"), { target: "a.ts:1:1" });
		now += 20_000;
		assert.equal(links.peek("Ability"), undefined);
		assert.equal(sent.length, 1);
		links.dispose();
	} finally { mock.timers.reset(); }
});

test("a token the answer leaves out, a request the page cannot send and a request the host never answers are unavailable", async () => {
	mock.timers.enable({ apis: ["setTimeout"] });
	try {
		const { sent, transport, answer, refuse } = fixture();
		const links = new ChatSymbolLinks(transport, { retryMs: 1_000_000 });
		const left = links.resolve("Left");
		const right = links.resolve("Right");
		mock.timers.tick(40);
		answer(0, [found("Right", "r.ts:1:1")]);
		assert.deepEqual(await right, { target: "r.ts:1:1" });
		await settle();
		assert.equal(links.peek("Left"), undefined, "unavailable is not an answer yet: it waits for its retry");
		const silent = links.resolve("Silent");
		mock.timers.tick(40);
		mock.timers.tick(15_000);
		await settle();
		assert.equal(sent.length, 2);
		assert.equal(links.peek("Silent"), undefined, "the timed-out request retries instead of recording an answer");
		refuse();
		links.dispose();
		assert.equal(await left, null);
		assert.equal(await silent, null);
	} finally { mock.timers.reset(); }
});

test("a response for another request, an unknown request id or a late answer after dispose changes nothing", async () => {
	mock.timers.enable({ apis: ["setTimeout"] });
	try {
		const { sent, transport, answer } = fixture();
		const links = new ChatSymbolLinks(transport);
		const pending = links.resolve("Ability");
		mock.timers.tick(40);
		answer(0, [found("Ability", "a.ts:1:1")]);
		assert.deepEqual(await pending, { target: "a.ts:1:1" });
		answer(0, [found("Ability", "evil.ts:1:1")]);
		assert.deepEqual(links.peek("Ability"), { target: "a.ts:1:1" }, "a repeated answer is ignored");
		const next = links.resolve("Other");
		mock.timers.tick(40);
		links.dispose();
		answer(1, [found("Other", "late.ts:1:1")]);
		assert.equal(await next, null);
		assert.equal(sent.length, 2);
	} finally { mock.timers.reset(); }
});

test("a disabled answer makes the page stop asking for a while", async () => {
	mock.timers.enable({ apis: ["setTimeout"] });
	try {
		let now = 0;
		const { sent, transport, answer } = fixture();
		const links = new ChatSymbolLinks(transport, { now: () => now });
		const first = links.resolve("Ability");
		mock.timers.tick(40);
		answer(0, [{ token: "Ability", status: "none" }], true);
		assert.equal(await first, null);
		assert.equal(links.disabled, true);
		assert.equal(await links.resolve("Another"), null);
		mock.timers.tick(40);
		assert.equal(sent.length, 1, "nothing is asked while disabled");
		now += 31_000;
		assert.equal(links.disabled, false);
		const again = links.resolve("Another");
		mock.timers.tick(40);
		assert.equal(sent.length, 2);
		answer(1, [{ token: "Another", status: "none" }]);
		await again;
		links.dispose();
	} finally { mock.timers.reset(); }
});

test("an answer for a request this client did not make cannot disable it or settle anything, and request ids never repeat across clients", async () => {
	mock.timers.enable({ apis: ["setTimeout"] });
	try {
		const first = fixture();
		const old = new ChatSymbolLinks(first.transport);
		const oldResult = old.resolve("Ability");
		mock.timers.tick(40);
		old.dispose();
		await oldResult;
		const second = fixture();
		const links = new ChatSymbolLinks(second.transport);
		const result = links.resolve("Ability");
		mock.timers.tick(40);
		assert.notEqual(second.sent[0]!.requestId, first.sent[0]!.requestId, "a late answer to the old client's request id matches nothing here");
		second.deliver({ type: "omp:terminal-link-symbol-resolution", requestId: first.sent[0]!.requestId, disabled: true, results: [found("Ability", "late.ts:1:1")] });
		assert.equal(links.disabled, false);
		assert.equal(links.peek("Ability"), undefined);
		second.answer(0, [found("Ability", "a.ts:1:1")]);
		assert.deepEqual(await result, { target: "a.ts:1:1" });
		links.dispose();
	} finally { mock.timers.reset(); }
});

test("a disabled answer settles queued tokens and cancels retries waiting for their turn", async () => {
	mock.timers.enable({ apis: ["setTimeout"] });
	try {
		const { sent, transport, answer } = fixture();
		const links = new ChatSymbolLinks(transport);
		const retrying = links.resolve("Retry");
		mock.timers.tick(40);
		answer(0, [{ token: "Retry", status: "unavailable" }]);
		await settle();
		const names = Array.from({ length: 40 }, (_, index) => `Name${index}`);
		const queued = names.map(name => links.resolve(name));
		mock.timers.tick(40);
		assert.equal(sent.length, 3, "two requests of sixteen are in flight with the rest queued");
		answer(1, [{ token: "Name0", status: "none" }], true);
		assert.equal(await Promise.all(queued.slice(32)).then(results => results.every(result => result === null)), true, "queued tokens settle without being asked");
		assert.equal(await retrying, null, "the retry waiting for its turn is cancelled");
		mock.timers.tick(5000);
		mock.timers.tick(40);
		assert.equal(sent.length, 3, "nothing more is sent while disabled");
		links.dispose();
	} finally { mock.timers.reset(); }
});

test("tokens waiting for a retry count against the admission budget like queued ones", async () => {
	mock.timers.enable({ apis: ["setTimeout"] });
	try {
		const { sent, transport, answer } = fixture();
		const links = new ChatSymbolLinks(transport);
		const first = Array.from({ length: 16 }, (_, index) => `First${index}`).map(name => links.resolve(name));
		mock.timers.tick(40);
		answer(0, sent[0]!.tokens.map(token => ({ token, status: "unavailable" as const })));
		await settle();
		const filler = Array.from({ length: 48 }, (_, index) => `Fill${index}`).map(name => links.resolve(name));
		const refused = links.resolve("OneTooMany");
		assert.equal(await refused, null, "sixteen retrying plus forty-eight queued is the whole budget");
		assert.equal(links.peek("OneTooMany"), undefined, "a refused token is not recorded");
		links.dispose();
		await Promise.all([...first, ...filler]);
	} finally { mock.timers.reset(); }
});

test("a pending answer is no verdict: nothing is cached, the token is not asked again until the host's retry signal, and every subscriber is told", async () => {
	mock.timers.enable({ apis: ["setTimeout"] });
	try {
		const { sent, transport, answer, deliver } = fixture();
		const links = new ChatSymbolLinks(transport);
		let told = 0;
		links.subscribe(() => { told++; });
		const parked = links.resolve("Ability");
		mock.timers.tick(40);
		answer(0, [{ token: "Ability", status: "pending" }]);
		assert.equal(await parked, null);
		assert.equal(links.peek("Ability"), undefined, "not cached");
		assert.equal(await links.resolve("Ability"), null, "asked again only after the signal");
		mock.timers.tick(40);
		assert.equal(sent.length, 1, "no new request while parked");
		deliver({ type: "omp:terminal-link-symbols-retry" });
		assert.equal(told, 1);
		const again = links.resolve("Ability");
		mock.timers.tick(40);
		assert.equal(sent.length, 2);
		answer(1, [found("Ability", "a.ts:1:1")]);
		assert.deepEqual(await again, { target: "a.ts:1:1" });
		links.dispose();
	} finally { mock.timers.reset(); }
});

test("a token the host could not answer after its retries is asked again after the host's retry signal", async () => {
	mock.timers.enable({ apis: ["setTimeout"] });
	try {
		let now = 0;
		const { sent, transport, answer, deliver } = fixture();
		const links = new ChatSymbolLinks(transport, { now: () => now, retryMs: 10 });
		const result = links.resolve("Ability");
		for (let attempt = 0; attempt < 3; attempt++) {
			mock.timers.tick(40);
			answer(attempt, [{ token: "Ability", status: "unavailable" }]);
			await settle();
			mock.timers.tick(100);
			await settle();
		}
		assert.equal(await result, null);
		assert.equal(links.peek("Ability"), null, "exhausted retries rest for a while");
		deliver({ type: "omp:terminal-link-symbols-retry" });
		assert.equal(links.peek("Ability"), undefined, "the signal lifts the rest");
		links.dispose();
		assert.ok(sent.length >= 3);
	} finally { mock.timers.reset(); }
});

test("when the page budget was full, the subscribers are told once it has room again", async () => {
	mock.timers.enable({ apis: ["setTimeout"] });
	try {
		const { sent, transport, answer } = fixture();
		const links = new ChatSymbolLinks(transport);
		let told = 0;
		links.subscribe(() => { told++; });
		const names = Array.from({ length: 70 }, (_, index) => `Name${index}`);
		const results = names.map(name => links.resolve(name));
		mock.timers.tick(40);
		for (const [index, message] of sent.entries()) answer(index, message.tokens.map(token => ({ token, status: "none" as const })));
		await settle();
		mock.timers.tick(40);
		for (const [index, message] of [...sent.entries()].slice(2)) answer(index, message.tokens.map(token => ({ token, status: "none" as const })));
		await Promise.all(results);
		mock.timers.tick(40);
		assert.equal(told, 1, "one coalesced notification");
		links.dispose();
	} finally { mock.timers.reset(); }
});

test("an ambiguous answer is a link to the symbol search, cached like a found one", async () => {
	mock.timers.enable({ apis: ["setTimeout"] });
	try {
		const { sent, transport, answer } = fixture();
		const links = new ChatSymbolLinks(transport);
		const result = links.resolve("Twin");
		mock.timers.tick(40);
		answer(0, [{ token: "Twin", status: "ambiguous", definitions: 3 }]);
		assert.deepEqual(await result, { target: "Twin", definitions: 3 });
		assert.deepEqual(links.peek("Twin"), { target: "Twin", definitions: 3 });
		assert.deepEqual(await links.resolve("Twin"), { target: "Twin", definitions: 3 });
		assert.equal(sent.length, 1);
		links.dispose();
	} finally { mock.timers.reset(); }
});

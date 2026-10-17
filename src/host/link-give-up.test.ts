import assert from "node:assert/strict";
import { test } from "node:test";
import { recordingLogger } from "../shared/logger.ts";
import type { LoggedLine } from "../shared/logger.ts";
import { parseCodeSymbol } from "../shared/code-symbols.ts";
import { FileNameLinkResolver } from "./file-name-links.ts";
import { GIVE_UP_ATTEMPTS, GIVE_UP_WINDOW_MS, GiveUpReporter, giveUpReason } from "./link-give-up.ts";
import { SymbolLinkResolver, handleSymbolLinks } from "./symbol-links.ts";

const CWD = "D:\\Work\\omp-vscode";
const scope = { cwd: CWD, roots: [CWD] };
const symbol = (text: string) => parseCodeSymbol(text)!;
const infos = (lines: readonly LoggedLine[]) => lines.filter(line => line.level === "info").map(line => line.message);

test("verdicts become short reasons", () => {
	assert.equal(giveUpReason("unavailable: invalidated"), "invalidated");
	assert.equal(giveUpReason("parked (invalidated)"), "invalidated");
	assert.equal(giveUpReason("unavailable: queue-full"), "queue full");
	assert.equal(giveUpReason("parked (timeout)"), "timeout");
	assert.equal(giveUpReason("parked (not ready)"), "provider not ready");
	assert.equal(giveUpReason("parked (queue)"), "queue full");
});

test("a name that gives up is reported once per window, with its reasons, at info", () => {
	const lines: LoggedLine[] = [];
	let now = 0;
	const reporter = new GiveUpReporter(recordingLogger(lines), () => now);
	reporter.missed("code symbol", "Session.Copy", "no-answer");
	now += 5_000;
	reporter.missed("code symbol", "Session.Copy", "timeout");
	assert.deepEqual(infos(lines), [], `${GIVE_UP_ATTEMPTS - 1} misses are a retry, not a give-up`);
	now += 20_000;
	reporter.missed("code symbol", "Session.Copy", "no-answer");
	assert.equal(infos(lines).length, 1);
	assert.match(infos(lines)[0]!, /code symbol "Session\.Copy" had no answer in 3 tries over 25 s \(no-answer x2, timeout x1\)/);
	for (let index = 0; index < 10; index++) { now += 1_000; reporter.missed("code symbol", "Session.Copy", "no-answer"); }
	assert.equal(infos(lines).length, 1, "no second line inside the window");
	reporter.missed("code symbol", "Other", "timeout");
	reporter.missed("code symbol", "Other", "timeout");
	reporter.missed("code symbol", "Other", "timeout");
	assert.equal(infos(lines).length, 2, "another name is reported on its own");
	now += GIVE_UP_WINDOW_MS;
	for (let index = 0; index < 3; index++) reporter.missed("code symbol", "Session.Copy", "queue full");
	assert.equal(infos(lines).length, 3, "the window passed: reported again");
	assert.match(infos(lines)[2]!, /queue full x3/);
});

test("a miss that only waits (provider not ready, files changing) is no try and never gives a name up", () => {
	const lines: LoggedLine[] = [];
	const reporter = new GiveUpReporter(recordingLogger(lines), () => 0);
	for (const reason of ["provider not ready", "invalidated", "invalidated while the batch ran", "files changed while the batch ran", "workspace folders changed"]) {
		for (let index = 0; index < 10; index++) reporter.missed("code symbol", "Session.Dispose", reason);
	}
	reporter.missed("code symbol", "Session.Dispose", "timeout");
	reporter.missed("code symbol", "Session.Dispose", "timeout");
	assert.deepEqual(infos(lines), [], "two real failures among any number of waits are still a retry");
	reporter.missed("code symbol", "Session.Dispose", "timeout");
	assert.match(infos(lines)[0]!, /Session\.Dispose" had no answer in 3 tries over 0 s \(timeout x3\)/);
});

test("an answer in between starts the count again", () => {
	const lines: LoggedLine[] = [];
	const reporter = new GiveUpReporter(recordingLogger(lines), () => 0);
	for (let index = 0; index < 5; index++) {
		reporter.missed("file name", "Session.cs", "timeout");
		reporter.missed("file name", "Session.cs", "timeout");
		reporter.answered("file name", "Session.cs");
	}
	assert.deepEqual(infos(lines), []);
});

test("a symbol the provider never answers is reported at info after its tries, and each try stays a debug line", async () => {
	const lines: LoggedLine[] = [];
	let now = 0;
	const resolver = new SymbolLinkResolver({ query: async () => null }, { log: recordingLogger(lines), now: () => now });
	for (let index = 0; index < 4; index++) { await resolver.resolve(symbol("Session.Copy"), scope); now += 5_000; }
	assert.equal(infos(lines).length, 1, "one line for four tries");
	assert.match(infos(lines)[0]!, /code symbol "Session\.Copy" had no answer in 3 tries .*no-answer x3/);
	assert.equal(lines.filter(line => line.level === "debug" && line.message.startsWith("code symbol")).length, 4, "the per-lookup lines stay at debug");
	now += GIVE_UP_WINDOW_MS;
	for (let index = 0; index < 3; index++) await resolver.resolve(symbol("Session.Copy"), scope);
	assert.equal(infos(lines).length, 2, "and once more a window later");
});

test("a provider that is not ready is not given up on, a lookup that timed out is", async () => {
	const lines: LoggedLine[] = [];
	const loading = new SymbolLinkResolver({ query: async () => [] }, { log: recordingLogger(lines), probeDelaysMs: [1_000_000] });
	for (let index = 0; index < 5; index++) await loading.resolve(symbol("Session.Copy"), scope);
	assert.deepEqual(infos(lines), [], "a language server that is still loading is a wait");
	assert.equal(lines.filter(line => line.level === "debug" && /parked \(not ready\)/.test(line.message)).length, 5, "each wait stays a debug line");
	const slow: LoggedLine[] = [];
	const hung = new SymbolLinkResolver({ query: () => Promise.withResolvers<null>().promise }, { log: recordingLogger(slow), queryTimeoutMs: 5 });
	for (let index = 0; index < 3; index++) await hung.resolve(symbol("Hang.Forever"), scope);
	assert.match(infos(slow)[0]!, /timeout x3/);
});

test("lookups that file changes keep discarding wait for the settle signal and are never given up on", async () => {
	const lines: LoggedLine[] = [];
	const resolver = new SymbolLinkResolver({ query: async () => { resolver.invalidate("created Library\\x"); return []; } }, { log: recordingLogger(lines), settleMs: 100_000 });
	for (let index = 0; index < 6; index++) assert.deepEqual(await resolver.resolve(symbol("Session.Copy"), scope), { status: "pending" });
	assert.deepEqual(infos(lines).filter(line => line.includes("gave up")), []);
	assert.match(infos(lines)[0]!, /1 lookup under way dropped \(created Library\\x\); asked again once the changes settle/);
	assert.equal(infos(lines).length, 1, "the dropped lookups are one info line per ten seconds");
});

test("a file name whose search keeps failing is reported once", async () => {
	const lines: LoggedLine[] = [];
	const files = new FileNameLinkResolver({ find: async () => null }, { log: recordingLogger(lines), isFile: async () => false, failedTtlMs: 0 });
	for (let index = 0; index < 5; index++) await files.lookup("Session.cs", scope);
	assert.equal(infos(lines).length, 1);
	assert.match(infos(lines)[0]!, /file name "Session\.cs" had no answer in 3 tries .*error x3/);
});

test("a token the host refuses for want of batch capacity gives up with the reason capped", async () => {
	const lines: LoggedLine[] = [];
	const resolver = new SymbolLinkResolver({ query: () => Promise.withResolvers<null>().promise }, { log: recordingLogger(lines), queryTimeoutMs: 1000 });
	const host = { cwd: CWD, roots: () => [CWD], enabled: () => true, isCurrent: () => true, reply: () => {} };
	const running = Array.from({ length: 8 }, (_, index) => handleSymbolLinks({ type: "omp:terminal-link-symbols", requestId: index, tokens: [`Name${"abcdefgh"[index]}x`] }, host, resolver, 30));
	for (let index = 0; index < 3; index++) await handleSymbolLinks({ type: "omp:terminal-link-symbols", requestId: 90 + index, tokens: ["Session.Copy"] }, host, resolver, 30);
	await Promise.all(running);
	assert.equal(infos(lines).filter(line => line.includes("Session.Copy")).length, 1);
	assert.match(infos(lines).find(line => line.includes("Session.Copy"))!, /too many batches at once \(capped\) x3/);
	assert.ok(infos(lines).some(line => line.includes("batch deadline")) === false, "eight single tries are not a give-up");
});

import assert from "node:assert/strict";
import { test } from "node:test";
import type { GuestHostMessage } from "../protocol/messages.ts";
import { parseCodeSymbol } from "../shared/code-symbols.ts";
import type { SymbolLinksRequest } from "../shared/code-symbols.ts";
import { recordingLogger, type LoggedLine } from "../shared/logger.ts";
import { ChatSymbolLinks } from "../webview/lib/chat-symbol-links.ts";
import { SymbolKind, SymbolLinkResolver, handleSymbolLinks } from "./symbol-links.ts";
import type { SymbolSource } from "./symbol-links.ts";

/**
 * The maintainer's reload (2026-10-17, window 3 and 2): the page asks while the C# provider is still loading and files keep
 * changing under the lookups, so the answers are "provider not ready" and "invalidated"; the provider is ready some seconds
 * later and the span must become a link without any further user action. The page, the host handler and the resolver are the real ones.
 */

const CWD = "D:\\Work\\omp-vscode";
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function until(condition: () => boolean, what: string): Promise<void> {
	for (let turn = 0; turn < 200; turn++) {
		if (condition()) return;
		await sleep(10);
	}
	assert.fail(`timed out waiting for ${what}`);
}

test("a span asked during warm-up (provider not ready, lookups invalidated) becomes a link once the provider is ready, without the info give-up line", async () => {
	const lines: LoggedLine[] = [];
	let phase: "churn" | "loading" | "loaded" = "churn";
	let lookups = 0;
	const entryOf = { name: "Dispose", kind: SymbolKind.Method, container: "SessionService", path: `${CWD}\\Session.cs`, line: 41, column: 17 };
	const source: SymbolSource = {
		async query() {
			lookups++;
			// Roslyn loading a Unity project: files change under every lookup at first, then it is quiet but still empty, then it answers.
			if (phase === "churn") { resolver.invalidate("created Library\\x"); return []; }
			return phase === "loaded" ? Object.assign([entryOf], { total: 1 }) : [];
		},
	};
	let page!: ChatSymbolLinks;
	const resolver = new SymbolLinkResolver(source, {
		log: recordingLogger(lines), probeDelaysMs: [10], settleMs: 20, minRetryMs: 10,
		onRetry: () => deliver({ type: "omp:terminal-link-symbols-retry" }),
	});
	let deliver: (message: GuestHostMessage) => void = () => {};
	page = new ChatSymbolLinks({
		post(message) {
			if (message.type !== "omp:terminal-link-symbols") return true;
			void handleSymbolLinks(message as unknown as SymbolLinksRequest, {
				cwd: CWD, roots: () => [CWD], enabled: () => true, isCurrent: () => true,
				reply: reply => setImmediate(() => deliver(reply)),
			}, resolver);
			return true;
		},
		subscribe(listener) { deliver = listener; return () => {}; },
	}, { batchMs: 2, retryMs: 5 });
	// What the span does: ask when mounted, and again whenever the page says tokens may be asked again.
	const token = "SessionService.Dispose";
	assert.ok(parseCodeSymbol(token) !== null);
	const ask = () => { void page.resolve(token); };
	page.subscribe(() => { if (page.peek(token) === undefined) ask(); });
	ask();
	await sleep(150);
	assert.equal(page.peek(token)?.target ?? null, null, "still loading: plain text, nothing decided");
	phase = "loading";
	await sleep(150);
	assert.equal(page.peek(token)?.target ?? null, null);
	phase = "loaded";
	await until(() => page.peek(token)?.target === "Session.cs:41:17", "the span to become a link");
	assert.deepEqual(lines.filter(line => line.message.includes("gave up")), [], "warm-up is a wait, not a give-up");
	assert.ok(lookups < 60, `the waiting stayed bounded (${lookups} provider calls)`);
	page.dispose();
});

/**
 * The maintainer's reload (2026-10-18, 19:58-20:25): three Chat tabs were restored while the C# provider (Roslyn, a Unity project) was loading for
 * three minutes, and each asked about every symbol of its replies at once. The provider held every slot with calls that did not answer; the
 * lookups beyond the waiting line were refused (`queue full`), and a refusal was counted as a failed try, so 109 names "gave up" and whole replies stayed plain.
 * A refused lookup is a wait: nothing is cached, no try is used, and the page is asked again once the line has drained.
 */
test("three restored pages with hundreds of symbols against a provider that is loading: no give-up, bounded provider work, every span a link once it is ready", async () => {
	const lines: LoggedLine[] = [];
	const statuses = new Map<string, number>();
	const hung: (() => void)[] = [];
	let loaded = false;
	let callsWhileLoading = 0;
	const entryOf = (name: string) => ({ name, kind: SymbolKind.Class, container: "project OmpDesk (net8.0)", path: `${CWD}\\${name}.cs`, line: 3, column: 5 });
	const source: SymbolSource = {
		query(text) {
			if (loaded) return sleep(1).then(() => Object.assign([entryOf(text)], { total: 1 }));
			callsWhileLoading++;
			return new Promise(resolve => { hung.push(() => resolve(Object.assign([entryOf(text)], { total: 1 }))); });
		},
	};
	const pages: { page: ChatSymbolLinks; deliver: (message: GuestHostMessage) => void; tokens: string[] }[] = [];
	const resolver = new SymbolLinkResolver(source, {
		log: recordingLogger(lines), probeDelaysMs: [10], settleMs: 20, minRetryMs: 10, queryTimeoutMs: 40,
		onRetry: () => { for (const { deliver } of pages) deliver({ type: "omp:terminal-link-symbols-retry" }); },
	});
	for (let index = 0; index < 3; index++) {
		const tokens = Array.from({ length: 100 }, (_, number) => `Tab${index}Symbol${number}`);
		const entry = { tokens, deliver: (_message: GuestHostMessage) => {}, page: undefined as unknown as ChatSymbolLinks };
		entry.page = new ChatSymbolLinks({
			post(message) {
				if (message.type !== "omp:terminal-link-symbols") return true;
				void handleSymbolLinks(message as unknown as SymbolLinksRequest, {
					cwd: CWD, roots: () => [CWD], enabled: () => true, isCurrent: () => true,
					reply: reply => { for (const result of reply.results) statuses.set(result.status, (statuses.get(result.status) ?? 0) + 1); setImmediate(() => entry.deliver(reply)); },
				}, resolver);
				return true;
			},
			subscribe(listener) { entry.deliver = listener; return () => {}; },
		}, { batchMs: 2, retryMs: 5 });
		// What the spans do: ask when mounted, and again whenever the page says tokens may be asked again.
		const askAll = () => { for (const token of tokens) if (entry.page.peek(token) === undefined) void entry.page.resolve(token); };
		entry.page.subscribe(askAll);
		pages.push(entry);
		askAll();
	}
	await sleep(400);
	assert.ok(callsWhileLoading <= 4, `a provider that does not answer is asked by its four slots only (${callsWhileLoading} calls)`);
	assert.equal(pages.every(({ page, tokens }) => tokens.every(token => page.peek(token)?.target === undefined)), true, "still loading: plain text, nothing decided");
	loaded = true;
	hung.splice(0).forEach(release => release());
	const linked = () => pages.every(({ page, tokens }) => tokens.every(token => page.peek(token)?.target === `${token}.cs:3:5`));
	for (let turn = 0; turn < 600 && !linked(); turn++) await sleep(10);
	assert.ok(linked(), `every span of every page became a link (${pages.map(({ page, tokens }) => tokens.filter(token => page.peek(token) !== undefined).length).join(", ")} of 100 answered; replies ${JSON.stringify([...statuses])})`);
	assert.deepEqual(lines.filter(line => line.message.includes("gave up")), [], "waiting for a loading provider and for a turn in its line is no failed try");
	assert.equal(statuses.get("unavailable") ?? 0, 0, "no token was answered as a failure");
	for (const { page } of pages) page.dispose();
});

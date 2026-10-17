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

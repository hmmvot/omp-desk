import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { GUEST_PROTOCOL_VERSION } from "../webview/messages.ts";
import type { ChatWebviewMessage } from "../webview/chat-messages.ts";
import type { ChatPage } from "./chat-runtime.ts";
import { DETAIL_READ_ONLY_REASON, DETAIL_VIEW_TYPE, DetailTabs, type DetailPanel, type DetailTabsHost } from "./detail-tabs.ts";
import type { DetailTarget } from "../webview/detail-target.ts";

class FakePanel implements DetailPanel {
	revealed = 0;
	title = "";
	disposed = false;
	posted: unknown[] = [];
	#receive: ((message: unknown) => void) | null = null;
	#dispose: (() => void) | null = null;
	readonly webview = {
		postMessage: async (message: unknown): Promise<boolean> => { this.posted.push(message); return true; },
		onDidReceiveMessage: (listener: (message: unknown) => void) => { this.#receive = listener; return { dispose() {} }; },
	};
	reveal(): void { this.revealed += 1; }
	dispose(): void { if (this.disposed) return; this.disposed = true; this.#dispose?.(); }
	onDidDispose(listener: () => void): { dispose(): void } { this.#dispose = listener; return { dispose() {} }; }
	send(message: unknown): Promise<void> {
		this.#receive?.(message);
		const { promise, resolve } = Promise.withResolvers<void>();
		setImmediate(resolve);
		return promise;
	}
}

function fixture() {
	const panels: FakePanel[] = [];
	const attached: { conversation: string; page: ChatPage; detached: boolean }[] = [];
	const handled: { conversation: string; message: ChatWebviewMessage }[] = [];
	const logs: string[] = [];
	const opened: { url: string; mode: string }[] = [];
	const host: DetailTabsHost = {
		createPanel() { const panel = new FakePanel(); panels.push(panel); return panel; },
		attachPage(conversation, page) {
			const record = { conversation, page, detached: false };
			attached.push(record);
			return () => { record.detached = true; };
		},
		async handleMessage(conversation, message) { handled.push({ conversation, message }); return "accepted"; },
		async openUrl(url, mode) { opened.push({ url, mode }); },
		log: message => { logs.push(message); },
	};
	return { tabs: new DetailTabs(host), panels, attached, handled, logs, opened };
}

const todo: DetailTarget = { kind: "todo" };
const agent = (agentId: string): DetailTarget => ({ kind: "agent", agentId });

describe("detail tab registry", () => {
	it("creates one tab per (conversation, kind, agent) and reveals instead of duplicating", () => {
		const { tabs, panels } = fixture();
		assert.equal(tabs.open("tab:a", todo), "created");
		assert.equal(tabs.open("tab:a", todo), "revealed");
		assert.equal(tabs.open("tab:a", agent("Anna")), "created");
		assert.equal(tabs.open("tab:a", agent("Anna")), "revealed");
		assert.equal(tabs.open("tab:a", agent("Bob")), "created");
		assert.equal(tabs.open("tab:a", { kind: "agents" }), "created");
		assert.equal(tabs.open("tab:b", todo), "created");
		assert.equal(panels.length, 5);
		assert.equal(panels[0]!.revealed, 1);
		assert.equal(panels[1]!.revealed, 1);
		assert.equal(tabs.size, 5);
	});

	it("renames every detail of only the matching conversation without replacing panels", () => {
		const { tabs, panels } = fixture();
		tabs.open("tab:a", todo);
		tabs.open("tab:a", agent("Worker"));
		tabs.open("tab:b", todo);
		tabs.renameConversation("tab:a", "Fix the login layout");
		assert.equal(panels[0]?.title, "TODO · Fix the login layout");
		assert.equal(panels[1]?.title, "Worker · Fix the login layout");
		assert.equal(panels[2]?.title, "");
		assert.equal(tabs.size, 3);
		assert.ok(panels.every(panel => !panel.disposed));
	});

	it("keys cannot collide through crafted ids", () => {
		const { tabs, panels } = fixture();
		tabs.open("tab:a", agent("x\u241fy"));
		tabs.open("tab:a", agent("x"));
		assert.equal(panels.length, 2);
	});

	it("attaches a read-only page only once the document announces itself with the current protocol", async () => {
		const { tabs, panels, attached, logs } = fixture();
		tabs.open("tab:a", todo);
		assert.equal(attached.length, 0, "nothing is sent to a document that may not be listening");
		await panels[0]!.send({ type: "omp:ready", protocolVersion: GUEST_PROTOCOL_VERSION + 1 });
		assert.equal(attached.length, 0);
		assert.ok(logs.some(line => line.includes("guest protocol")));
		await panels[0]!.send({ type: "omp:ready", protocolVersion: GUEST_PROTOCOL_VERSION });
		assert.equal(attached.length, 1);
		assert.equal(attached[0]!.conversation, "tab:a");
		assert.equal(attached[0]!.page.readOnlyReason?.(), DETAIL_READ_ONLY_REASON);
		// A reloaded document announces again: the previous route is replaced.
		await panels[0]!.send({ type: "omp:ready", protocolVersion: GUEST_PROTOCOL_VERSION });
		assert.equal(attached.length, 2);
		assert.equal(attached[0]!.detached, true);
		assert.equal(attached[1]!.detached, false);
	});

	it("forwards pages to the panel and drops them once it is gone", async () => {
		const { tabs, panels, attached } = fixture();
		tabs.open("tab:a", todo);
		await panels[0]!.send({ type: "omp:ready", protocolVersion: GUEST_PROTOCOL_VERSION });
		const page = attached[0]!.page;
		assert.equal(page.post({ type: "omp:chat-display-preferences", epoch: { nonce: "n", counter: 1 }, toolCallDetail: "overview", accessibilitySupport: false }), "sent");
		assert.equal(panels[0]!.posted.length, 1);
		panels[0]!.dispose();
		assert.equal(page.post({ type: "omp:chat-display-preferences", epoch: { nonce: "n", counter: 1 }, toolCallDetail: "overview", accessibilitySupport: false }), "dropped");
		assert.equal(attached[0]!.detached, true);
		assert.equal(tabs.size, 0);
		assert.equal(tabs.open("tab:a", todo), "created", "a closed tab can be opened again");
	});

	it("serves only the read-only child read; every other request is dropped before the runtime", async () => {
		const { tabs, panels, handled, logs } = fixture();
		tabs.open("tab:a", agent("Anna"));
		const requestId = "a".repeat(32);
		const epoch = { nonce: "n", counter: 1 };
		await panels[0]!.send({ type: "omp:chat-subagent-read", requestId, epoch, subagentId: "Anna", fromByte: 0 });
		assert.equal(handled.length, 1);
		assert.equal(handled[0]!.conversation, "tab:a");
		for (const message of [
			{ type: "omp:chat-prompt", requestId, epoch, text: "hello" },
			{ type: "omp:chat-abort", requestId, epoch },
			{ type: "omp:chat-resume", requestId },
			{ type: "omp:chat-tool-detail", epoch },
			{ type: "omp:chat-load-older", requestId, epoch },
			{ type: "omp:session-mode", mode: "terminal" },
			{ type: "omp:control-request", scope: "x".repeat(32), requestId, action: "snapshot" },
		]) await panels[0]!.send(message);
		assert.equal(handled.length, 1, "nothing but the child read reached the runtime");
		assert.ok(logs.length >= 7);
	});

	it("opens or reveals a sibling tab of the same conversation when a detail page asks, and never reaches the runtime", async () => {
		const { tabs, panels, handled } = fixture();
		tabs.open("tab:a", { kind: "agents" });
		await panels[0]!.send({ type: "omp:open-detail", kind: "agent", agentId: "Anna" });
		assert.equal(tabs.size, 2, "the roster row opened that agent's own tab");
		assert.equal(panels.length, 2);
		await panels[0]!.send({ type: "omp:open-detail", kind: "agent", agentId: "Anna" });
		assert.equal(tabs.size, 2, "asking again reveals the open tab instead of opening a second");
		assert.equal(panels[1]!.revealed, 1);
		await panels[1]!.send({ type: "omp:open-detail", kind: "todo" });
		assert.equal(tabs.size, 3);
		assert.equal(handled.length, 0);
	});

	it("opens a clicked web link in the mode the page asked for, and refuses every other link request", async () => {
		const { tabs, panels, handled, logs, opened } = fixture();
		tabs.open("tab:a", todo);
		await panels[0]!.send({ type: "omp:terminal-link-open", requestId: 1, target: "https://example.com", mode: "editor" });
		await panels[0]!.send({ type: "omp:terminal-link-open", requestId: 2, target: "https://example.com/a?b=1", mode: "external" });
		assert.deepEqual(opened, [{ url: "https://example.com/", mode: "editor" }, { url: "https://example.com/a?b=1", mode: "external" }]);
		for (const message of [
			{ type: "omp:terminal-link-open", requestId: 3, target: "javascript:alert(1)", mode: "editor" },
			{ type: "omp:terminal-link-open", requestId: 4, target: "command:workbench.action.reloadWindow" },
			{ type: "omp:terminal-link-open", requestId: 5, target: "data:text/html,x", mode: "external" },
			{ type: "omp:terminal-link-open", requestId: 6, target: "src/a.ts" },
			{ type: "omp:terminal-link-open", requestId: 7, target: "https://example.com", mode: "tab" },
			{ type: "omp:terminal-link-validate", requestId: 8, target: "src/a.ts" },
		]) await panels[0]!.send(message);
		assert.equal(opened.length, 2, "nothing but the two http(s) links opened");
		assert.equal(handled.length, 0);
		assert.ok(logs.length >= 6);
	});

	it("closes every detail tab of a conversation that goes away, and no other", () => {
		const { tabs, panels } = fixture();
		tabs.open("tab:a", todo);
		tabs.open("tab:a", agent("Anna"));
		tabs.open("tab:b", todo);
		tabs.closeConversation("tab:a");
		assert.deepEqual(panels.map(panel => panel.disposed), [true, true, false]);
		assert.equal(tabs.size, 1);
		tabs.dispose();
		assert.equal(panels[2]!.disposed, true);
	});
});

describe("detail view type", () => {
	it("never matches the session editor's when-clauses", () => {
		const manifest = JSON.parse(readFileSync("package.json", "utf8")) as { contributes: { menus: Record<string, { when?: string }[]>; keybindings: { when?: string }[] } };
		const clauses = [...Object.values(manifest.contributes.menus).flat(), ...manifest.contributes.keybindings]
			.map(entry => entry.when ?? "")
			.filter(when => when.includes("activeWebviewPanelId"));
		assert.ok(clauses.length > 0);
		const pattern = /activeWebviewPanelId\s*=~\s*\/(.+?)\//g;
		let matches = 0;
		for (const when of clauses) {
			for (const found of when.matchAll(pattern)) {
				matches += 1;
				assert.equal(new RegExp(found[1]!).test(DETAIL_VIEW_TYPE), false, when);
			}
		}
		assert.ok(matches > 0);
	});
});

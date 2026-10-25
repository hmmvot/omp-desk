/**
 * Chat composer keys never scroll the page (owned headless Chromium, real CDP key events): with the caret or a selection in the
 * composer, in prose or in a fenced code block that scrolls inside the field, PageUp / PageDown / Shift+Page keys / Ctrl+Home /
 * Ctrl+End / arrows at the field's edge may move the caret and the field's own scroll, and nothing else. The document, the body,
 * #root, the chat column and every other element that is not a scroller stay at scroll position 0, so the transcript and the
 * area under the composer stay where they are.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { test } from "node:test";
import { build } from "esbuild";
import type * as vscode from "vscode";
import { createGuestHtml } from "../host/guest-webview.ts";

const browserPath = [process.env.OMP_TEST_CHROMIUM,
	"C:/Program Files/Google/Chrome/Application/chrome.exe",
	"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
	"/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome",
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].find((candidate): candidate is string => candidate !== undefined && existsSync(candidate));

class Cdp {
	#next = 0;
	#pending = new Map<number, { resolve(value: Record<string, unknown>): void; reject(error: Error): void }>();
	#events = new Map<string, (() => void)[]>();
	readonly socket: WebSocket;
	constructor(socket: WebSocket) {
		this.socket = socket;
		socket.addEventListener("message", event => {
			const frame = JSON.parse(String(event.data)) as { id?: number; method?: string; result?: Record<string, unknown>; error?: { message: string } };
			if (frame.id === undefined) {
				if (frame.method) { for (const resolve of this.#events.get(frame.method) ?? []) resolve(); this.#events.delete(frame.method); }
				return;
			}
			const pending = this.#pending.get(frame.id);
			if (!pending) return;
			this.#pending.delete(frame.id);
			if (frame.error) pending.reject(new Error(frame.error.message)); else pending.resolve(frame.result ?? {});
		});
		socket.addEventListener("close", () => {
			for (const pending of this.#pending.values()) pending.reject(new Error("owned browser connection closed"));
			this.#pending.clear();
		});
	}
	static async connect(url: string): Promise<Cdp> {
		const socket = new WebSocket(url);
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		socket.addEventListener("open", () => resolve(), { once: true });
		socket.addEventListener("error", () => reject(new Error("headless browser connection failed")), { once: true });
		await promise;
		return new Cdp(socket);
	}
	call(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
		const id = ++this.#next;
		const { promise, resolve, reject } = Promise.withResolvers<Record<string, unknown>>();
		this.#pending.set(id, { resolve, reject });
		this.socket.send(JSON.stringify({ id, method, params }));
		return promise;
	}
	event(method: string): Promise<void> {
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#events.set(method, [...(this.#events.get(method) ?? []), resolve]);
		return promise;
	}
	async evaluate<T>(expression: string): Promise<T> {
		const result = await this.call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: true });
		if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
		const remote = result.result;
		assert.ok(remote !== null && typeof remote === "object");
		return ("value" in remote ? remote.value : undefined) as T;
	}
	async wait(expression: string): Promise<void> {
		await this.evaluate(`(async () => {
		 const deadline = performance.now() + 15000;
		 while (!(${expression})) { if (performance.now() > deadline) throw new Error('condition timed out: '+${JSON.stringify(expression)}); await new Promise(resolve => setTimeout(resolve, 20)); }
		})()`);
	}
}

const fixture = `
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { guestTransport, readCspNonce } from "./bridge";
import { ChatClient } from "./lib/chat-client";
import { createChatModel, snapshotOf } from "../chat/model";
import { splitChatSnapshot } from "../protocol/chat-messages";
import { injectGuestStyles } from "./styles";
import { attachSessionView } from "./lib/session-view";
import { adoptNonceForCreatedStyles } from "./lib/nonce-styles";
import { installComposerDriver } from "./test-support/composer-driver";
attachSessionView(guestTransport);
installComposerDriver(window);
const epoch = { nonce: "host-ui-test", counter: 1 };
const client = new ChatClient(guestTransport); client.attach(guestTransport);
const liveState = { model: { provider: "one", id: "old", name: "Original", contextWindow: 1000000 }, thinkingLevel: "low", isStreaming: false, isCompacting: false, queuedMessageCount: 0,
 contextUsage: { tokens: 40700, contextWindow: 1000000, percent: 4.07 } };
let current = { ...snapshotOf(createChatModel(), epoch), phase: "live", state: liveState };
function receive(message) { window.dispatchEvent(new MessageEvent("message", { data: message })); }
function push(patch = {}) { current = { ...current, ...patch }; const parts = splitChatSnapshot(current, "ui-snapshot");
 receive(parts.snapshot); for (const chunk of parts.chunks) receive(chunk);
}
const row = (id, message) => ({ type: "message", id, parentId: null, timestamp: "2026-10-19T00:00:00Z", message: { timestamp: 1, ...message } });
window.ui = {
 token: location.search, push,
 view(patch = {}) { receive({ type: "omp:session-view", mode: "chat", title: "Owned UI session", running: true, starting: false, stopping: false, canSwitch: true, reason: null, ...patch }); },
 prompts(...texts) { push({ entries: texts.map((text, index) => row("u" + index, { role: "user", content: text })), durableCount: texts.length, working: false, settled: true }); },
};
// Every element that is scrolled, by a short path: a page that is scrolled anywhere but inside the composer's own field fails.
window.scrolled = () => {
 const out = [];
 const scroller = document.scrollingElement;
 if (scroller && scroller.scrollTop !== 0) out.push("scrollingElement:" + scroller.scrollTop);
 for (const el of document.querySelectorAll("*")) {
  if (el.closest(".omp-composer-input")) continue;
  if (el.closest(".omp-transcript")) continue;
  if (el.scrollTop !== 0 || el.scrollLeft !== 0) out.push(el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + "." + String(el.className).split(" ").join(".") + " > " + (el.firstElementChild?.className ?? "") + ":" + el.scrollTop + "," + el.scrollLeft + " overflow=" + getComputedStyle(el).overflowY);
 }
 return out;
};
window.frame = async (count = 1) => { for (let index = 0; index < count; index++) { const gate = Promise.withResolvers(); requestAnimationFrame(gate.resolve); await gate.promise; } };
const nonce=readCspNonce(); adoptNonceForCreatedStyles(nonce); injectGuestStyles(nonce);
createRoot(document.getElementById("root")).render(<App client={client} />); window.ui.view(); push({ state: liveState });
`;

const CODE = Array.from({ length: 60 }, (_, index) => `const value${index} = compute(${index}); // composer page scroll line ${index}`).join("\n");
const PROSE = Array.from({ length: 40 }, (_, index) => `Composer prose line ${index}`).join("\n");

// Skipped when no Chromium-based browser is found; set OMP_TEST_CHROMIUM to point at one.
test("chat composer: PageUp, PageDown and the other navigation keys never scroll the page", { skip: browserPath === undefined, timeout: 280_000 }, async t => {
	const bundled = await build({ stdin: { contents: fixture, loader: "tsx", resolveDir: join(process.cwd(), "src/webview") },
		bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic", loader: { ".css": "text" }, define: { "process.env.NODE_ENV": '"production"' } });
	const script = bundled.outputFiles[0]!.text;
	const server = createServer((request, response) => {
		const pathname = new URL(request.url ?? "/", "http://fixture").pathname;
		if (pathname === "/codicons/codicon.css" || pathname === "/codicons/codicon.ttf") {
			const file = pathname.endsWith(".css") ? "codicon.css" : "codicon.ttf";
			response.setHeader("Content-Type", file.endsWith(".css") ? "text/css" : "font/ttf");
			response.end(readFileSync(join(process.cwd(), "node_modules/@vscode/codicons/dist", file)));
			return;
		}
		if (pathname === "/ui.js") { response.setHeader("Content-Type", "text/javascript"); response.end(script); return; }
		response.setHeader("Content-Type", "text/html");
		const webview = {
			cspSource: "'self'",
			asWebviewUri: (uri: { path: string }) => ({ toString: () => uri.path.endsWith(".js") ? "/ui.js" : "/codicons/codicon.css" }),
		} as unknown as vscode.Webview;
		const extensionUri = { path: "/extension", with({ path }: { path: string }) { return { path }; } } as unknown as vscode.Uri;
		const html = createGuestHtml(webview, extensionUri, "tab:2c26b46b-68ff-4c1d-a3d8-1e0f9a0b7c6d", null);
		const nonce = /<script nonce="([^"]+)"/.exec(html)![1]!;
		response.end(html.replace("</head>", `<style nonce="${nonce}">:root {
			--vscode-editor-background:#1e1e1e;--vscode-editor-foreground:#dddddd;--vscode-foreground:#dddddd;--vscode-editorWidget-background:#252526;
			--vscode-button-background:#007acc;--vscode-button-foreground:white;--vscode-input-background:#3c3c3c;--vscode-focusBorder:#007fd4;
			--vscode-input-foreground:#ddd;--vscode-panel-border:#555;--vscode-font-family:Arial;--vscode-font-size:13px;
		}</style><script nonce="${nonce}">window.sent=[];window.errors=[];window.addEventListener("error",event=>window.errors.push(event.message));
		window.acquireVsCodeApi=()=>({postMessage(message){window.sent.push(message)},setState(){}});</script>
		</head>`));
	});
	server.listen(0, "127.0.0.1"); await once(server, "listening");
	const address = server.address(); assert.ok(address && typeof address !== "string");
	const url = `http://127.0.0.1:${address.port}/`;
	const profile = await mkdtemp(join(tmpdir(), "omp-page-scroll-ui-"));
	const child = spawn(browserPath!, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
		"--disable-extensions", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
	let browser: Cdp | undefined;
	let page: Cdp | undefined;
	try {
		const readiness = Promise.withResolvers<string>();
		let stderr = "";
		const timer = setTimeout(() => readiness.reject(new Error("owned headless browser did not publish a DevTools endpoint")), 60_000);
		child.once("error", error => { clearTimeout(timer); readiness.reject(error); });
		child.stderr!.on("data", data => {
			stderr += String(data);
			const match = /DevTools listening on (ws:\/\/\S+)/.exec(stderr);
			if (match) { clearTimeout(timer); readiness.resolve(match[1]!); }
		});
		const endpoint = await readiness.promise;
		browser = await Cdp.connect(endpoint);
		const target = await browser.call("Target.createTarget", { url: "about:blank" });
		const targets = await (await fetch(`http://${new URL(endpoint).host}/json/list`)).json() as { id: string; webSocketDebuggerUrl: string }[];
		page = await Cdp.connect(targets.find(row => row.id === target.targetId)!.webSocketDebuggerUrl);
		const ui = page;
		await ui.call("Page.enable");
		await ui.call("Emulation.setDeviceMetricsOverride", { width: 900, height: 800, deviceScaleFactor: 1, mobile: false });
		const press = async (key: string, code: string, windowsVirtualKeyCode: number, modifiers = 0): Promise<void> => {
			await ui.call("Input.dispatchKeyEvent", { type: "rawKeyDown", key, code, windowsVirtualKeyCode, modifiers });
			await ui.call("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode, modifiers });
			await ui.evaluate("window.frame(3)");
		};
		const SHIFT = 8;
		const CTRL = 2;
		const KEYS: [string, () => Promise<void>][] = [
			["PageUp", () => press("PageUp", "PageUp", 33)],
			["PageDown", () => press("PageDown", "PageDown", 34)],
			["Shift+PageUp", () => press("PageUp", "PageUp", 33, SHIFT)],
			["Shift+PageDown", () => press("PageDown", "PageDown", 34, SHIFT)],
			["Ctrl+Home", () => press("Home", "Home", 36, CTRL)],
			["Ctrl+End", () => press("End", "End", 35, CTRL)],
			["ArrowUp", () => press("ArrowUp", "ArrowUp", 38)],
			["ArrowDown", () => press("ArrowDown", "ArrowDown", 40)],
			["PageUp", () => press("PageUp", "PageUp", 33)],
			["PageUp", () => press("PageUp", "PageUp", 33)],
		];
		async function open(name: string, draft: string, caret: number | [number, number]): Promise<void> {
			const loaded = ui.event("Page.loadEventFired");
			await ui.call("Page.navigate", { url: `${url}?${name}` });
			await loaded;
			await ui.wait(`window.ui?.token === '?${name}' && document.querySelector('.omp-composer-input')`);
			await ui.evaluate(`window.ui.prompts(...Array.from({length:60},(_, index)=>'Transcript prompt '+index+' for the omp-vscode chat page'))`);
			await ui.wait("document.querySelector('.omp-row--user')");
			await ui.evaluate(`window.composer.focus(); window.composer.setText(${JSON.stringify(draft)})`);
			await ui.evaluate("window.frame(2)");
			const [from, to] = Array.isArray(caret) ? caret : [caret, caret];
			await ui.evaluate(`window.composer.select(${from}, ${to})`);
			await ui.evaluate("window.frame(2)");
		}
		const block = `Notes\n\`\`\`ts\n${CODE}\n\`\`\``;
		const middle = block.indexOf("line 30");
		const cases: { name: string; draft: string; caret: number | [number, number]; code: boolean }[] = [
			{ name: "caret in the middle of a long code block", draft: block, caret: middle, code: true },
			{ name: "selected text inside a long code block", draft: block, caret: [middle - 20, middle + 20], code: true },
			{ name: "caret at the first line of a code block", draft: block, caret: block.indexOf("```ts") + 6, code: true },
			{ name: "caret in long plain text", draft: PROSE, caret: PROSE.indexOf("line 20"), code: false },
			{ name: "selection in long plain text", draft: PROSE, caret: [PROSE.indexOf("line 10"), PROSE.indexOf("line 12")], code: false },
		];
		for (const scenario of cases) {
			await t.test(scenario.name, async () => {
				await open(`case-${scenario.name.replaceAll(" ", "-")}`, scenario.draft, scenario.caret);
				if (scenario.code) assert.match(await ui.evaluate<string>("document.querySelector('.omp-composer-hint--code')?.textContent ?? ''"), /^Code block/, "the hint names the code block");
				assert.ok(await ui.evaluate<boolean>("(()=>{const f=window.composer.el();return f.scrollHeight>f.clientHeight})()"), "the field itself scrolls");
				assert.deepEqual(await ui.evaluate("window.scrolled()"), [], "nothing is scrolled before a key");
				const transcriptTop = await ui.evaluate<number>("document.querySelector('.omp-transcript').getBoundingClientRect().top");
				const composerTop = await ui.evaluate<number>("document.querySelector('.omp-composer').getBoundingClientRect().top");
				for (const [name, run] of KEYS) {
					await run();
					assert.deepEqual(await ui.evaluate("window.scrolled()"), [], `${name}: no element outside the field and the transcript scrolls`);
					assert.equal(await ui.evaluate("document.querySelector('.omp-transcript').getBoundingClientRect().top"), transcriptTop, `${name}: the transcript stays in place`);
					assert.equal(await ui.evaluate("document.querySelector('.omp-composer').getBoundingClientRect().top"), composerTop, `${name}: the composer stays in place`);
					assert.equal(await ui.evaluate("window.composer.focused()"), true, `${name}: the field keeps the focus`);
				}
				assert.deepEqual(await ui.evaluate("window.errors"), []);
			});
		}
		await t.test("PageUp and PageDown move the caret and the field's own scroll like an editor", async () => {
			await open("editor-paging", block, middle);
			const state = (): Promise<{ at: number; top: number }> => ui.evaluate("({at:window.composer.selection().start,top:window.composer.el().scrollTop})");
			const before = await state();
			await press("PageDown", "PageDown", 34);
			const down = await state();
			assert.ok(down.at > before.at, "PageDown moves the caret toward the end");
			await press("PageUp", "PageUp", 33);
			await press("PageUp", "PageUp", 33);
			const up = await state();
			assert.ok(up.at < down.at, "PageUp moves the caret toward the start");
			assert.deepEqual(await ui.evaluate("window.scrolled()"), []);
		});
	} finally {
		page?.socket.close();
		browser?.socket.close();
		child.kill();
		server.close();
		await rm(profile, { recursive: true, force: true }).catch(() => undefined);
	}
});

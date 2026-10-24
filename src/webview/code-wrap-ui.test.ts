/** The Wrap lines button on code blocks in Chat, in the real React app in an owned headless Chromium. */
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
import { THEMES } from "./theme-ui-fixtures.ts";

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
	/** Polls on animation frames: a resize or layout change need not mutate the DOM before the condition holds. */
	async wait(expression: string): Promise<void> {
		await this.evaluate(`new Promise((resolve, reject) => { const stop = Date.now() + 30000; const check = () => { if (${expression}) resolve(); else if (Date.now() > stop) reject(new Error('condition timed out: ' + ${JSON.stringify(expression)})); else requestAnimationFrame(check); }; check(); })`);
	}
	async settle(): Promise<void> {
		await this.evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 0))))");
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
attachSessionView(guestTransport);
const epoch = { nonce: "host-ui-test", counter: 1 };
const client = new ChatClient(guestTransport); client.attach(guestTransport);
let current = { ...snapshotOf(createChatModel(), epoch), phase: "live", state: {
 model: { provider: "one", id: "old", name: "Original", contextWindow: 1000000 }, thinkingLevel: "low", isStreaming: false, isCompacting: false, queuedMessageCount: 0,
 contextUsage: { tokens: 40700, contextWindow: 1000000, percent: 4.07 }
} };
function receive(message) { window.dispatchEvent(new MessageEvent("message", { data: message })); }
function push(patch = {}) { current = { ...current, ...patch }; const parts = splitChatSnapshot(current, "ui-snapshot");
 receive(parts.snapshot); for (const chunk of parts.chunks) receive(chunk);
}
window.ui = {
 token: location.search, current: () => current, receive, push,
 view(patch = {}) { receive({ type: "omp:session-view", mode: "chat", title: "Owned UI session", running: true, starting: false, stopping: false, canSwitch: true, reason: null, ...patch }); },
};
const nonce=readCspNonce(); adoptNonceForCreatedStyles(nonce); injectGuestStyles(nonce);
createRoot(document.getElementById("root")).render(<App client={client} />); window.ui.view(); push();
`;

function themeRules(name: string): string {
	const theme = THEMES.find(candidate => candidate.name === name);
	assert.ok(theme, name);
	const tokens = { "--vscode-editor-background": theme.tokens["--vscode-editor-background"], "--vscode-editor-foreground": theme.tokens["--vscode-foreground"], ...theme.tokens };
	return Object.entries(tokens).filter(([, value]) => value !== "").map(([key, value]) => `${key}:${value}`).join(";");
}

const LONG = `const longLine = "${"word ".repeat(80)}";`;
const SHORT = "const a = 1;";
/** Fits a 700 px page and overflows a 320 px one. */
const MEDIUM = `const medium = "${"ab ".repeat(14)}";`;
const entry = (id: string, parentId: string | null, text: string): string => `{type:'message',id:${JSON.stringify(id)},parentId:${JSON.stringify(parentId)},timestamp:'2026-10-13T00:00:00.000Z',message:{role:'assistant',model:'m',timestamp:2,stopReason:'stop',content:[{type:'text',text:${JSON.stringify(text)}}]}}`;
const push = (entries: string[]): string => `window.ui.push({entries:[${entries.join(",")}],durableCount:${entries.length},working:false,settled:true})`;
const code = (source: string): string => `Here:\n\n\`\`\`ts\n${source}\n\`\`\`\n\nDone.`;
const two = (first: string, second: string): string => `One:\n\n\`\`\`ts\n${first}\n\`\`\`\n\nTwo:\n\n\`\`\`ts\n${second}\n\`\`\`\n`;

// Skipped when no Chromium-based browser is found; set OMP_TEST_CHROMIUM to point at one.
test("wrap lines on code blocks in Chat", { skip: browserPath === undefined, timeout: 240_000 }, async t => {
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
		response.end(html.replace("</head>", `<style nonce="${nonce}">:root{${themeRules("Dark Modern")};--vscode-font-family:Arial;--vscode-font-size:13px;--vscode-editor-font-family:Consolas, "Courier New", monospace}</style>
		<script nonce="${nonce}">window.sent=[];window.errors=[];
		window.addEventListener("error",event=>window.errors.push(event.message));
		window.acquireVsCodeApi=()=>({postMessage(message){window.sent.push(message)},setState(){}});</script>
		</head>`));
	});
	server.listen(0, "127.0.0.1"); await once(server, "listening");
	const address = server.address(); assert.ok(address && typeof address !== "string");
	const url = `http://127.0.0.1:${address.port}/`;
	const profile = await mkdtemp(join(tmpdir(), "omp-code-wrap-ui-"));
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
		const resize = (width: number): Promise<unknown> => ui.call("Emulation.setDeviceMetricsOverride", { width, height: 700, deviceScaleFactor: 1, mobile: false });
		await resize(700);
		async function open(name: string): Promise<void> {
			const loaded = ui.event("Page.loadEventFired");
			await ui.call("Page.navigate", { url: `${url}?${name}` });
			await loaded;
			await ui.wait(`window.ui?.token === '?${name}' && document.querySelector('#root').firstElementChild`);
		}
		const buttons = (): Promise<{ pressed: (string | null)[]; blocks: number }> => ui.evaluate(`(()=>({blocks:document.querySelectorAll('.omp-code-block').length,pressed:[...document.querySelectorAll('.omp-code-block')].map(block=>block.querySelector('.omp-code-wrap')?.getAttribute('aria-pressed')??null)}))()`);

		await t.test("a block wider than its box shows the toggle, a block that fits does not, and nothing wraps by default", async () => {
			await open("overflow");
			await ui.evaluate(push([entry("a", null, two(LONG, SHORT))]));
			await ui.wait("document.querySelectorAll('.omp-code-block').length === 2 && document.querySelector('.omp-code-wrap')");
			assert.deepEqual((await buttons()).pressed, ["false", null]);
			const facts = await ui.evaluate<{ tag: string; label: string | null; title: string | null; icon: boolean; white: string; scrolls: boolean; tab: number }>(`(()=>{const button=document.querySelector('.omp-code-wrap');const pre=document.querySelector('.omp-code-block pre');
				return{tag:button.tagName,label:button.getAttribute('aria-label'),title:button.title,icon:Boolean(button.querySelector('.codicon-word-wrap')),white:getComputedStyle(pre).whiteSpace,scrolls:pre.scrollWidth>pre.clientWidth,tab:button.tabIndex}})()`);
			assert.deepEqual(facts, { tag: "BUTTON", label: "Wrap lines", title: "Wrap lines: off. Press to wrap long lines", icon: true, white: "pre", scrolls: true, tab: 0 });
			// Keyboard focus reveals the hover-only toolbar.
			await ui.evaluate("document.querySelector('.omp-code-wrap').focus()");
			assert.equal(await ui.evaluate("getComputedStyle(document.querySelector('.omp-code-actions')).opacity"), "1");
			assert.equal(await ui.evaluate("window.errors.length"), 0);
		});

		await t.test("pressing it wraps that block only, and the button stays to turn it off", async () => {
			await open("toggle");
			await ui.evaluate(push([entry("a", null, two(LONG, LONG))]));
			await ui.wait("document.querySelectorAll('.omp-code-wrap').length === 2");
			await ui.evaluate("document.querySelector('.omp-code-wrap').click()");
			await ui.wait("document.querySelector('.omp-code-block[data-wrapped]')");
			assert.deepEqual((await buttons()).pressed, ["true", "false"]);
			const wrapped = await ui.evaluate<{ white: string; scrolls: boolean; taller: boolean }>(`(()=>{const [first,second]=[...document.querySelectorAll('.omp-code-block pre')];return{white:getComputedStyle(first).whiteSpace,scrolls:first.scrollWidth>first.clientWidth+1,taller:first.getBoundingClientRect().height>second.getBoundingClientRect().height}})()`);
			assert.deepEqual(wrapped, { white: "pre-wrap", scrolls: false, taller: true });
			await ui.settle();
			assert.equal(await ui.evaluate("Boolean(document.querySelector('.omp-code-block[data-wrapped] .omp-code-wrap'))"), true, "no overflow now, the toggle stays");
			await ui.evaluate("document.querySelector('.omp-code-block[data-wrapped] .omp-code-wrap').click()");
			await ui.wait("!document.querySelector('.omp-code-block[data-wrapped]')");
			assert.deepEqual((await buttons()).pressed, ["false", "false"]);
		});

		await t.test("the toggle follows the width of the page and the growth of a streaming block", async () => {
			await open("follow");
			await ui.evaluate(push([entry("a", null, code(MEDIUM))]));
			await ui.wait("document.querySelectorAll('.omp-code-block').length === 1");
			await ui.settle();
			assert.deepEqual((await buttons()).pressed, [null], "it fits at 700 px");
			await resize(320);
			await ui.wait("document.querySelector('.omp-code-wrap')");
			await resize(700);
			await ui.wait("!document.querySelector('.omp-code-wrap')");
			await resize(320);
			await ui.wait("document.querySelector('.omp-code-wrap')");
			await resize(700);
			await ui.wait("!document.querySelector('.omp-code-wrap')");
			// An unfinished block grows line by line.
			await ui.evaluate(push([entry("a", null, `Here:\n\n\`\`\`ts\n${SHORT}`)]));
			await ui.wait("!document.querySelector('.omp-code-wrap')");
			await ui.evaluate(push([entry("a", null, `Here:\n\n\`\`\`ts\n${SHORT}\n${LONG}`)]));
			await ui.wait("document.querySelector('.omp-code-wrap')");
		});

		await t.test("pressing it keeps what the reader looks at in place in a long transcript", async () => {
			await open("anchor");
			const filler = Array.from({ length: 4 }, (_, index) => `Filler ${index}\n\n${"A line of prose.\n\n".repeat(8)}`);
			const entries = [...filler.map((text, index) => entry(`f${index}`, index === 0 ? null : `f${index - 1}`, text)), entry("c", "f3", code(LONG)), ...filler.map((text, index) => entry(`t${index}`, index === 0 ? "c" : `t${index - 1}`, text))];
			await ui.evaluate(push(entries));
			await ui.wait("document.querySelector('.omp-transcript .omp-row')");
			// The transcript mounts only the rows near the reader: scroll down from the top until the block's row is there.
			// A reader who scrolled up has left the bottom: the transcript then keeps what they look at in place, instead of following new height.
			await ui.call("Input.dispatchMouseEvent", { type: "mouseWheel", x: 300, y: 300, deltaX: 0, deltaY: -200 });
			const scrollTo = (value: string): Promise<unknown> => ui.evaluate(`document.querySelector('.omp-transcript').scrollTop=${value}`);
			for (let at = 0; !(await ui.evaluate<boolean>("Boolean(document.querySelector('.omp-code-wrap'))")); at += 150) {
				assert.ok(at < 20_000, "the block's row never mounted: " + JSON.stringify(await ui.evaluate("(()=>{const s=document.querySelector('.omp-transcript');return{rows:document.querySelectorAll('.omp-row').length,blocks:document.querySelectorAll('.omp-code-block').length,h:s.scrollHeight,c:s.clientHeight,t:s.scrollTop,w:!!document.querySelector('.omp-code-wrap')}})()")));
				await scrollTo(String(at));
				await ui.settle();
			}
			await ui.evaluate(`(()=>{const scroller=document.querySelector('.omp-transcript');const block=document.querySelector('.omp-code-block');scroller.scrollTop+=block.getBoundingClientRect().top-scroller.getBoundingClientRect().top-120})()`);
			const top = (): Promise<number> => ui.evaluate("document.querySelector('.omp-code-block pre').getBoundingClientRect().top");
			// The scroll and the transcript's re-measure settle over a few frames: read the block once it has stopped moving.
			for (let last = NaN, now = await top(); now !== last; ) { last = now; await ui.settle(); now = await top(); }
			const before = await top();
			await ui.evaluate("document.querySelector('.omp-code-wrap').click()");
			await ui.wait("document.querySelector('.omp-code-block[data-wrapped]')");
			await ui.settle();
			const after = await top();
			assert.ok(Math.abs(after - before) <= 1, "the block's top did not move: " + before + " -> " + after);
			await ui.evaluate("document.querySelector('.omp-code-wrap').click()");
			await ui.wait("!document.querySelector('.omp-code-block[data-wrapped]')");
			await ui.settle();
			assert.ok(Math.abs(await top() - before) <= 1, "nor when it unwraps");
			// The transcript's own window: wrap it, scroll far away so its row unmounts, and come back.
			await ui.evaluate("document.querySelector('.omp-code-wrap').click()");
			await ui.wait("document.querySelector('.omp-code-block[data-wrapped]')");
			await scrollTo("1e9");
			await ui.wait("!document.querySelector('.omp-code-block')");
			for (let at = 20_000; !(await ui.evaluate<boolean>("Boolean(document.querySelector('.omp-code-block'))")); at -= 150) {
				assert.ok(at > 0, "the block's row never mounted again");
				await scrollTo(String(at));
				await ui.settle();
			}
			assert.equal(await ui.evaluate("document.querySelector('.omp-code-block').hasAttribute('data-wrapped')"), true, "still wrapped after the window remounted the row");
		});

		await t.test("the choice survives the row leaving the transcript and coming back", async () => {
			await open("remount");
			await ui.evaluate(push([entry("a", null, two(LONG, LONG))]));
			await ui.wait("document.querySelectorAll('.omp-code-wrap').length === 2");
			await ui.evaluate("document.querySelectorAll('.omp-code-wrap')[1].click()");
			await ui.wait("document.querySelector('.omp-code-block[data-wrapped]')");
			await ui.evaluate(push([]));
			await ui.wait("document.querySelectorAll('.omp-code-block').length === 0");
			await ui.evaluate(push([entry("a", null, two(LONG, LONG))]));
			await ui.wait("document.querySelectorAll('.omp-code-block').length === 2");
			await ui.settle();
			assert.deepEqual((await buttons()).pressed, ["false", "true"], "the second block is still wrapped, the first is not");
		});

		await t.test("a tall block is capped at the column's maximum width and scrolls, its buttons stay put, and Find reveals a deep match", async () => {
			await open("tall");
			const lines = Array.from({ length: 400 }, (_, index) => index === 350 ? "const needleline = 1;" : `const v${index} = ${index};`).join("\n");
			await ui.evaluate(push([entry("a", null, code(lines))]));
			await ui.wait("document.querySelector('.omp-code-block pre')");
			await ui.settle();
			const facts = await ui.evaluate<{ max: string; height: number; scrolls: boolean; overflowY: string }>(`(()=>{const pre=document.querySelector('.omp-code-block pre');const s=getComputedStyle(pre);
				return{max:getComputedStyle(document.querySelector('.omp-transcript')).getPropertyValue('--omp-content-max').trim(),height:pre.getBoundingClientRect().height,scrolls:pre.scrollHeight>pre.clientHeight,overflowY:s.overflowY}})()`);
			assert.equal(facts.max, "840px");
			assert.equal(facts.overflowY, "auto");
			assert.ok(facts.scrolls && Math.abs(facts.height - 840) <= 1, `capped at 840: ${JSON.stringify(facts)}`);
			const place = (): Promise<{ top: number; offset: number }> => ui.evaluate(`(()=>{const block=document.querySelector('.omp-code-block');const pre=block.querySelector('pre');const button=block.querySelector('.omp-code-actions');
				return{top:pre.scrollTop,offset:button.getBoundingClientRect().top-pre.getBoundingClientRect().top}})()`);
			const before = await place();
			await ui.evaluate("(()=>{const pre=document.querySelector('.omp-code-block pre');pre.scrollTop=600})()");
			await ui.settle();
			const after = await place();
			assert.ok(after.top > 0, "the block scrolled");
			assert.ok(Math.abs(after.offset - before.offset) <= 1, `buttons stay at the block's top: ${before.offset} -> ${after.offset}`);
			// Find: the match at line 350 is far below the block's first screen.
			await ui.evaluate("(()=>{document.querySelector('.omp-code-block pre').scrollTop=0})()");
			await ui.evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'f',code:'KeyF',keyCode:70,ctrlKey:true,bubbles:true,cancelable:true}))");
			await ui.wait("document.querySelector('.omp-find-input')");
			await ui.evaluate("document.querySelector('.omp-find-input').focus()");
			await ui.call("Input.insertText", { text: "needleline" });
			await ui.wait("document.querySelector('.omp-find-status').textContent==='1 of 1'");
			const shown = await ui.evaluate<boolean>(`(async()=>{const end=performance.now()+10000;
				while(performance.now()<end){const h=CSS.highlights.get('omp-find-current'),r=h&&[...h][0];
				 if(r){const pre=document.querySelector('.omp-code-block pre'),box=r.getBoundingClientRect(),p=pre.getBoundingClientRect();
				  if(pre.scrollTop>0&&box.top>=p.top&&box.bottom<=p.bottom)return true}
				 await new Promise(resolve=>requestAnimationFrame(resolve))}return false})()`);
			assert.equal(shown, true, "Find scrolled the capped block to the match");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});
	} finally {
		browser?.socket.close();
		page?.socket.close();
		child.kill();
		await once(child, "exit").catch(() => undefined);
		server.close();
		await rm(profile, { recursive: true, force: true }).catch(() => undefined);
	}
});

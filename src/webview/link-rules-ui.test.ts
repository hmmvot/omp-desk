/**
 * The user's link rules in the real Chat page (an owned headless Chromium): the host's `omp:chat-link-rules` turns matching text of an
 * assistant reply into links, a click asks the host to open the rule and the matched characters (never a URL), a change of the rules
 * reaches the open page at once, and text that is not the assistant's reply stays text.
 *
 * Skipped when no Chromium-based browser is found; set OMP_TEST_CHROMIUM to point at one.
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
		 const {promise,resolve,reject}=Promise.withResolvers(); let timer;
		 const observer=new MutationObserver(check);
		 function cleanup(){observer.disconnect();clearTimeout(timer);}
		 function check(){ if (${expression}) { cleanup(); resolve(); } }
		 observer.observe(document,{subtree:true,childList:true,attributes:true,characterData:true});
		 timer=setTimeout(()=>{cleanup();reject(new Error('render condition timed out: '+${JSON.stringify(expression)}))},15000);
		 check(); await promise;
		})()`);
	}
}

/** The real Chat page as `main.tsx` mounts it, with the link rules attached and an assistant reply and a user message to draw them in. */
const FIXTURE = `
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { guestTransport, readCspNonce } from "./bridge";
import { ChatClient } from "./lib/chat-client";
import { createChatModel, snapshotOf } from "../chat/model";
import { splitChatSnapshot } from "../protocol/chat-messages";
import { injectGuestStyles } from "./styles";
import { attachSessionView } from "./lib/session-view";
import { attachLinkRules } from "./lib/link-rules-store";
import { adoptNonceForCreatedStyles } from "./lib/nonce-styles";
attachSessionView(guestTransport);
attachLinkRules(guestTransport);
const epoch = { nonce: "host-ui-test", counter: 1 };
const client = new ChatClient({ post(message) { return guestTransport.post(message); } }); client.attach(guestTransport);
let current = { ...snapshotOf(createChatModel(), epoch), phase: "live", state: {
 model: { provider: "one", id: "old", name: "Original", contextWindow: 1000000 }, thinkingLevel: "low", isStreaming: false, isCompacting: false, queuedMessageCount: 0,
 contextUsage: { tokens: 40700, contextWindow: 1000000, percent: 4.07 }
} };
function receive(message) { window.dispatchEvent(new MessageEvent("message", { data: message })); }
function push(patch = {}) { current = { ...current, ...patch }; const parts = splitChatSnapshot(current, "ui-snapshot"); receive(parts.snapshot); for (const chunk of parts.chunks) receive(chunk); }
const iso = at => new Date(at).toISOString();
const row = (id, parentId, at, message) => ({ type: "message", id, parentId, timestamp: iso(at), message: { timestamp: at, ...message } });
window.ui = {
 receive,
 view() { receive({ type: "omp:session-view", mode: "chat", title: "Owned UI session", running: true, starting: false, stopping: false, canSwitch: true, reason: null }); },
 conversation(user, reply) {
  const now = Date.now();
  const entries = [row("u", null, now - 2000, { role: "user", content: user }), row("a", "u", now - 1000, { role: "assistant", model: "m", stopReason: "stop", content: [{ type: "text", text: reply }] })];
  push({ entries, durableCount: entries.length, settled: true });
 },
};
const nonce = readCspNonce(); adoptNonceForCreatedStyles(nonce); injectGuestStyles(nonce);
createRoot(document.getElementById("root")).render(<App client={client} />); window.ui.view(); push();
`;

const RULES = [
	{ id: 0, pattern: "\\bPROJ-(\\d+)\\b", url: "https://example.test/browse/$1", ignoreCase: false, name: "Tracker" },
	{ id: 1, pattern: "#(\\d+)\\b", url: "https://example.test/<owner>/<repo>/issues/$1", ignoreCase: false, name: null },
];
const REPLY = "Fixed in PROJ-12 and #34, see `PROJ-56`, **#7**, https://example.test/PROJ-1 and src/PROJ-9/a.ts:\n\n- item PROJ-78\n\n```\nPROJ-90 stays code\n```";

test("link rules draw matching text of the assistant's reply as links, open through the host and follow a changed setting", { skip: browserPath === undefined, timeout: 300_000 }, async () => {
	const bundled = await build({ stdin: { contents: FIXTURE, loader: "tsx", resolveDir: join(process.cwd(), "src/webview") },
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
		const webview = { cspSource: "'self'", asWebviewUri: (uri: { path: string }) => ({ toString: () => uri.path.endsWith(".js") ? "/ui.js" : "/codicons/codicon.css" }) } as unknown as vscode.Webview;
		const extensionUri = { path: "/extension", with({ path }: { path: string }) { return { path }; } } as unknown as vscode.Uri;
		const html = createGuestHtml(webview, extensionUri, "tab:2c26b46b-68ff-4c1d-a3d8-1e0f9a0b7c6d", null);
		const nonce = /<script nonce="([^"]+)"/.exec(html)![1]!;
		response.end(html.replace("</head>", `<style nonce="${nonce}">:root{--vscode-editor-background:#1e1e1e;--vscode-editor-foreground:#ddd;--vscode-foreground:#ddd;--vscode-font-family:Arial;--vscode-font-size:13px;--vscode-textLink-foreground:#3794ff;--vscode-focusBorder:#007fd4}</style><script nonce="${nonce}">window.sent=[];window.errors=[];window.addEventListener("error",event=>window.errors.push(event.message));window.acquireVsCodeApi=()=>({postMessage(message){window.sent.push(message)},setState(){}});</script></head>`));
	});
	server.listen(0, "127.0.0.1"); await once(server, "listening");
	const address = server.address(); assert.ok(address && typeof address !== "string");
	const profile = await mkdtemp(join(tmpdir(), "omp-link-rules-ui-"));
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
		await ui.call("Emulation.setDeviceMetricsOverride", { width: 1000, height: 900, deviceScaleFactor: 1, mobile: false });
		const loaded = ui.event("Page.loadEventFired");
		await ui.call("Page.navigate", { url: `http://127.0.0.1:${address.port}/` });
		await loaded;
		await ui.wait("window.ui && document.querySelector('#root').firstElementChild");

		const links = () => ui.evaluate<Array<{ text: string; target: string; title: string; role: string | null; tab: number; inCode: boolean; strong: boolean }>>(
			"[...document.querySelectorAll('.omp-rule-link')].map(link=>({text:link.textContent,target:link.dataset.ruleTarget,title:link.title,role:link.getAttribute('role'),tab:link.tabIndex,inCode:link.querySelector(':scope > code')!==null,strong:link.parentElement.tagName==='STRONG'}))");
		const opens = () => ui.evaluate<Array<Record<string, unknown>>>("window.sent.filter(message=>message.type==='omp:terminal-link-open').map(({requestId,...rest})=>rest)");
		const reply = () => ui.evaluate<string>("[...document.querySelectorAll('.omp-md')].find(node=>node.textContent.startsWith('Fixed in')).textContent");

		await ui.evaluate(`window.ui.conversation('Also PROJ-99 and #5', ${JSON.stringify(REPLY)})`);
		await ui.wait("[...document.querySelectorAll('.omp-md')].some(node=>node.textContent.startsWith('Fixed in'))");
		assert.deepEqual(await links(), [], "no rule yet: nothing is a rule link");
		const before = await reply();

		await ui.evaluate(`window.ui.receive({type:'omp:chat-link-rules',rules:${JSON.stringify(RULES)}})`);
		await ui.wait("document.querySelectorAll('.omp-rule-link').length>=5");
		const drawn = await links();
		assert.deepEqual(drawn.map(link => link.text), ["PROJ-12", "#34", "PROJ-56", "#7", "PROJ-78"], "prose, a code span that is one match, emphasis and a list item; not a URL's key, a path's, user text or a fenced block");
		assert.equal(await reply(), before, "linking never changes the characters on screen");
		assert.deepEqual(drawn.map(link => link.target), ["link-rule://0/PROJ-12", "link-rule://1/%2334", "link-rule://0/PROJ-56", "link-rule://1/%237", "link-rule://0/PROJ-78"]);
		assert.ok(drawn.every(link => link.role === "link" && link.tab === 0), "every link is a focusable link");
		assert.equal(drawn[0]!.title, "Tracker\nhttps://example.test/browse/12\nOpen in editor · Ctrl+Click to open in browser", "the title shows the URL the host will open");
		assert.equal(drawn[1]!.title, "https://example.test/%3Cowner%3E/%3Crepo%3E/issues/34\nOpen in editor · Ctrl+Click to open in browser");
		assert.equal(drawn[2]!.inCode, true, "a code span keeps its code element inside the link");
		assert.equal(drawn[3]!.strong, true, "a link inside emphasis stays inside it");
		assert.equal(await ui.evaluate("[...document.querySelectorAll('.omp-md')].filter(node=>node.textContent.startsWith('Also PROJ-99')).flatMap(node=>[...node.querySelectorAll('.omp-rule-link')]).length"), 0, "the user's own message is text");
		assert.equal(await ui.evaluate("document.querySelectorAll('pre .omp-rule-link').length"), 0, "a fenced block stays text");
		assert.equal(await ui.evaluate("document.querySelectorAll('a[href]').length"), 0, "no anchor: the page never navigates itself");

		// A plain click, Enter and Space each ask for an editor tab, Ctrl+Click and Ctrl+Enter for the external browser; each names the rule and the characters and nothing else.
		await ui.evaluate("document.querySelector('.omp-rule-link').click()");
		await ui.evaluate("document.querySelectorAll('.omp-rule-link')[1].dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))");
		await ui.evaluate("document.querySelectorAll('.omp-rule-link')[2].dispatchEvent(new KeyboardEvent('keydown',{key:' ',bubbles:true,cancelable:true}))");
		await ui.evaluate("document.querySelectorAll('.omp-rule-link')[3].dispatchEvent(new KeyboardEvent('keydown',{key:'a',bubbles:true,cancelable:true}))");
		await ui.evaluate("document.querySelectorAll('.omp-rule-link')[0].dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,ctrlKey:true}))");
		await ui.evaluate("document.querySelectorAll('.omp-rule-link')[1].dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,bubbles:true,cancelable:true}))");
		assert.deepEqual(await opens(), [
			{ type: "omp:terminal-link-open", target: "link-rule://0/PROJ-12", mode: "editor" },
			{ type: "omp:terminal-link-open", target: "link-rule://1/%2334", mode: "editor" },
			{ type: "omp:terminal-link-open", target: "link-rule://0/PROJ-56", mode: "editor" },
			{ type: "omp:terminal-link-open", target: "link-rule://0/PROJ-12", mode: "external" },
			{ type: "omp:terminal-link-open", target: "link-rule://1/%2334", mode: "external" },
		], "no URL and no action travel with a click, only the gesture's mode");
		await ui.evaluate("document.querySelector('.omp-rule-link').focus()");
		assert.equal(await ui.evaluate("document.activeElement.classList.contains('omp-rule-link')"), true, "a link takes the keyboard focus");

		// A change of the setting reaches the open page at once: a rule that is gone stops linking.
		await ui.evaluate(`window.ui.receive({type:'omp:chat-link-rules',rules:${JSON.stringify([RULES[1]])}})`);
		await ui.wait("[...document.querySelectorAll('.omp-rule-link')].every(link=>link.textContent.startsWith('#'))");
		assert.deepEqual((await links()).map(link => link.text), ["#34", "#7"]);
		assert.equal(await reply(), before);

		// A message the page's parser refuses changes nothing.
		await ui.evaluate("window.ui.receive({type:'omp:chat-link-rules',rules:[{id:0,pattern:'(',url:7}]})");
		await ui.evaluate("window.ui.receive({type:'omp:chat-link-rules',rules:'nope'})");
		assert.deepEqual((await links()).map(link => link.text), ["#34", "#7"]);

		// A rule the page's own check refuses (the host screened it, the page does not take its word) draws nothing.
		await ui.evaluate("window.ui.receive({type:'omp:chat-link-rules',rules:[{id:0,pattern:'(a+)+',url:'https://example.test/$0',ignoreCase:false,name:null},{id:1,pattern:'#(\\\\d+)',url:'https://$1.example.test/',ignoreCase:false,name:null}]})");
		await ui.wait("document.querySelectorAll('.omp-rule-link').length===0");

		await ui.evaluate("window.ui.receive({type:'omp:chat-link-rules',rules:[]})");
		assert.deepEqual(await links(), []);
		assert.equal(await reply(), before);
		assert.deepEqual(await ui.evaluate("window.errors"), []);
	} finally {
		page?.socket.close(); browser?.socket.close();
		child.kill();
		await once(child, "exit").catch(() => undefined);
		server.close();
		await rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
});

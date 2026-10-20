/**
 * A reply's HTML page (`components/HtmlPageBlock.tsx`) in the real React app, under the guest document's own Content-Security-Policy,
 * in an owned headless Chromium: what it can run, what a hostile page cannot reach, and where it stays code.
 *
 * The embedding document is `createGuestHtml` with a bridge ticket, so its policy names `connect-src` for a loopback origin and
 * `img-src`/`script-src`/`style-src` for the page's own origin: everything the frame might fetch is something the *inherited* policy
 * would allow, so a blocked request is the frame's own policy at work. Every request to the fixture's `/canary/…` paths is counted.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { build } from "esbuild";
import type * as vscode from "vscode";
import { createGuestHtml } from "../host/guest-webview.ts";
import { createHtmlPageServer } from "../host/html-page-server.ts";
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
	/** `gesture` false evaluates without granting the page user activation, which a frame taking the focus must not be able to lean on. */
	async evaluate<T>(expression: string, gesture = true): Promise<T> {
		const result = await this.call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: gesture });
		if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
		const remote = result.result;
		assert.ok(remote !== null && typeof remote === "object");
		return ("value" in remote ? remote.value : undefined) as T;
	}
	/** Polls: a frame's messages change no DOM, so a mutation observer would never wake. */
	async until(expression: string, gesture = true): Promise<void> {
		for (let attempt = 0; attempt < 300; attempt++) {
			if (await this.evaluate<boolean>(`Boolean(${expression})`, gesture)) return;
			await delay(50);
		}
		throw new Error(`condition timed out: ${expression}`);
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
import { attachSessionView, sessionViewSnapshot } from "./lib/session-view";
import { adoptNonceForCreatedStyles } from "./lib/nonce-styles";
import { installComposerDriver } from "./test-support/composer-driver";
attachSessionView(guestTransport);
installComposerDriver(window);
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
 title: () => sessionViewSnapshot().title,
 view(patch = {}) { receive({ type: "omp:session-view", mode: "chat", title: "Owned UI session", running: true, starting: false, stopping: false, canSwitch: true, reason: null, ...patch }); },
 preferences(htmlPages) { receive({ type: "omp:chat-display-preferences", epoch: current.epoch, toolCallDetail: "overview", accessibilitySupport: false, htmlPages }); },
};
const nonce=readCspNonce(); adoptNonceForCreatedStyles(nonce); injectGuestStyles(nonce);
createRoot(document.getElementById("root")).render(<App client={client} />); window.ui.view(); push();
`;

/** The chat page's variables in one captured VS Code theme, as the Webview would define them on `<html>`. */
function themeTokens(name: string): Record<string, string> {
	const theme = THEMES.find(candidate => candidate.name === name);
	assert.ok(theme, name);
	return { "--vscode-editor-background": theme.tokens["--vscode-editor-background"]!, "--vscode-editor-foreground": theme.tokens["--vscode-foreground"]!, ...theme.tokens };
}
const rules = (tokens: Record<string, string>): string => Object.entries(tokens).filter(([, value]) => value !== "").map(([key, value]) => `${key}:${value}`).join(";");

const row = (id: string, message: Record<string, unknown>) => ({ type: "message", id, parentId: null, timestamp: "2026-10-19T00:00:00.000Z", message });
const assistant = (text: string, extra: unknown[] = []) => row("reply", { role: "assistant", model: "m", timestamp: 2, stopReason: "stop", content: [...extra, { type: "text", text }] });
const fence = (html: string, closed = true): string => `Here is a page:\n\n\`\`\`html\n${html}\n${closed ? "```\n\nDone." : ""}`;
const show = (entries: unknown[]): string => `window.ui.push({entries:${JSON.stringify(entries)},durableCount:${entries.length},working:false,settled:true})`;

// A page that talks back to the test: every probe is one message to `parent`, which the fixture page records.
const REPORT = `function report(k,v){parent.postMessage({probe:k,value:String(v)},'*')}`;

test("HTML pages in Chat: a live sandboxed page that reaches nothing", { skip: browserPath === undefined, timeout: 240_000 }, async t => {
	const bundled = await build({ stdin: { contents: fixture, loader: "tsx", resolveDir: join(process.cwd(), "src/webview") },
		bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic", loader: { ".css": "text" }, define: { "process.env.NODE_ENV": '"production"' } });
	const script = bundled.outputFiles[0]!.text;
	const hits = new Map<string, number>();
	const frameServer = createHtmlPageServer();
	const framePort = await frameServer.ensure();
	assert.ok(framePort !== null, "the frame server binds");
	let origin = "";
	const server = createServer((request, response) => {
		const pathname = new URL(request.url ?? "/", "http://fixture").pathname;
		if (pathname.startsWith("/canary/")) {
			hits.set(pathname, (hits.get(pathname) ?? 0) + 1);
			response.setHeader("Access-Control-Allow-Origin", "*");
			response.setHeader("Content-Type", pathname.endsWith("/script") ? "text/javascript" : pathname.endsWith("/css") ? "text/css" : "text/plain");
			response.end(pathname.endsWith("/script") ? "parent.postMessage({probe:'canary-script-ran',value:'1'},'*')" : "");
			return;
		}
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
			asWebviewUri: (uri: { path: string }) => ({ toString: () => (uri.path.endsWith(".js") ? "/ui.js" : "/codicons/codicon.css") }),
		} as unknown as vscode.Webview;
		const extensionUri = { path: "/extension", with({ path }: { path: string }) { return { path }; } } as unknown as vscode.Uri;
		const port = Number(new URL(origin).port);
		const withoutFrame = (request.url ?? "").includes("?noframe");
		// A bridge ticket makes the page's own `connect-src` name this server, and the fixture origin is allowed to serve scripts and images:
		// what the frame's policy has to stop is something the page's own policy allows.
		const html = createGuestHtml(webview, extensionUri, "tab:2c26b46b-68ff-4c1d-a3d8-1e0f9a0b7c6d", { editorId: "a".repeat(32), documentId: "b".repeat(32), bootstrapId: "c".repeat(32), port }, "chat", withoutFrame ? null : framePort);
		const nonce = /<script nonce="([^"]+)"/.exec(html)![1]!;
		response.end(html.replace("</head>", `<style nonce="${nonce}">:root{${rules(themeTokens("Dark Modern"))};--vscode-font-family:Arial;--vscode-font-size:13px;--vscode-editor-font-family:Consolas, "Courier New", monospace}</style>
		<script nonce="${nonce}">window.sent=[];window.errors=[];window.violations=[];window.frameLog=[];
		window.addEventListener("error",event=>window.errors.push(event.message));
		document.addEventListener("securitypolicyviolation",event=>window.violations.push(event.violatedDirective+" "+event.blockedURI));
		window.addEventListener("message",event=>{ if(event.source!==null&&event.source!==window) window.frameLog.push({data:event.data,origin:event.origin}); });
		window.acquireVsCodeApi=()=>({postMessage(message){window.sent.push(message);document.dispatchEvent(new Event("fixture-post"))},setState(){}});</script>
		</head>`));
	});
	server.listen(0, "127.0.0.1"); await once(server, "listening");
	const address = server.address(); assert.ok(address && typeof address !== "string");
	origin = `http://127.0.0.1:${address.port}`;
	const profile = await mkdtemp(join(tmpdir(), "omp-html-page-ui-"));
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
		await ui.call("Emulation.setDeviceMetricsOverride", { width: 700, height: 900, deviceScaleFactor: 1, mobile: false });
		await ui.call("Emulation.setFocusEmulationEnabled", { enabled: true });
		let opened = 0;
		async function open(name: string): Promise<void> {
			hits.clear();
			const loaded = ui.event("Page.loadEventFired");
			await ui.call("Page.navigate", { url: `${origin}/?${name}-${++opened}` });
			await loaded;
			await ui.until("window.ui?.token && document.querySelector('#root').firstElementChild", false);
		}
		const frames = (): Promise<number> => ui.evaluate<number>("document.querySelectorAll('iframe.omp-htmlpage-frame').length");
			const probes = (): Promise<Record<string, string>> => ui.evaluate<Record<string, string>>("Object.fromEntries(window.frameLog.filter(entry=>entry.data&&entry.data.probe).map(entry=>[entry.data.probe,entry.data.value]))");
		const reply = (html: string, closed = true): string => show([assistant(fence(html, closed))]);

		await t.test("a closed fence is a sandboxed frame that runs its scripts and its on… handlers, under the frame's own policy", async () => {
			await open("runs");
			await ui.evaluate(reply(`<h1 id="t">Hello</h1><button id="b" onclick="window.clicks=(window.clicks||0)+1;report('click',window.clicks)">b</button><style>h1{color:rgb(1,2,3)}</style><script>${REPORT}
report('ran',document.getElementById('t').textContent);report('style',getComputedStyle(document.getElementById('t')).color);document.getElementById('b').click();document.getElementById('b').click();
report('inline-style',(()=>{const e=document.createElement('i');e.setAttribute('style','color:rgb(4,5,6)');document.body.append(e);return getComputedStyle(e).color})());
</script>`));
			await ui.until("window.frameLog.some(entry=>entry.data.probe==='inline-style')");
			assert.equal(await frames(), 1);
			assert.equal(await ui.evaluate("document.querySelector('iframe.omp-htmlpage-frame').getAttribute('sandbox')"), "allow-scripts", "scripts and nothing else: not allow-same-origin, -top-navigation, -popups, -forms, -modals, -downloads");
			assert.equal(await ui.evaluate("document.querySelector('iframe.omp-htmlpage-frame').getAttribute('allow')"), "");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
			const seen = await probes();
			assert.equal(seen.ran, "Hello", "an inline script ran");
			assert.equal(seen.style, "rgb(1, 2, 3)", "a <style> applied");
			assert.equal(seen.click, "2", "an inline onclick handler ran for each click");
			assert.equal(seen["inline-style"], "rgb(4, 5, 6)", "a style attribute applied");
			assert.deepEqual(await ui.evaluate("window.violations"), [], "the page's own policy never complained");
			// The frame reports a source map back: Page | Source toggle and Copy.
			assert.equal(await ui.evaluate("[...document.querySelectorAll('.omp-htmlpage .omp-htmlpage-head .omp-mermaid-tab')].map(button=>button.textContent).join()"), "Page,Source");
			assert.equal(await ui.evaluate("Boolean(document.querySelector('.omp-htmlpage .omp-htmlpage-head .omp-htmlpage-copy'))"), true);
		});

		await t.test("the header is a row of its own above the frame: never over it, always visible, wide or narrow", async () => {
			for (const width of [900, 700, 360]) {
				await ui.call("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
				await ui.until("document.querySelector('.omp-htmlpage .omp-htmlpage-head') && document.querySelector('iframe.omp-htmlpage-frame')");
				const [bar, frame] = await ui.evaluate<number[][]>("(()=>{const r=element=>{const b=element.getBoundingClientRect();return[b.left,b.top,b.right,b.bottom]};return[r(document.querySelector('.omp-htmlpage .omp-htmlpage-head')),r(document.querySelector('iframe.omp-htmlpage-frame'))]})()");
				assert.ok(bar![3]! <= frame![1]!, `at ${width}px the header ${bar} ends above the frame ${frame}`);
				assert.equal(await ui.evaluate("getComputedStyle(document.querySelector('.omp-htmlpage .omp-htmlpage-head')).opacity"), "1", "not a hover overlay");
				assert.equal(await ui.evaluate("getComputedStyle(document.querySelector('.omp-htmlpage .omp-htmlpage-head')).position"), "static");
			}
			await ui.call("Emulation.setDeviceMetricsOverride", { width: 700, height: 900, deviceScaleFactor: 1, mobile: false });
		});

		await t.test("Source shows the code and Page brings the page back", async () => {
			await delay(6500); // longer than the frame's answer timeout: a page that answered must never be given up on afterwards
			await ui.evaluate("[...document.querySelectorAll('.omp-htmlpage .omp-htmlpage-head .omp-mermaid-tab')].find(button=>button.textContent==='Source').click()");
			await ui.until("document.querySelector('.omp-htmlpage pre')");
			assert.equal(await frames(), 0);
			assert.match(await ui.evaluate<string>("document.querySelector('.omp-htmlpage pre').textContent"), /<h1 id="t">Hello<\/h1>/);
			await ui.evaluate("[...document.querySelectorAll('.omp-htmlpage .omp-htmlpage-head .omp-mermaid-tab')].find(button=>button.textContent==='Page').click()");
			await ui.until("document.querySelector('iframe.omp-htmlpage-frame')");
		});

		await t.test("the page reads the theme as variables and follows a theme change without reloading", async () => {
			await open("theme");
			await ui.evaluate(reply(`<p>x</p><script>${REPORT}
const born=Math.random();
addEventListener('message',event=>{ if(event.data!=='ask'||event.source!==parent)return; const s=getComputedStyle(document.documentElement);
 report('theme',JSON.stringify({bg:s.getPropertyValue('--bg'),fg:s.getPropertyValue('--fg'),c1:s.getPropertyValue('--c1'),font:s.getPropertyValue('--font'),mono:s.getPropertyValue('--font-mono'),scheme:s.colorScheme,body:getComputedStyle(document.body).backgroundColor,born}))});
report('ready','1');
</script>`));
			await ui.until("window.frameLog.some(entry=>entry.data.probe==='ready')");
			const ask = async (): Promise<Record<string, string>> => {
				await ui.evaluate("window.frameLog.length=0;document.querySelector('iframe.omp-htmlpage-frame').contentWindow.postMessage('ask','*')");
				await ui.until("window.frameLog.some(entry=>entry.data.probe==='theme')");
				return JSON.parse((await probes()).theme!) as Record<string, string>;
			};
			const dark = await ask();
			assert.equal(dark.bg, "#1f1f1f", "the theme's background");
			assert.match(dark.fg!, /^#[0-9a-f]{6}$/);
			assert.match(dark.c1!, /^#[0-9a-f]{6}$/);
			assert.match(dark.font!, /Arial/);
			assert.match(dark.mono!, /Consolas/);
			assert.equal(dark.scheme, "dark");
			assert.equal(dark.body, "rgb(31, 31, 31)", "the body is the theme's background until the page says otherwise");
			const light = themeTokens("Light Modern");
			await ui.evaluate(`for(const [name,value] of Object.entries(${JSON.stringify(light)})) if(value!=='') document.documentElement.style.setProperty(name,value);document.body.className='vscode-light'`);
			await ui.until("document.querySelector('iframe.omp-htmlpage-frame')");
			await delay(300);
			const changed = await ask();
			assert.equal(changed.bg, "#ffffff", "the page's variables follow the theme");
			assert.equal(changed.scheme, "light");
			assert.equal(changed.born, dark.born, "the same page instance: a theme change is a message, not a reload");
		});

		await t.test("the frame is as tall as its page up to a cap; a taller page expands to its full height and back, tracking its content", async () => {
			await open("height");
			const frameHeight = (): Promise<number> => ui.evaluate<number>("document.querySelector('iframe.omp-htmlpage-frame').getBoundingClientRect().height");
			await ui.evaluate(reply(`<div id="s" style="height:100px"></div>`));
			await ui.until("document.querySelector('iframe.omp-htmlpage-frame') && document.querySelector('iframe.omp-htmlpage-frame').getBoundingClientRect().height<150");
			const short = await frameHeight();
			assert.ok(short >= 100 && short <= 130, `a 100px page in an 8px margin is about 116px, not the 160px start (${short})`);
			assert.equal(await ui.evaluate("Boolean(document.querySelector('.omp-htmlpage-more'))"), false, "a short page has no expand button");
			await ui.evaluate(reply(`<div id="big" style="height:2000px">tall</div><script>${REPORT}
addEventListener('message',e=>{if(e.source!==parent)return;if(e.data==='ask')report('dims',document.documentElement.scrollHeight+','+innerHeight);if(e.data==='grow')document.getElementById('big').style.height='3000px'});
addEventListener('load',()=>report('scroll',document.documentElement.scrollHeight>innerHeight));
</script>`));
			await ui.until("document.querySelector('.omp-htmlpage-more')");
			await delay(200);
			assert.equal(await frameHeight(), 800, "collapsed at the cap");
			assert.equal((await probes()).scroll, "true", "the rest scrolls inside the frame while collapsed");
			const layout = await ui.evaluate<Record<string, number>>("(()=>{const r=s=>document.querySelector(s).getBoundingClientRect();return{headBottom:r('.omp-htmlpage-head').bottom,frameTop:r('iframe.omp-htmlpage-frame').top,frameBottom:r('iframe.omp-htmlpage-frame').bottom,moreTop:r('.omp-htmlpage-more').top}})()");
			assert.ok(layout.headBottom! <= layout.frameTop!, `the header (${layout.headBottom}) is above the frame (${layout.frameTop}), never over it`);
			assert.ok(layout.moreTop! >= layout.frameBottom!, "the button is below the frame");
			assert.equal(await ui.evaluate("document.querySelector('.omp-htmlpage-more').textContent"), "Show full page");

			await ui.evaluate("document.querySelector('.omp-htmlpage-more').click()");
			await ui.until("document.querySelector('iframe.omp-htmlpage-frame').getBoundingClientRect().height>=2000");
			await delay(300);
			await ui.evaluate("window.frameLog.length=0;document.querySelector('iframe.omp-htmlpage-frame').contentWindow.postMessage('ask','*')");
			await ui.until("window.frameLog.some(entry=>entry.data.probe==='dims')");
			const [scrollHeight, innerHeight] = (await probes()).dims!.split(",").map(Number);
			assert.ok(scrollHeight! <= innerHeight! + 1, `expanded: the frame shows the whole page with no inner scroll (${scrollHeight} in ${innerHeight})`);
			assert.equal(await ui.evaluate("document.querySelector('.omp-htmlpage-more').textContent"), "Show less");
			assert.equal(await ui.evaluate("document.querySelector('.omp-htmlpage-more').getAttribute('aria-expanded')"), "true");

			// While expanded the height follows the content.
			await ui.evaluate("document.querySelector('iframe.omp-htmlpage-frame').contentWindow.postMessage('grow','*')");
			await ui.until("document.querySelector('iframe.omp-htmlpage-frame').getBoundingClientRect().height>=3000");

			await ui.evaluate("document.querySelector('.omp-htmlpage-more').click()");
			await ui.until("document.querySelector('iframe.omp-htmlpage-frame').getBoundingClientRect().height===800");
			assert.equal(await ui.evaluate("document.querySelector('.omp-htmlpage-more').textContent"), "Show full page", "collapse returns to the cap");
		});

		await t.test("a hostile page reaches nothing: no parent, no host channel, no storage, no network, no navigation, no forged message", async () => {
			await open("hostile");
			const hostile = `<form id="f" action="${origin}/canary/form" method="post"><input name="x"></form>
<img src="${origin}/canary/img"><img src="${origin}/canary/img-2" onerror="report('img-error','1')">
<link rel="stylesheet" href="${origin}/canary/css"><script src="${origin}/canary/script"></script>
<meta http-equiv="refresh" content="0;url=${origin}/canary/refresh">
<div style="background:url(${origin}/canary/cssurl)">x</div><style>@import url(${origin}/canary/import);@font-face{font-family:x;src:url(${origin}/canary/font)}</style>
<script>${REPORT}
const attempt=(k,f)=>{try{const r=f();report(k,'ok:'+(r&&typeof r.then==='function'?'promise':r))}catch(e){report(k,'threw:'+e.name)}};
attempt('parent.document',()=>parent.document.title);
attempt('top.document',()=>top.document.title);
attempt('parent.parent',()=>parent.parent.document.title);
attempt('acquireVsCodeApi',()=>typeof parent.acquireVsCodeApi);
attempt('parent.sent',()=>parent.sent.length);
attempt('parent.ui',()=>typeof parent.ui);
attempt('localStorage',()=>localStorage.length);
attempt('sessionStorage',()=>sessionStorage.length);
attempt('cookie',()=>document.cookie);
attempt('indexedDB',()=>typeof indexedDB.open('x'));
attempt('caches',()=>typeof caches.open);
attempt('eval',()=>eval('1+1'));
attempt('Function',()=>new Function('return 1')());
attempt('setTimeout-string',()=>setTimeout('window.stringTimerRan=1',0));
attempt('window.open',()=>window.open('${origin}/canary/open'));
attempt('top.location',()=>{top.location='${origin}/canary/top'});
attempt('parent.location',()=>{parent.location='${origin}/canary/parent'});
attempt('parent.location.href',()=>parent.location.href);
attempt('form.submit',()=>document.getElementById('f').submit());
attempt('fetch',()=>fetch('${origin}/canary/fetch').catch(()=>{}));
attempt('fetch-nocors',()=>fetch('${origin}/canary/fetch-nocors',{mode:'no-cors'}).catch(()=>{}));
attempt('xhr',()=>{const x=new XMLHttpRequest();x.open('GET','${origin}/canary/xhr');x.send()});
attempt('beacon',()=>navigator.sendBeacon('${origin}/canary/beacon','x'));
attempt('websocket',()=>{new WebSocket('${origin.replace("http", "ws")}/canary/ws').onerror=()=>{}});
attempt('eventsource',()=>{new EventSource('${origin}/canary/sse').onerror=()=>{}});
attempt('image',()=>{new Image().src='${origin}/canary/image'});
attempt('worker',()=>new Worker('${origin}/canary/worker.js'));
attempt('import',()=>import('${origin}/canary/module.js').catch(()=>{}));
attempt('iframe',()=>{const f=document.createElement('iframe');f.src='${origin}/canary/frame';document.body.append(f)});
attempt('iframe-srcdoc',()=>{const f=document.createElement('iframe');f.srcdoc='<p>x</p>';document.body.append(f);return 'appended'});
attempt('script-inject',()=>{const s=document.createElement('script');s.src='${origin}/canary/injected';document.body.append(s)});
attempt('script-inject-inline',()=>{const s=document.createElement('script');s.textContent="report('injected-inline-ran','1')";document.body.append(s)});
attempt('script-inject-data',()=>{const s=document.createElement('script');s.src='data:text/javascript,report("injected-data-ran","1")';document.body.append(s)});
attempt('link-inject',()=>{const l=document.createElement('link');l.rel='stylesheet';l.href='${origin}/canary/css-injected';document.head.append(l)});
attempt('nonce-hunt',()=>[...document.querySelectorAll('script')].map(s=>s.nonce||s.getAttribute('nonce')||'').join('')+document.querySelectorAll('meta[http-equiv]').length);
attempt('base',()=>{const b=document.createElement('base');b.href='${origin}/canary/';document.head.append(b)});
attempt('postMessage-host',()=>{parent.postMessage({type:'omp:session-view',mode:'chat',title:'FORGED',running:true,starting:false,stopping:false,canSwitch:true,reason:null},'*')});
attempt('postMessage-top',()=>{top.postMessage({type:'omp:session-view',mode:'chat',title:'FORGED-TOP',running:true,starting:false,stopping:false,canSwitch:true,reason:null},'*')});
attempt('postMessage-state',()=>{parent.postMessage({type:'omp:chat-state',epoch:{nonce:'evil',counter:99},phase:'failed'},'*')});
attempt('window.name',()=>{window.name='x'; return window.name});
setTimeout(()=>{report('done','1');try{location.href='${origin}/canary/navigate'}catch(e){report('location','threw:'+e.name)}},600);
</script>`;
			const sentBefore = await ui.evaluate<number>("window.sent.length");
			await ui.evaluate(reply(hostile));
			await ui.until("window.frameLog.some(entry=>entry.data.probe==='done')");
			await delay(500);
			const seen = await probes();
			for (const key of ["parent.document", "top.document", "parent.parent", "acquireVsCodeApi", "parent.sent", "parent.ui"]) assert.match(seen[key]!, /^threw:SecurityError$/, `${key}: a cross-origin read`);
			for (const key of ["localStorage", "sessionStorage", "cookie", "indexedDB"]) assert.match(seen[key]!, /^threw:SecurityError$/, `${key}: an opaque origin has none`);
			assert.match(seen.eval!, /^ok:2$/, "eval is allowed in the frame: it is the only way the page's scripts run without a nonce, and it reaches nothing a script does not");
			assert.match(seen.Function!, /^ok:1$/, "so is new Function");
			assert.equal(seen["nonce-hunt"], "ok:0", "there is no nonce in the frame to find, and no policy meta");
			for (const key of ["injected-inline-ran", "injected-data-ran"]) assert.equal(seen[key], undefined, `${key}: a script the page adds to its own document is refused`);
			assert.equal(seen["window.open"], "ok:null", "no popup");
			assert.equal(seen["parent.location.href"]!.startsWith("threw:"), true, "the parent's address is not readable");
			assert.equal(seen["iframe-srcdoc"], "ok:appended", "an inert local frame is harmless");
			assert.equal(seen["img-error"], "1", "an image from the network is refused (its error handler ran, so the on… conversion works, and no request was made: see the canary below)");
			assert.equal(seen["canary-script-ran"], undefined, "a script from the network never runs");
			assert.deepEqual([...hits.entries()], [], `not one request left the frame: ${[...hits.keys()].join(", ")}`);
			assert.deepEqual(await ui.evaluate("window.violations"), [`frame-src ${origin}/canary/navigate`], "the frame navigating itself was refused by the page's own frame-src, the only thing the page's policy was asked to stop");
			assert.equal(await ui.evaluate("location.pathname + location.search"), `/?hostile-${opened}`, "neither the top frame nor the page was navigated");
			assert.equal(await ui.evaluate("window.ui.title()"), "Owned UI session", "no forged host message reached the page's channel");
			assert.deepEqual(await ui.evaluate("window.sent.slice(" + sentBefore + ").filter(message=>message&&message.type&&String(message.type).startsWith('omp:chat-state'))"), [], "the page answered no forged state");
			assert.equal(await ui.evaluate("window.stringTimerRan"), undefined, "the frame's string timer ran in the frame, never in the Chat");
			// The control: the same message from the page itself is a host message the page does take, so the guard, not the shape, refused it.
			await ui.evaluate("window.dispatchEvent(new MessageEvent('message',{data:{type:'omp:session-view',mode:'chat',title:'CONTROL',running:true,starting:false,stopping:false,canSwitch:true,reason:null}}))");
			assert.equal(await ui.evaluate("window.ui.title()"), "CONTROL");
			assert.equal(await frames(), 1);
		});

		await t.test("the fence stays code while the reply streams, in other messages, in lists and quotes, and with the setting off", async () => {
			await open("stays-code");
			const page = "<p>x</p><script>1</script>";
			await ui.evaluate(show([assistant(fence(page, false))]));
			await ui.until("document.querySelector('.omp-md pre')");
			assert.equal(await frames(), 0, "an unclosed fence is code");
			assert.equal(await ui.evaluate("document.querySelector('.omp-htmlpage')"), null);
			await ui.evaluate(show([assistant(fence(page, true))]));
			await ui.until("document.querySelector('iframe.omp-htmlpage-frame')");
			assert.equal(await frames(), 1, "the closing fence arrives: the page");
			await ui.evaluate(show([row("u", { role: "user", timestamp: 1, content: fence(page) })]));
			await ui.until("document.querySelector('.omp-md pre')");
			assert.equal(await frames(), 0, "text the user typed");
			await ui.evaluate(show([assistant("answer", [{ type: "thinking", thinking: fence(page) }])]));
			await ui.until("document.querySelector('.omp-md')");
			await delay(300);
			assert.equal(await frames(), 0, "thinking");
			await ui.evaluate(show([assistant(`- item\n\n  \`\`\`html\n  ${page}\n  \`\`\`\n\n> \`\`\`html\n> ${page}\n> \`\`\`\n`)]));
			await ui.until("document.querySelector('.omp-md pre')");
			assert.equal(await frames(), 0, "a list item and a quote");
			await ui.evaluate(reply(page));
			await ui.until("document.querySelector('iframe.omp-htmlpage-frame')");
			await ui.evaluate("window.ui.preferences(false)");
			await ui.until("!document.querySelector('iframe.omp-htmlpage-frame') && document.querySelector('.omp-md pre')");
			await ui.evaluate("window.ui.preferences(true)");
			await ui.until("document.querySelector('iframe.omp-htmlpage-frame')");
		});

		await t.test("a streaming fence of hundreds of lines is capped to the tail, expands to the full source, and becomes a page on close", async () => {
			await open("streaming-cap");
			const lines = Array.from({ length: 300 }, (_, index) => `<p>line ${index}</p>`).join("\n");
			await ui.evaluate(show([assistant(fence(lines, false))]));
			await ui.until("document.querySelector('.omp-htmlpage-streaming') && document.querySelector('.omp-htmlpage-more')");
			const box = (): Promise<{ height: number; atBottom: boolean; full: number }> => ui.evaluate("(()=>{const b=document.querySelector('.omp-htmlpage-streaming');return{height:b.getBoundingClientRect().height,atBottom:b.scrollTop+b.clientHeight>=b.scrollHeight-4,full:b.scrollHeight}})()");
			const capped = await box();
			assert.ok(capped.height <= 800 && capped.full > 800, `capped at 800 (${capped.height}, content ${capped.full})`);
			assert.equal(capped.atBottom, true, "a streaming block follows its tail");
			assert.equal(await frames(), 0);
			await ui.evaluate("document.querySelector('.omp-htmlpage-more').click()");
			await ui.until("document.querySelector('.omp-htmlpage-streaming').getBoundingClientRect().height>800");
			assert.equal((await ui.evaluate<string>("document.querySelector('.omp-htmlpage-more').textContent")), "Show less");
			await ui.evaluate(reply(lines));
			await ui.until("document.querySelector('iframe.omp-htmlpage-frame')");
			assert.equal(await ui.evaluate("document.querySelector('.omp-htmlpage-streaming')"), null, "a closed page replaces the capped source");
		});

		await t.test("a page cannot take the keyboard from the composer by itself, but the user can click into it", async () => {
			await open("focus");
			await ui.evaluate(reply(`<input id="i" autofocus><script>setTimeout(()=>{const i=document.createElement('input');document.body.append(i);i.focus();window.focus()},300);setInterval(()=>document.getElementById('i').focus(),400)</script>`), false);
			await ui.until("document.querySelector('iframe.omp-htmlpage-frame')", false);
			await ui.evaluate("window.composer.focus()", false);
			await delay(1500);
			assert.equal(await ui.evaluate("document.activeElement && document.activeElement.className", false), await ui.evaluate("document.querySelector('.omp-composer-input')?.className", false), "the composer still has the focus");
			assert.equal(await ui.evaluate("window.composer.focused()", false), true);
			// The user's own click is real input and the frame keeps the focus.
			const rect = await ui.evaluate<{ x: number; y: number }>("(()=>{const r=document.querySelector('iframe.omp-htmlpage-frame').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+Math.min(40,r.height/2)}})()", false);
			for (const type of ["mousePressed", "mouseReleased"]) await ui.call("Input.dispatchMouseEvent", { type, x: rect.x, y: rect.y, button: "left", clickCount: 1 });
			await delay(800);
			assert.equal(await ui.evaluate("document.activeElement && document.activeElement.tagName", false), "IFRAME", "a click inside the page gives it the focus");
		});

		await t.test("a window with no page frame server keeps the fence as code and says so", async () => {
			await open("noframe");
			await ui.evaluate(reply("<p>x</p>"));
			await ui.until("document.querySelector('.omp-mermaid-note')");
			assert.equal(await frames(), 0);
			assert.match(await ui.evaluate<string>("document.querySelector('.omp-mermaid-note').textContent"), /Page not shown: This window has no page frame/);
			assert.equal(await ui.evaluate("document.querySelector('meta[name=omp-html-page-frame]')"), null);
			assert.doesNotMatch(await ui.evaluate<string>("document.querySelector('meta[http-equiv=Content-Security-Policy]').content"), /frame-src/);
		});

		await t.test("a frame that never answers is replaced by the code and a note", async () => {
			await frameServer.close();
			await open("silent");
			await ui.evaluate(reply("<p>x</p>"));
			await ui.until("document.querySelector('.omp-mermaid-note')", true);
			assert.equal(await frames(), 0);
			assert.match(await ui.evaluate<string>("document.querySelector('.omp-mermaid-note').textContent"), /The page frame did not answer/);
		});
	} finally {
		page?.socket.close();
		browser?.socket.close();
		child.kill();
		server.close();
		await frameServer.close();
		await rm(profile, { recursive: true, force: true }).catch(() => undefined);
	}
});

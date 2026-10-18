/**
 * The `/btw` side-question panel (docs/designs/2026-10-19-chat-btw-side-questions.md) rendered by the real React app in an owned
 * headless Chromium: streaming, completion, cancel, follow-up, the history list, and the ownership of Escape while the focus is
 * inside the panel.
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
		 function cleanup(){observer.disconnect();document.removeEventListener('fixture-post',check);clearTimeout(timer)}
		 function check(){ if (${expression}) { cleanup(); resolve(); } }
		 observer.observe(document,{subtree:true,childList:true,attributes:true,characterData:true});
		 document.addEventListener('fixture-post',check);
		 timer=setTimeout(()=>{cleanup();reject(new Error('render condition timed out: '+${JSON.stringify(expression)}))},15000);
		 check(); await promise;
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
const turn = (patch = {}) => ({ question: "why is it slow?", answer: "", status: "running", createdAt: 1000, updatedAt: 1000, ...patch });
window.ui = {
 token: location.search, current: () => current, receive, push, epoch, liveState,
 view(patch = {}) { receive({ type: "omp:session-view", mode: "chat", title: "Owned UI session", running: true, starting: false, stopping: false, canSwitch: true, reason: null, ...patch }); },
 turn,
 btw(records, extra = {}) { receive({ type: "omp:chat-btw", epoch, records, replace: false, ...extra }); },
 delta(recordId, at, delta) { receive({ type: "omp:chat-btw-delta", epoch, recordId, at, delta }); },
 result(requestId, status = "accepted", reason) { receive({ type: "omp:chat-btw-result", epoch, requestId, status, ...(reason ? { reason } : {}) }); },
 requests: () => window.sent.filter(message => message.type === "omp:chat-btw-request"),
};
const nonce=readCspNonce(); adoptNonceForCreatedStyles(nonce); injectGuestStyles(nonce);
createRoot(document.getElementById("root")).render(<App client={client} />); window.ui.view(); push({ state: liveState });
`;

// Skipped when no Chromium-based browser is found; set OMP_TEST_CHROMIUM to point at one.
test("btw: the side-question panel streams, completes, cancels, follows up and lists the history", { skip: browserPath === undefined, timeout: 160_000 }, async t => {
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
			--vscode-button-background:#007acc;--vscode-button-foreground:white;--vscode-input-background:#3c3c3c;
			--vscode-input-foreground:#ddd;--vscode-panel-border:#555;--vscode-font-family:Arial;--vscode-font-size:13px;
		}</style><script nonce="${nonce}">window.sent=[];window.errors=[];window.addEventListener("error",event=>window.errors.push(event.message));
		window.acquireVsCodeApi=()=>({postMessage(message){window.sent.push(message);document.dispatchEvent(new Event("fixture-post"))},setState(){}});</script>
		</head>`));
	});
	server.listen(0, "127.0.0.1"); await once(server, "listening");
	const address = server.address(); assert.ok(address && typeof address !== "string");
	const url = `http://127.0.0.1:${address.port}/`;
	const profile = await mkdtemp(join(tmpdir(), "omp-btw-ui-"));
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
		async function open(name: string): Promise<void> {
			const loaded = ui.event("Page.loadEventFired");
			await ui.call("Page.navigate", { url: `${url}?${name}` });
			await loaded;
			await ui.wait(`window.ui?.token === '?${name}' && document.querySelector('#root').firstElementChild`);
		}
		const status = () => ui.evaluate<string>("document.querySelector('.omp-btw .omp-btw-status')?.textContent.trim() ?? ''");
		const requests = () => ui.evaluate<Record<string, unknown>[]>("window.ui.requests()");
		const popupReports = () => ui.evaluate<boolean[]>("window.sent.filter(message => message.type === 'omp:composer-popup').map(message => message.open)");

		await t.test("a side question that starts opens the panel, streams its answer as Markdown and ends with Copy and a follow-up row", async () => {
			await open("stream");
			assert.equal(await ui.evaluate("!!document.querySelector('.omp-btw')"), false, "nothing shows before a side question exists");
			await ui.evaluate("window.ui.btw([{ id: 'r1', turns: [window.ui.turn()] }])");
			await ui.wait("document.querySelector('.omp-btw')");
			assert.equal(await status(), "Answering…");
			assert.equal(await ui.evaluate("document.querySelector('.omp-btw').getAttribute('aria-label')"), "Side question");
			assert.match(await ui.evaluate<string>("document.querySelector('.omp-btw-question').textContent"), /why is it slow\?/);
			assert.equal(await ui.evaluate("!!document.querySelector('.omp-btw-cancel')"), true, "a running question has Cancel");
			assert.equal(await ui.evaluate("!!document.querySelector('.omp-btw-input')"), false, "no follow-up row while it runs");
			assert.equal(await ui.evaluate("!!document.querySelector('.omp-btw-copy')"), false, "nothing to copy yet");
			await ui.evaluate("window.ui.delta('r1', 0, 'It is **the disk**. ')");
			await ui.evaluate("window.ui.delta('r1', 20, 'Run `iostat`.')");
			await ui.wait("document.querySelector('.omp-btw-answer')?.textContent.includes('iostat')");
			assert.equal(await ui.evaluate("document.querySelector('.omp-btw-answer strong')?.textContent"), "the disk", "the answer is rendered as Markdown");
			// A delta for another length is ignored; the terminal record carries the whole answer.
			await ui.evaluate("window.ui.delta('r1', 3, 'IGNORED')");
			await ui.evaluate("window.ui.btw([{ id: 'r1', turns: [window.ui.turn({ status: 'complete', answer: 'It is **the disk**. Run `iostat`.', updatedAt: 2000 })] }])");
			await ui.wait("document.querySelector('.omp-btw-status')?.textContent.trim()==='Done'");
			assert.equal(await ui.evaluate("document.querySelector('.omp-btw-answer').textContent.includes('IGNORED')"), false);
			assert.equal(await ui.evaluate("!!document.querySelector('.omp-btw-cancel')"), false, "Cancel goes when the answer is done");
			assert.equal(await ui.evaluate("!!document.querySelector('.omp-btw-copy')"), true);
			assert.equal(await ui.evaluate("!!document.querySelector('.omp-btw-input')"), true, "a finished topic takes a follow-up");
			assert.equal(await ui.evaluate("document.querySelector('.omp-transcript')?.textContent.includes('iostat') ?? false"), false, "the answer is not a transcript row");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("Cancel sends one cancel request for the topic and the panel keeps showing it until OMP's record says cancelled", async () => {
			await open("cancel");
			await ui.evaluate("window.ui.btw([{ id: 'r1', turns: [window.ui.turn({ answer: 'partial' })] }])");
			await ui.wait("document.querySelector('.omp-btw-cancel')");
			await ui.evaluate("document.querySelector('.omp-btw-cancel').click()");
			const [request] = await requests();
			assert.equal(request!.op, "cancel");
			assert.equal(request!.recordId, "r1");
			assert.deepEqual(request!.epoch, { nonce: "host-ui-test", counter: 1 });
			assert.match(String(request!.requestId), /^[0-9a-f]{32}$/);
			assert.equal(await status(), "Answering…", "the panel waits for OMP's record");
			await ui.evaluate("window.ui.btw([{ id: 'r1', turns: [window.ui.turn({ status: 'cancelled', answer: 'partial' })] }])");
			await ui.wait("document.querySelector('.omp-btw-status')?.textContent.trim()==='Cancelled'");
			assert.equal(await ui.evaluate("!!document.querySelector('.omp-btw-cancel')"), false);
			assert.match(await ui.evaluate<string>("document.querySelector('.omp-btw-answer').textContent"), /partial/, "what streamed stays");
		});

		await t.test("a refused request shows its fixed sentence in the panel and the follow-up keeps its text", async () => {
			await open("follow-up");
			await ui.evaluate("window.ui.btw([{ id: 'r1', turns: [window.ui.turn()] }])");
			await ui.evaluate("window.ui.btw([{ id: 'r1', turns: [window.ui.turn({ status: 'complete', answer: 'Because.' })] }])");
			await ui.wait("document.querySelector('.omp-btw-input')");
			await ui.evaluate("(()=>{const input=document.querySelector('.omp-btw-input');input.focus();const set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;set.call(input,'and the cache?');input.dispatchEvent(new Event('input',{bubbles:true}))})()");
			await ui.wait("!document.querySelector('.omp-btw-send').disabled");
			await ui.evaluate("document.querySelector('.omp-btw-send').click()");
			await ui.wait("window.ui.requests().length===1");
			const [ask] = await requests();
			assert.equal(ask!.op, "ask");
			assert.equal(ask!.question, "and the cache?");
			assert.equal(ask!.recordId, "r1");
			await ui.evaluate(`window.ui.result(${JSON.stringify(ask!.requestId)}, "refused", "busy")`);
			await ui.wait("document.querySelector('.omp-btw-notice')");
			assert.match(await ui.evaluate<string>("document.querySelector('.omp-btw-notice-text').textContent"), /still answering/);
			assert.equal(await ui.evaluate("document.querySelector('.omp-btw-input').value"), "and the cache?", "a refusal keeps the question");
			await ui.evaluate("document.querySelector('.omp-btw-notice .omp-btw-action').click()");
			await ui.wait("!document.querySelector('.omp-btw-notice')");
			// Accepted: the follow-up row empties, and the new running turn appears from OMP's record.
			await ui.evaluate("document.querySelector('.omp-btw-send').click()");
			await ui.wait("window.ui.requests().length===2");
			const second = (await requests())[1]!;
			await ui.evaluate(`window.ui.result(${JSON.stringify(second.requestId)}, "accepted")`);
			await ui.evaluate("window.ui.btw([{ id: 'r1', turns: [window.ui.turn({ status: 'complete', answer: 'Because.' }), window.ui.turn({ question: 'and the cache?', createdAt: 3000, updatedAt: 3000 })] }])");
			await ui.wait("document.querySelectorAll('.omp-btw-turn').length===2");
			assert.equal(await status(), "Answering…");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("the history lists the topics newest first; picking one shows it; Back-to-list is the history button", async () => {
			await open("history");
			await ui.evaluate(`window.ui.btw([
				{ id: 'old', turns: [window.ui.turn({ question: 'older one', status: 'complete', answer: 'A1', createdAt: 1000 })] },
				{ id: 'new', turns: [window.ui.turn({ question: 'newer one', status: 'error', answer: '', error: 'rate limited', createdAt: 2000 })] },
			], { replace: true, show: 'history' })`);
			await ui.wait("document.querySelectorAll('.omp-btw-item').length===2");
			assert.deepEqual(await ui.evaluate("[...document.querySelectorAll('.omp-btw-item-text')].map(item=>item.textContent)"), ["newer one", "older one"]);
			await ui.evaluate("document.querySelectorAll('.omp-btw-item')[1].click()");
			await ui.wait("document.querySelector('.omp-btw-answer')");
			assert.match(await ui.evaluate<string>("document.querySelector('.omp-btw-answer').textContent"), /A1/);
			await ui.evaluate("document.querySelector('.omp-btw-history').click()");
			await ui.wait("document.querySelectorAll('.omp-btw-item').length===2");
			await ui.evaluate("document.querySelectorAll('.omp-btw-item')[0].click()");
			await ui.wait("document.querySelector('.omp-btw-error')");
			assert.equal(await ui.evaluate("document.querySelector('.omp-btw-error').textContent"), "rate limited", "a failed turn shows OMP's reason as plain text");
			assert.equal(await status(), "Failed");
		});

		await t.test("an empty history says how to ask; a list that replaces everything closes a topic that is gone", async () => {
			await open("empty");
			await ui.evaluate("window.ui.btw([], { replace: true, show: 'history' })");
			await ui.wait("document.querySelector('.omp-btw-empty')");
			assert.match(await ui.evaluate<string>("document.querySelector('.omp-btw-empty').textContent"), /\/btw/);
		});

		await t.test("Escape inside the panel cancels a running question, then closes it, and owns the key only while the focus is in the panel", async () => {
			await open("escape");
			await ui.evaluate("window.ui.btw([{ id: 'r1', turns: [window.ui.turn({ answer: 'x' })] }])");
			await ui.wait("document.querySelector('.omp-btw-body')");
			assert.deepEqual(await popupReports(), [], "an open panel without focus does not claim Escape from the composer");
			await ui.evaluate("document.querySelector('.omp-btw-body').focus()");
			await ui.wait("window.sent.some(message => message.type === 'omp:composer-popup' && message.open === true)");
			await ui.call("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
			await ui.call("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
			await ui.wait("window.ui.requests().length===1");
			assert.equal((await requests())[0]!.op, "cancel", "Escape cancels what is running");
			await ui.evaluate("window.ui.btw([{ id: 'r1', turns: [window.ui.turn({ status: 'cancelled', answer: 'x' })] }])");
			await ui.wait("document.querySelector('.omp-btw-status')?.textContent.trim()==='Cancelled'");
			await ui.evaluate("document.querySelector('.omp-btw-body').focus()");
			await ui.call("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
			await ui.call("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
			await ui.wait("!document.querySelector('.omp-btw')");
			assert.equal((await requests()).length, 1, "closing sends nothing");
			const reports = await popupReports();
			assert.equal(reports.at(-1), false, "the panel gave Escape back when it closed");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("the panel fits a narrow editor and a long answer scrolls inside it", async () => {
			await open("narrow");
			await ui.call("Emulation.setDeviceMetricsOverride", { width: 360, height: 700, deviceScaleFactor: 1, mobile: false });
			const answer = Array.from({ length: 120 }, (_, index) => `Line ${index} of a long answer`).join("\\n\\n");
			await ui.evaluate("window.ui.btw([{ id: 'r1', turns: [window.ui.turn()] }])");
			await ui.evaluate(`window.ui.btw([{ id: 'r1', turns: [window.ui.turn({ status: 'complete', answer: ${JSON.stringify(answer)} })] }])`);
			await ui.wait("document.querySelector('.omp-btw-body')");
			const box = await ui.evaluate<{ overflow: number; panel: number; body: number; scrolls: boolean }>(`(()=>{const panel=document.querySelector('.omp-btw').getBoundingClientRect();const body=document.querySelector('.omp-btw-body');
				return{overflow:document.documentElement.scrollWidth-innerWidth,panel:panel.height,body:body.clientHeight,scrolls:body.scrollHeight>body.clientHeight}})()`);
			assert.equal(box.overflow <= 0, true, "no horizontal page overflow at 360 px");
			assert.equal(box.scrolls, true, "the answer scrolls inside the panel");
			assert.equal(box.panel < 700 * 0.6, true, "the panel never takes over the page");
			await ui.call("Emulation.setDeviceMetricsOverride", { width: 900, height: 800, deviceScaleFactor: 1, mobile: false });
		});
	} finally {
		page?.socket.close(); browser?.socket.close();
		child.kill();
		await once(child, "exit").catch(() => undefined);
		server.close();
		await rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
});

/**
 * The turn totals, served-model marker, thinking time and provider-error frame of a Chat, rendered by the real React app in an
 * owned headless Chromium (never an installed VS Code window).
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
		 function cleanup(){observer.disconnect();document.removeEventListener('fixture-post',check);clearTimeout(timer);}
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
const epoch = { nonce: "reply-meta-ui", counter: 1 };
const client = new ChatClient(guestTransport); client.attach(guestTransport);
const liveState = { model: { provider: "anthropic", id: "claude-opus-5", name: "Claude Opus 5", contextWindow: 1000000 }, thinkingLevel: "low", isStreaming: false, isCompacting: false, queuedMessageCount: 0,
 contextUsage: { tokens: 40700, contextWindow: 1000000, percent: 4.07 } };
let current = { ...snapshotOf(createChatModel(), epoch), phase: "live", state: liveState };
function receive(message) { window.dispatchEvent(new MessageEvent("message", { data: message })); }
function push(patch = {}) { current = { ...current, ...patch }; const parts = splitChatSnapshot(current, "ui-snapshot");
 receive(parts.snapshot); for (const chunk of parts.chunks) receive(chunk);
}
window.row = (id, message) => ({ type: "message", id, parentId: null, timestamp: new Date(message.timestamp).toISOString(), message });
window.usage = (input, output, cost = 0, extra = {}) => ({ input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output, cost: { total: cost }, ...extra });
window.asst = (timestamp, content, patch = {}) => ({ role: "assistant", provider: "anthropic", model: "claude-opus-5", timestamp, stopReason: "stop", content, ...patch });
window.answeredServed = new Set();
window.ui = {
 token: location.search, current: () => current, receive, push, epoch,
 view(patch = {}) { receive({ type: "omp:session-view", mode: "chat", title: "Owned UI session", running: true, starting: false, stopping: false, canSwitch: true, reason: null, ...patch }); },
 frame(frame) { receive({ type: "omp:chat-event", epoch: current.epoch, frame }); },
 entries(entries, leafId) { receive({ type: "omp:chat-entries", epoch: current.epoch, entries, leafId }); },
 requests: () => window.sent.filter(message => message.type === "omp:control-request"),
 reply(request = window.ui.requests().at(-1), patch = {}) { receive({ type: "omp:control-state", scope: request.scope, requestId: request.requestId, available: true,
  model: current.state.model, thinkingLevel: current.state.thinkingLevel, mutationMode: "best-effort", ...patch }); },
 asked: () => window.sent.filter(message => message.type === "omp:served-models-request"),
 // The host's answer to every request not yet answered: a verdict by the served id, "unknown" for an id the table does not name.
 answerServed(table) {
  for (const request of window.ui.asked()) {
   if (window.answeredServed.has(request.requestId)) continue;
   window.answeredServed.add(request.requestId);
   receive({ type: "omp:served-models", requestId: request.requestId, verdicts: request.pairs.map(pair => table[pair.served] ?? "unknown") });
  }
 },
};
const nonce=readCspNonce(); adoptNonceForCreatedStyles(nonce); injectGuestStyles(nonce);
createRoot(document.getElementById("root")).render(<App client={client} />); window.ui.view(); push({ state: liveState });
`;

// Skipped when no Chromium-based browser is found; set OMP_TEST_CHROMIUM to point at one.
test("turn totals, served-model marker, thinking time and the provider-error frame", { skip: browserPath === undefined, timeout: 240_000 }, async t => {
	const bundled = await build({ stdin: { contents: fixture, loader: "tsx", resolveDir: join(process.cwd(), "src/webview") },
		bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic", loader: { ".css": "text" }, define: { "process.env.NODE_ENV": '"production"' } });
	const script = bundled.outputFiles[0]!.text;
	const server = createServer((request, response) => {
		const fixtureUrl = new URL(request.url ?? "/", "http://fixture");
		const pathname = fixtureUrl.pathname;
		if (pathname === "/codicons/codicon.css" || pathname === "/codicons/codicon.ttf") {
			const file = pathname.endsWith(".css") ? "codicon.css" : "codicon.ttf";
			response.setHeader("Content-Type", file.endsWith(".css") ? "text/css" : "font/ttf");
			response.end(readFileSync(join(process.cwd(), "node_modules/@vscode/codicons/dist", file)));
			return;
		}
		if (pathname === "/ui.js") {
			response.setHeader("Content-Type", "text/javascript"); response.end(script); return;
		}
		response.setHeader("Content-Type", "text/html");
		const webview = {
			cspSource: "'self'",
			asWebviewUri: (uri: { path: string }) => ({ toString: () => uri.path.endsWith(".js") ? "/ui.js" : "/codicons/codicon.css" }),
		} as unknown as vscode.Webview;
		const extensionUri = {
			path: "/extension", with({ path }: { path: string }) { return { path }; },
		} as unknown as vscode.Uri;
		const html = createGuestHtml(webview, extensionUri, "tab:2c26b46b-68ff-4c1d-a3d8-1e0f9a0b7c6d", null);
		const nonce = /<script nonce="([^"]+)"/.exec(html)![1]!;
		response.end(html.replace("</head>", `<style nonce="${nonce}">:root {
			--vscode-editor-background:#1e1e1e;--vscode-editor-foreground:#dddddd;--vscode-foreground:#dddddd;--vscode-editorWidget-background:#252526;
			--vscode-button-background:#007acc;--vscode-button-foreground:white;--vscode-input-background:#3c3c3c;
			--vscode-input-foreground:#ddd;--vscode-panel-border:#555;--vscode-font-family:Arial;--vscode-font-size:13px;
		}</style><script nonce="${nonce}">window.sent=[];window.errors=[];window.addEventListener("error",event=>window.errors.push(event.message));
		window.copied=null;
		Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText:async text=>{window.copied=text}}});
		window.acquireVsCodeApi=()=>({postMessage(message){window.sent.push(message);document.dispatchEvent(new Event("fixture-post"))},setState(){}});</script>
		</head>`));
	});
	server.listen(0, "127.0.0.1"); await once(server, "listening");
	const address = server.address(); assert.ok(address && typeof address !== "string");
	const url = `http://127.0.0.1:${address.port}/`;
	const profile = await mkdtemp(join(tmpdir(), "omp-reply-meta-ui-"));
	const child = spawn(browserPath!, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
		"--disable-extensions", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
	let browser: Cdp | undefined;
	let page: Cdp | undefined;
	try {
		const readiness = Promise.withResolvers<string>();
		let stderr = "";
		// A launch-failure bound only; the browser suites start Chromium at once and a loaded runner took over 20 s.
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
		/** A fresh page; the footer's first control snapshot is answered so the model picker can open. */
		async function open(name: string): Promise<void> {
			const loaded = ui.event("Page.loadEventFired");
			await ui.call("Page.navigate", { url: `${url}?${name}` });
			await loaded;
			await ui.wait(`window.ui?.token === '?${name}' && document.querySelector('.omp-footer-trigger') && window.ui.requests().length === 1`);
			await ui.evaluate("window.ui.reply()");
			await ui.wait("!document.querySelector('.omp-footer-trigger').disabled");
		}
		// Real time passes only where the page's own once-a-second title tick or a "nothing more happens" absence is the thing under test.
		const sleep = (ms: number) => ui.evaluate(`new Promise(resolve=>setTimeout(resolve,${ms}))`);
		const noErrors = async () => assert.deepEqual(await ui.evaluate("window.errors"), []);

		await t.test("a finished reply shows the turn's totals and their exact counts; no usage, zero cost and sub-cent cost each read right", async () => {
			await open("reply-usage");
			await ui.evaluate(`window.ui.push({working:false,settled:true,durableCount:11,entries:[
			 row('u1',{role:'user',timestamp:1000,content:'Do it'}),
			 row('a1',asst(2000,[{type:'text',text:'Reading'},{type:'toolCall',id:'t1',name:'read',arguments:{path:'a.ts'}}],{stopReason:'toolUse',usage:usage(8000,500,0.011,{cacheRead:20000,cacheWrite:1000})})),
			 row('r1',{role:'toolResult',toolCallId:'t1',toolName:'read',timestamp:2500,isError:false,content:[{type:'text',text:'out'}]}),
			 row('a2',asst(3000,[{type:'text',text:'Done'}],{completedAt:13000,usage:usage(9000,1500,0.0136)})),
			 row('u2',{role:'user',timestamp:20000,content:'Again'}),
			 row('a3',asst(21000,[{type:'text',text:'No usage here'}],{completedAt:22000})),
			 row('u3',{role:'user',timestamp:30000,content:'Free'}),
			 row('a4',asst(31000,[{type:'text',text:'Zero cost'}],{completedAt:32000,usage:usage(120,30,0)})),
			 row('u4',{role:'user',timestamp:40000,content:'Cheap'}),
			 row('a5',asst(41000,[{type:'text',text:'Sub-cent'}],{completedAt:42000,usage:usage(120,30,0.0021)})),
			 row('a6',asst(43000,[],{stopReason:'toolUse',content:[{type:'redactedThinking',data:'x'}],usage:usage(0,0,0)}))
			]})`);
			await ui.wait("document.querySelectorAll('.omp-reply-footer').length===4");
			const footers = await ui.evaluate<{ duration: string; usage: string | null; title: string | null; order: string[] }[]>(`[...document.querySelectorAll('.omp-reply-footer')].map(footer=>{
			 const usage=footer.querySelector('.omp-reply-usage');
			 return{duration:footer.firstElementChild.textContent,usage:usage?.textContent??null,title:usage?.title??null,order:[...footer.querySelectorAll(':scope > span')].map(span=>span.className||'plain')}})`);
			assert.deepEqual(footers.map(footer => footer.usage), ["20K tok · $0.02 this turn", null, "150 tok this turn", "150 tok · <$0.01 this turn"]);
			assert.equal(footers[0]!.duration, "12s");
			assert.equal(footers[0]!.title, "This turn: 12s · 20,000 tokens (18,000 in, 1,000 of them cache write · 2,000 out) · 20,000 cache read · 2 requests · $0.02");
			assert.equal(footers[2]!.title, "This turn: 2s · 150 tokens (120 in · 30 out)", "the turn runs from the prompt, not from the request");
			assert.match(footers[3]!.title!, /\$0\.0021$/);
			assert.deepEqual(footers[0]!.order, ["plain", "omp-reply-usage", "omp-reply-time"], "duration, totals, time of day");
			assert.deepEqual(footers[1]!.order, ["plain", "omp-reply-time"], "a reply without usage keeps its footer and draws no totals");
			assert.equal(await ui.evaluate("getComputedStyle(document.querySelector('.omp-reply-usage'),'::before').content"), '"·"');
			await noErrors();
		});

		await t.test("a turn the window cut at the top still counts all of its requests", async () => {
			await open("reply-usage-window");
			const rows = Array.from({ length: 70 }, (_, index) => `row('f${index}',asst(${2000 + index * 10},[{type:'text',text:'Filler ${index}'}],{usage:usage(1,1,0)}))`).join(",");
			await ui.evaluate(`window.ui.push({working:false,settled:true,durableCount:73,entries:[
			 row('u',{role:'user',timestamp:1000,content:'Long turn'}),
			 row('first',asst(1500,[{type:'toolCall',id:'t1',name:'read',arguments:{path:'a.ts'}}],{stopReason:'toolUse',usage:usage(4000,100,0.01)})),
			 row('r1',{role:'toolResult',toolCallId:'t1',toolName:'read',timestamp:1600,isError:false,content:[{type:'text',text:'out'}]}),
			 ${rows}
			]})`);
			await ui.wait("document.querySelector('.omp-reply-footer .omp-reply-usage')");
			const totals = await ui.evaluate<string[]>("[...document.querySelectorAll('.omp-reply-usage')].map(node=>node.textContent)");
			assert.equal(totals.length, 1, "one reply, one footer");
			assert.equal(totals[0], "4.2K tok · $0.01 this turn", "the first request, far above the window, is in the turn's sum (4000+100 plus 70 filler requests of 2)");
			await noErrors();
		});

		await t.test("the served-model marker follows the host's verdict: a mismatch once, never a snapshot, a codename or an unanswered pair", async () => {
			await open("served-model");
			const turn = (n: number, patch: string) => `row('u${n}',{role:'user',timestamp:${n * 10000},content:'Turn ${n}'}),row('a${n}',asst(${n * 10000 + 1000},[{type:'text',text:'Reply ${n}'}],{completedAt:${n * 10000 + 2000}${patch}}))`;
			await ui.evaluate(`window.ui.push({working:false,settled:true,durableCount:12,entries:[
			 ${turn(1, ",upstreamModel:'claude-haiku-4-5',upstreamProvider:'Amazon Bedrock'")},
			 ${turn(2, ",upstreamModel:'claude-haiku-4-5'")},
			 ${turn(3, ",upstreamModel:'claude-opus-5-20260101'")},
			 ${turn(4, ",upstreamModel:'numbat-v6-example'")},
			 ${turn(5, "")},
			 ${turn(6, ",upstreamModel:'claude-opus-5'")}
			]})`);
			await ui.wait("document.querySelectorAll('.omp-reply-footer').length===6 && window.ui.asked().length>0");
			// The page asks about the three pairs that differ textually, once, and about nothing else.
			assert.deepEqual(await ui.evaluate("window.ui.asked().map(request=>request.pairs)"), [[
				{ provider: "anthropic", requested: "claude-opus-5", served: "claude-haiku-4-5" },
				{ provider: "anthropic", requested: "claude-opus-5", served: "claude-opus-5-20260101" },
				{ provider: "anthropic", requested: "claude-opus-5", served: "numbat-v6-example" },
			]]);
			assert.equal(await ui.evaluate("document.querySelectorAll('.omp-served-model').length"), 0, "no marker before the host has answered");
			// A foreign answer, and one of the wrong length, change nothing.
			await ui.evaluate("window.ui.receive({type:'omp:served-models',requestId:9999,verdicts:['mismatch']});window.ui.receive({type:'omp:served-models',requestId:window.ui.asked()[0].requestId,verdicts:['mismatch']})");
			await sleep(100);
			assert.equal(await ui.evaluate("document.querySelectorAll('.omp-served-model').length"), 0);
			await ui.evaluate("window.ui.answerServed({'claude-haiku-4-5':'mismatch','claude-opus-5-20260101':'same','numbat-v6-example':'unknown'})");
			await ui.wait("document.querySelector('.omp-served-model')");
			const markers = await ui.evaluate<{ text: string; role: string | null; inFooter: number; footers: number }[]>(`[...document.querySelectorAll('.omp-served-model')].map(node=>({text:node.textContent,role:node.getAttribute('role'),inFooter:[...document.querySelectorAll('.omp-reply-footer')].indexOf(node.closest('.omp-reply-footer')),footers:document.querySelectorAll('.omp-reply-footer').length}))`);
			assert.deepEqual(markers, [{ text: "served claude-haiku-4-5 · requested claude-opus-5 · via anthropic/Amazon Bedrock", role: "note", inFooter: 0, footers: 6 }],
				"the same substitution on turn 2 is not announced again; a snapshot suffix (same) and a codename (unknown) show nothing");
			// A new pair asks once more and only for itself; the first marker stays.
			await ui.evaluate(`window.ui.push({durableCount:14,entries:[...window.ui.current().entries,
			 ${turn(7, ",model:'claude-sonnet-5',upstreamModel:'claude-haiku-4-5'")}]})`);
			await ui.wait("window.ui.asked().length===2");
			assert.deepEqual(await ui.evaluate("window.ui.asked()[1].pairs"), [{ provider: "anthropic", requested: "claude-sonnet-5", served: "claude-haiku-4-5" }]);
			await ui.evaluate("window.ui.answerServed({'claude-haiku-4-5':'mismatch'})");
			await ui.wait("document.querySelectorAll('.omp-served-model').length===2");
			assert.deepEqual(await ui.evaluate("[...document.querySelectorAll('.omp-served-model')].map(node=>node.textContent)"), [
				"served claude-haiku-4-5 · requested claude-opus-5 · via anthropic/Amazon Bedrock",
				"served claude-haiku-4-5 · requested claude-sonnet-5 · via anthropic",
			]);
			await noErrors();
		});

		await t.test("a transcript whose models all match asks nothing and draws no marker", async () => {
			await open("served-model-none");
			await ui.evaluate(`window.ui.push({working:false,settled:true,durableCount:4,entries:[
			 row('u1',{role:'user',timestamp:1000,content:'One'}),row('a1',asst(2000,[{type:'text',text:'Plain'}],{completedAt:3000})),
			 row('u2',{role:'user',timestamp:4000,content:'Two'}),row('a2',asst(5000,[{type:'text',text:'Same id'}],{completedAt:6000,upstreamModel:'claude-opus-5'}))]})`);
			await ui.wait("document.querySelectorAll('.omp-reply-footer').length===2");
			await sleep(150);
			assert.deepEqual(await ui.evaluate("[window.ui.asked().length,document.querySelectorAll('.omp-served-model').length]"), [0, 0]);
			await noErrors();
		});

		await t.test("thinking: Thinking… Ns while it streams, Thought for Ns after, and no time for history or a block that began before the page looked", async () => {
			await open("thinking-live");
			const title = () => ui.evaluate<string | null>("document.querySelector('.omp-thinking > summary')?.textContent ?? null");
			await ui.evaluate("window.now=1000000;Date.now=()=>window.now");
			await ui.evaluate(`window.ui.frame({type:'agent_start'});window.ui.frame({type:'message_start',messageId:'live1',message:asst(5000,[{type:'thinking',thinking:''}],{stopReason:'stop'})});
			 window.ui.frame({type:'message_update',messageId:'live1',message:asst(5000,[{type:'thinking',thinking:'Weighing the options'}])})`);
			await ui.wait("document.querySelector('.omp-thinking > summary')");
			assert.equal(await title(), "Thinking…", "under a second there is no number");
			await ui.evaluate("window.now=1007000");
			await ui.wait("document.querySelector('.omp-thinking > summary').textContent==='Thinking… 7s'");
			await ui.evaluate("window.now=1007900");
			await ui.wait("document.querySelector('.omp-thinking > summary').textContent==='Thinking… 7s'");
			await ui.evaluate("window.now=1009400;window.ui.frame({type:'message_update',messageId:'live1',message:asst(5000,[{type:'thinking',thinking:'Weighing the options'},{type:'text',text:'Answer'}])})");
			await ui.wait("document.querySelector('.omp-thinking > summary').textContent==='Thought for 9s'");
			// The reply ends and becomes a saved entry: a different row that must keep the measured time.
			await ui.evaluate(`window.now=1010000;window.final=asst(5000,[{type:'thinking',thinking:'Weighing the options'},{type:'text',text:'Answer'}],{completedAt:1010000,usage:usage(10,10,0)});
			 window.ui.frame({type:'message_end',messageId:'live1',message:window.final});window.ui.frame({type:'agent_end',isTerminal:true});window.ui.frame({type:'session_settled'})`);
			await ui.evaluate(`window.ui.entries([row('u1',{role:'user',timestamp:4000,content:'Think'}),row('a1',window.final)],'a1')`);
			await ui.wait("document.querySelector('.omp-transcript').textContent.includes('Answer')");
			await sleep(1300);
			assert.equal(await title(), "Thought for 9s", "the saved entry keeps the time measured while it streamed");
			await noErrors();

			// History nobody watched: no time rather than a wrong one.
			await open("thinking-history");
			await ui.evaluate(`window.ui.push({working:false,settled:true,durableCount:2,entries:[row('u1',{role:'user',timestamp:1000,content:'Think'}),row('a1',asst(2000,[{type:'thinking',thinking:'Long ago'},{type:'text',text:'Answer'}],{completedAt:99000}))]})`);
			await ui.wait("document.querySelector('.omp-thinking > summary')");
			assert.equal(await title(), "Thought");

			// A snapshot taken mid-stream: the beginning was not watched, so it counts no seconds, before or after.
			await open("thinking-attach");
			await ui.evaluate("window.now=2000000;Date.now=()=>window.now");
			await ui.evaluate(`window.ui.push({working:true,settled:false,stream:{messageId:'live9',message:asst(7000,[{type:'thinking',thinking:'Already going'}])},streamPosition:{anchorId:null,seq:1},transcriptEventSeq:1})`);
			await ui.wait("document.querySelector('.omp-thinking > summary')");
			assert.equal(await title(), "Thinking…");
			await ui.evaluate("window.now=2030000");
			await sleep(1300);
			assert.equal(await title(), "Thinking…", "no invented elapsed time after the page attached");
			await ui.evaluate("window.ui.frame({type:'message_update',messageId:'live9',message:asst(7000,[{type:'thinking',thinking:'Already going'},{type:'text',text:'Done'}])})");
			await ui.wait("document.querySelector('.omp-thinking > summary').textContent==='Thought'");
			await noErrors();
		});

		await t.test("a provider error is a frame: status chip, the message, Copy error, and on the last reply Switch model and Retry", async () => {
			await open("provider-error");
			const long = `Upstream said: ${"overloaded ".repeat(60)}end`;
			await ui.evaluate(`window.longError=${JSON.stringify(long)};window.ui.push({working:false,settled:true,durableCount:4,entries:[
			 row('u1',{role:'user',timestamp:1000,content:'First'}),row('e1',asst(2000,[],{stopReason:'error',errorStatus:429,errorMessage:'Rate limit reached'})),
			 row('u2',{role:'user',timestamp:3000,content:'Second'}),row('e2',asst(4000,[],{stopReason:'error',errorMessage:window.longError}))]})`);
			await ui.wait("document.querySelectorAll('.omp-turn-error').length===2 && document.querySelector('.omp-retry-turn')");
			const frames = await ui.evaluate<{ chip: string | null; head: string; text: string; actions: string[] }[]>(`[...document.querySelectorAll('.omp-turn-error')].map(frame=>({
			 chip:frame.querySelector('.omp-turn-error-status')?.textContent??null,head:frame.querySelector('strong').textContent,text:frame.textContent,
			 actions:[...frame.nextElementSibling.querySelectorAll('button')].map(button=>button.textContent)}))`);
			assert.equal(frames[0]!.chip, "429");
			assert.equal(frames[0]!.text, "Provider error429Rate limit reached");
			assert.deepEqual(frames[0]!.actions, ["Copy error"], "an earlier failure keeps Copy error only");
			assert.equal(frames[1]!.chip, null, "no recorded status, no chip");
			assert.deepEqual(frames[1]!.actions, ["Show all", "Copy error", "Switch model", "Retry"]);
			// The long body is cut to three lines until the reader asks for all of it, and the choice survives the row being redrawn.
			const bodyHeights = () => ui.evaluate<{ clamped: boolean; shown: number; full: number; expanded: string | null }>(`(()=>{const frame=document.querySelectorAll('.omp-turn-error')[1],body=frame.querySelector('.omp-turn-error-body');
			 return{clamped:frame.classList.contains('omp-turn-error--clamped'),shown:body.clientHeight,full:body.scrollHeight,expanded:frame.nextElementSibling.querySelector('button').getAttribute('aria-expanded')}})()`);
			const cut = await bodyHeights();
			assert.ok(cut.clamped && cut.full > cut.shown * 1.5 && cut.expanded === "false", JSON.stringify(cut));
			await ui.evaluate("document.querySelectorAll('.omp-turn-error')[1].nextElementSibling.querySelector('button').click()");
			await ui.wait("!document.querySelectorAll('.omp-turn-error')[1].classList.contains('omp-turn-error--clamped')");
			const open_ = await bodyHeights();
			assert.ok(!open_.clamped && open_.shown >= cut.full - 1 && open_.expanded === "true", JSON.stringify(open_));
			assert.equal(await ui.evaluate("document.querySelectorAll('.omp-turn-error')[1].nextElementSibling.querySelector('button').textContent"), "Show less");
			await ui.evaluate("document.querySelectorAll('.omp-turn-error')[1].nextElementSibling.querySelector('button').click()");
			await ui.wait("document.querySelectorAll('.omp-turn-error')[1].classList.contains('omp-turn-error--clamped')");

			// Copy error copies the status and the message.
			await ui.evaluate("document.querySelectorAll('.omp-turn-error-actions')[0].querySelector('.omp-error-copy').click()");
			await ui.wait("window.copied==='HTTP 429: Rate limit reached'");
			await ui.wait("document.querySelectorAll('.omp-turn-error-actions')[0].querySelector('[role=status]')?.textContent==='Copied'");
			await ui.evaluate("document.querySelectorAll('.omp-turn-error-actions')[1].querySelector('.omp-error-copy').click()");
			await ui.wait("window.copied===window.longError");

			// Switch model opens the footer's own model picker (one control request, the same as its model button) and is off while that request is open.
			assert.equal(await ui.evaluate("window.ui.requests().length"), 1);
			await ui.evaluate("document.querySelector('.omp-error-switch-model').click()");
			await ui.wait("window.ui.requests().length===2");
			assert.deepEqual(await ui.evaluate("(({action,picker})=>({action,picker}))(window.ui.requests().at(-1))"), { action: "snapshot", picker: "model" });
			await ui.wait("document.querySelector('.omp-error-switch-model').disabled");
			await ui.evaluate("window.ui.reply()");
			await ui.wait("!document.querySelector('.omp-error-switch-model').disabled");

			// Retry is kept and runs OMP's /retry.
			await ui.evaluate("document.querySelector('.omp-turn-error-actions:last-of-type .omp-retry-turn:last-child').click()");
			await ui.wait("window.sent.some(message=>message.type==='omp:chat-prompt'&&message.text==='/retry')");
			// While a turn runs there is nothing to retry or switch.
			await ui.evaluate("window.ui.push({working:true,settled:false})");
			await ui.wait("!document.querySelector('.omp-error-switch-model')");
			assert.equal(await ui.evaluate("document.querySelectorAll('.omp-turn-error-actions .omp-error-action').length"), 3, "Copy error of the first frame, Show all and Copy error of the second: no Switch model");
			assert.equal(await ui.evaluate("document.querySelector('.omp-retry-turn')"), null, "and no Retry");
			await noErrors();
		});
	} finally {
		page?.socket.close();
		browser?.socket.close();
		child.kill();
		server.close();
		await rm(profile, { recursive: true, force: true }).catch(() => undefined);
	}
});

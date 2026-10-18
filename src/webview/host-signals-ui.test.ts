/**
 * The footer chips (goal, fast mode, slow mode, usage limit), the ask dialog's option preview and countdown, and the plain-text
 * notices of an extension's failure and a dropped frame, rendered by the real React app in an owned headless Chromium.
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
window.ui = {
 token: location.search, current: () => current, receive, push, epoch, liveState,
 view(patch = {}) { receive({ type: "omp:session-view", mode: "chat", title: "Owned UI session", running: true, starting: false, stopping: false, canSwitch: true, reason: null, ...patch }); },
 event(frame) { receive({ type: "omp:chat-event", epoch, frame }); },
};
const nonce=readCspNonce(); adoptNonceForCreatedStyles(nonce); injectGuestStyles(nonce);
createRoot(document.getElementById("root")).render(<App client={client} />); window.ui.view(); push({ state: liveState });
`;

// Skipped when no Chromium-based browser is found; set OMP_TEST_CHROMIUM to point at one.
test("host signals: footer chips, ask preview and countdown, plain-text failure notices", { skip: browserPath === undefined, timeout: 160_000 }, async t => {
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
	const profile = await mkdtemp(join(tmpdir(), "omp-host-signals-ui-"));
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
		const chips = () => ui.evaluate<{ signal: string; text: string; title: string; warn: boolean }[]>(`[...document.querySelectorAll('.omp-signals .omp-signal')].map(chip=>({signal:chip.dataset.signal,text:chip.textContent.trim(),title:chip.title,warn:chip.classList.contains('omp-signal--warn')}))`);
		const GOAL = "{id:'g',objective:'Ship the release',status:'active',tokensUsed:12345,tokenBudget:50000,timeUsedSeconds:61}";

		await t.test("the footer shows the goal with its budget, fast mode, slow mode and the usage limit, each only while it holds", async () => {
			await open("chips");
			assert.equal(await ui.evaluate("document.querySelector('.omp-signals')"), null, "a session with none of them shows no chip");
			await ui.evaluate(`window.ui.push({state:{...window.ui.liveState,goal:{objective:'Ship the release',status:'active',tokensUsed:12345,tokenBudget:50000,timeUsedSeconds:61},fastMode:{enabled:true,active:true},slowMode:{supported:true,enabled:true,scope:'global'},usageLimit:{stage:'wrap_up',extraUsage:true}}})`);
			await ui.wait("document.querySelectorAll('.omp-signals .omp-signal').length===4");
			const shown = await chips();
			assert.deepEqual(shown.map(chip => chip.signal), ["goal", "fast", "slow", "usage-limit"]);
			assert.equal(shown[0]!.text, "Goal 12.3k/50k", "tokens used against the budget");
			assert.match(shown[0]!.title, /Ship the release/);
			assert.match(shown[0]!.title, /1m 01s/, "the time the goal has run is in the tooltip");
			assert.equal(shown[1]!.text, "Fast");
			assert.match(shown[2]!.title, /every session/, "a global slow mode says it is OMP's setting");
			assert.equal(shown[3]!.text, "limit reached · wrap-up, then extra usage");
			assert.equal(shown[3]!.warn, true);
			assert.equal(await ui.evaluate("document.querySelector('.omp-signals .omp-signal[data-signal=goal] .codicon').className.includes('codicon-target')"), true);
			// The chips share the toolbar with the pickers without pushing them out of it.
			const fit = await ui.evaluate<{ pickers: boolean; overflow: number }>(`(()=>{const bar=document.querySelector('.omp-composer-toolbar').getBoundingClientRect();
			 return{pickers:[...document.querySelectorAll('.omp-composer-lead > .omp-footer-trigger')].every(button=>{const box=button.getBoundingClientRect();return box.width>40&&box.right<=bar.right}),overflow:document.documentElement.scrollWidth-innerWidth}})()`);
			assert.equal(fit.pickers, true);
			assert.equal(fit.overflow <= 0, true, "no horizontal page overflow");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("the low-priority stage is one chip: the slow chip steps aside for the limit's own text", async () => {
			await ui.evaluate(`window.ui.push({state:{...window.ui.liveState,slowMode:{supported:true,enabled:true,scope:'global'},usageLimit:{stage:'low_priority',resetsAtSec:Math.floor(Date.now()/1000)+3600,allowanceLeftPercent:40}}})`);
			await ui.wait("document.querySelectorAll('.omp-signals .omp-signal').length===1");
			const [only] = await chips();
			assert.equal(only!.signal, "usage-limit");
			assert.match(only!.text, /^low priority until \S+( [AP]M)? · 40% left$/);
		});

		await t.test("a goal_updated event keeps the goal chip current, a paused goal is flagged and a cleared one removes it", async () => {
			await ui.evaluate(`window.ui.push({state:{...window.ui.liveState,goal:${GOAL}}})`);
			await ui.wait("document.querySelector('.omp-signal[data-signal=goal]')");
			await ui.evaluate(`window.ui.event({type:'goal_updated',goal:{...${GOAL},status:'budget-limited',tokensUsed:50000},state:{enabled:true,mode:'active'}})`);
			await ui.wait("document.querySelector('.omp-signal[data-goal-status=budget-limited]')");
			const [limited] = await chips();
			assert.equal(limited!.text, "Goal 50k/50k");
			assert.equal(limited!.warn, true);
			await ui.evaluate(`window.ui.event({type:'goal_updated',goal:{...${GOAL},status:'paused'},state:{enabled:false}})`);
			await ui.wait("document.querySelector('.omp-signal[data-goal-status=paused]')");
			assert.equal(await ui.evaluate("document.querySelector('.omp-signal[data-goal-status=paused] .codicon').className.includes('codicon-debug-pause')"), true);
			await ui.evaluate("window.ui.event({type:'goal_updated',goal:null})");
			await ui.wait("document.querySelector('.omp-signal[data-signal=goal]') === null");
		});

		await t.test("an extension's failure and a dropped frame are plain-text notices: markup and underscores stay as written", async () => {
			await open("notices");
			const message = 'Extension "/ext/my_guard_rule.ts" error (tool_call): <b>bold</b> *star* `code`';
			await ui.evaluate(`window.ui.event({type:'notice',level:'error',source:'Extension error',message:${JSON.stringify(message)}})`);
			await ui.evaluate(`window.ui.event({type:'notice',level:'warning',source:'Frame dropped',message:'OMP dropped a "tool_execution_end" event: RPC frame exceeded the transport limit. Chat reads the session file again to catch up.'})`);
			await ui.wait("document.querySelectorAll('[data-notice-source]').length===2");
			const shown = await ui.evaluate<{ heads: string[]; text: string; markup: number; classes: string[] }>(`(()=>{const rows=[...document.querySelectorAll('[data-notice-source]')];
			 return{heads:rows.map(row=>row.querySelector('header').textContent),text:rows[0].querySelector('.omp-native-plain').textContent,markup:rows[0].querySelectorAll('b,em,code,script').length,classes:rows.map(row=>row.className)}})()`);
			assert.deepEqual(shown.heads, ["Extension error", "Frame dropped"]);
			assert.equal(shown.text, message, "shown exactly as the extension wrote it");
			assert.equal(shown.markup, 0, "nothing in it became an element");
			assert.match(shown.classes[0]!, /omp-error/);
			assert.match(shown.classes[1]!, /omp-warning/);
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("an ask option's preview shows below the list for the highlighted option and follows the pointer", async () => {
			await open("ask-preview");
			const questions = JSON.stringify([{ id: "layout", question: "Which layout?", multi: false, recommended: 0, options: [
				{ label: "Grid", preview: "```\n+--+--+\n|  |  |\n+--+--+\n```" },
				{ label: "List", description: "One per row", preview: "Plain **list** preview" },
				{ label: "Table" },
			] }]);
			await ui.evaluate(`window.ui.push({uiRequests:[{id:'ask-pv',method:'ask',title:'Which layout?',questions:${questions}}],working:true,settled:false})`);
			await ui.wait("document.querySelector('.omp-ask-preview')");
			const preview = () => ui.evaluate<{ label: string; text: string; code: boolean; bold: boolean } | null>(`(()=>{const box=document.querySelector('.omp-ask-preview');return box?{label:box.getAttribute('aria-label'),text:box.textContent,code:box.querySelector('pre')!==null,bold:box.querySelector('strong')!==null}:null})()`);
			const first = await preview();
			assert.equal(first?.label, "Preview of Grid", "the recommended option's preview is shown first");
			assert.equal(first?.code, true, "a fenced block is code");
			assert.match(first?.text ?? "", /\+--\+--\+/);
			await ui.evaluate("document.querySelectorAll('.omp-ask-option')[1].dispatchEvent(new MouseEvent('mouseover',{bubbles:true}));document.querySelectorAll('.omp-ask-option')[1].focus()");
			await ui.wait("document.querySelector('.omp-ask-preview')?.getAttribute('aria-label')==='Preview of List'");
			assert.equal((await preview())?.bold, true, "the preview is Markdown");
			await ui.evaluate("document.querySelectorAll('.omp-ask-option')[2].focus()");
			await ui.wait("document.querySelector('.omp-ask-preview') === null");
			assert.equal(await ui.evaluate("document.querySelector('.omp-ask-timer')"), null, "no timeout, no countdown");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("an ask with a timeout counts down to OMP's own answer, never past its timeout", async () => {
			await open("ask-timer");
			const now = Date.now();
			const request = (expiresAt: number) => JSON.stringify({ id: "ask-t", method: "ask", title: "Hurry?", timeoutMs: 90_000, expiresAt, questions: [{ id: "q", question: "Hurry?", multi: false, options: [{ label: "Yes" }] }] });
			await ui.evaluate(`window.ui.push({uiRequests:[${request(now + 59_500)}],working:true,settled:false})`);
			await ui.wait("document.querySelector('.omp-ask-timer')");
			const text = () => ui.evaluate<string>("document.querySelector('.omp-ask-timer').textContent.trim()");
			assert.match(await text(), /^Answers itself in (5\d s|1 min 00 s)$/);
			assert.equal(await ui.evaluate("document.querySelector('.omp-ask-timer').getAttribute('role')"), "timer");
			await ui.evaluate(`window.ui.push({uiRequests:[${request(now + 24 * 3_600_000)}]})`);
			await ui.wait("document.querySelector('.omp-ask-timer')?.textContent.trim()==='Answers itself in 1 min 30 s'");
		});
	} finally {
		page?.socket.close(); browser?.socket.close();
		child.kill();
		await once(child, "exit").catch(() => undefined);
		server.close();
		await rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
});
